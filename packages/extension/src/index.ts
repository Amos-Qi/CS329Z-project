/**
 * The modules extension: makes one pi agent's work visible and controllable as modules.
 *
 * - plan_modules / start_module / finish_module tools (the agent announces structure)
 * - tool_call / tool_result / message_end hooks (every action is attributed to the active module)
 * - boundary gates in the module tools (the host can pause, edit, revise or stop)
 *
 * See docs/design.md §3–§7.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	type BoundaryKind,
	isTestCommand,
	type ModuleVersion,
	type ValidationResult,
	writesFiles,
} from "@vcm/protocol";
import { Type } from "typebox";
import { captureArgs, contentText, fileChangesFor, parseTestRun, preview, stripAnsi } from "./capture.ts";
import type { BoundaryDecision, ModulesExtensionOptions, ModulesHost } from "./host.ts";
import { MODULE_PROTOCOL } from "./prompt.ts";
import { formatModule, ModuleStore } from "./store.ts";

export { captureArgs, contentText, preview, stripAnsi } from "./capture.ts";
export type {
	BoundaryDecision,
	BoundaryRequest,
	CheckpointRequest,
	ModulesExtensionOptions,
	ModulesHost,
} from "./host.ts";
export { MODULE_PROTOCOL } from "./prompt.ts";
export { formatModule, ModuleStore, type PlannedModuleInput } from "./store.ts";

export const MODULE_TOOLS = new Set(["plan_modules", "start_module", "finish_module"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

const UNASSIGNED_REMINDER =
	"[modules] Note: no module is active, so this action is recorded as unassigned. Call start_module before working on a module.";
const UNPLANNED_REMINDER =
	"[modules] Note: there is no module plan yet, so this change is recorded outside any module. Call plan_modules, then start_module, before changing files.";
const COMMAND_REMINDER =
	"[modules] Note: change files with the edit and write tools, not with shell commands, so the overseer can review the diff.";
const GATE_REASON =
	"[modules] Blocked: no module is active. Call plan_modules (if you have no plan yet) and start_module first; then retry this change.";
const PAUSED_TEXT =
	"[modules] The overseer stopped the run at this boundary. Do not call any more tools; wait for further instructions.";
const HALTED_REASON =
	"[modules] Not run: the overseer stopped the run at a module boundary earlier in this step. Wait for further instructions.";

const ModuleInput = Type.Object({
	id: Type.Optional(
		Type.String({ description: "Existing module id (e.g. M2) to keep or revise. Omit for a new module." }),
	),
	title: Type.String({ description: "Short name of the subgoal." }),
	label: Type.Optional(
		Type.String({ description: "One or two words for the plan overview, e.g. 'Rounding'. Defaults to the title." }),
	),
	purpose: Type.String({ description: "Why this module exists and what it contributes to the task." }),
	instructions: Type.String({ description: "Concrete steps you intend to follow." }),
	inputs: Type.Optional(Type.Array(Type.String(), { description: "Files, facts or artifacts this module needs." })),
	outputs: Type.Optional(Type.Array(Type.String(), { description: "Files or artifacts this module produces." })),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Ids (or titles) of prerequisite modules." })),
	validation: Type.Optional(Type.Array(Type.String(), { description: "How you will know the module is done." })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Names of skills this module uses, if any." })),
});

const PlanParams = Type.Object({
	rationale: Type.String({ description: "Why the work is split this way, or what changed since the last plan." }),
	modules: Type.Array(ModuleInput, {
		minItems: 2,
		maxItems: 7,
		description: "All modules (2-7), in intended execution order.",
	}),
});

const StartParams = Type.Object({ id: Type.String({ description: "Module id from the current plan." }) });

const FinishParams = Type.Object({
	id: Type.String({ description: "The active module's id." }),
	status: StringEnum(["completed", "failed"] as const),
	summary: Type.String({ description: "What was done, in two or three sentences." }),
	outputs: Type.Optional(Type.Array(Type.String())),
	validation: Type.Optional(
		Type.Array(
			Type.Object({
				criterion: Type.String(),
				met: Type.Boolean(),
				evidence: Type.Optional(Type.String({ description: "E.g. the test command and its result." })),
			}),
		),
	),
});

function text(value: string) {
	return [{ type: "text" as const, text: value }];
}

function describeEdits(versions: ModuleVersion[], note: string | undefined): string {
	const parts = versions.map(
		(v) => `The overseer edited ${v.moduleId} (now instructions v${v.version}):\n${formatModule(v)}`,
	);
	if (note) parts.push(`Overseer note: ${note}`);
	return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

/** The session entry just before the assistant message that issued `toolCallId` (rewind target). */
function entryBeforeToolCall(ctx: ExtensionContext, toolCallId: string): string | null | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		if (
			message.content.some(
				(block: { type?: string; id?: string }) => block.type === "toolCall" && block.id === toolCallId,
			)
		) {
			return entry.parentId;
		}
	}
	return undefined;
}

export interface ModulesExtension {
	factory: ExtensionFactory;
	store: ModuleStore;
}

export function createModulesExtension(host: ModulesHost, options: ModulesExtensionOptions = {}): ModulesExtension {
	const store = new ModuleStore((event) => host.emit(event));
	const testPattern = options.testCommandPattern;
	const isTest = (command: unknown): command is string =>
		typeof command === "string" && isTestCommand(command, testPattern);
	const remind = options.remindUnassigned ?? true;
	const gateEdits = options.gateEdits ?? false;
	let boundaryCounter = 0;
	// pi ends a run after a tool batch only if every call in it terminates, and keeps going for queued
	// messages, so a boundary that stops the run aborts it (as the server does) and blocks whatever is
	// left of the batch; cleared when the next run starts
	let halted = false;

	function halt(ctx: ExtensionContext) {
		halted = true;
		ctx.abort();
		return { content: text(PAUSED_TEXT), details: undefined, terminate: true };
	}

	async function gate(
		boundary: BoundaryKind,
		moduleId: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<BoundaryDecision> {
		const boundaryId = `b${++boundaryCounter}`;
		return host.boundary({ boundaryId, boundary, moduleId, attemptId: store.activeAttemptId ?? undefined }, signal);
	}

	async function checkpoint(boundary: BoundaryKind, attemptId: string | undefined, sessionEntryId?: string | null) {
		const cp = await host.checkpoint?.({ boundary, attemptId, sessionEntryId, planVersion: store.planVersion });
		if (cp) host.emit({ type: "checkpoint", checkpoint: cp });
		return cp;
	}

	const factory: ExtensionFactory = (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => {
			halted = false;
			event.systemPromptOptions.sections.module_protocol = MODULE_PROTOCOL;
		});

		pi.registerTool({
			name: "plan_modules",
			label: "Plan modules",
			description:
				"Declare or revise your module plan: the ordered list of task-specific subgoals you will work through. Call it after brief orientation and again whenever the plan changes.",
			promptSnippet: "plan_modules: declare or revise the ordered list of modules (subgoals)",
			parameters: PlanParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const plan = store.plan(params.modules, params.rationale, "agent");
				await checkpoint("after_plan", undefined);
				const decision = await gate("after_plan", undefined, signal);
				if (decision.action !== "continue") return halt(ctx);
				const edited = store.applyEdits(decision.edits ?? []);
				const listing = plan.moduleOrder
					.map((id) => {
						const m = store.latest(id);
						return m
							? `- ${id}: ${m.title}${m.dependsOn.length ? ` (after ${m.dependsOn.join(", ")})` : ""}`
							: `- ${id}`;
					})
					.join("\n");
				return {
					content: text(
						`Plan v${plan.version} recorded:\n${listing}\n\nNext: call start_module with the first module's id.${describeEdits(edited, decision.note)}`,
					),
					details: { planVersion: plan.version, moduleOrder: plan.moduleOrder },
				};
			},
		});

		pi.registerTool({
			name: "start_module",
			label: "Start module",
			description:
				"Start working on one module from the current plan. Returns the module's authoritative definition, which may include edits from the overseer. Only one module can be active.",
			promptSnippet: "start_module: begin one planned module; returns its authoritative instructions",
			parameters: StartParams,
			executionMode: "sequential",
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				if (!store.hasModule(params.id)) {
					throw new Error(
						`Unknown module "${params.id}". Known modules: ${store.currentPlan?.moduleOrder.join(", ") ?? "none (call plan_modules first)"}.`,
					);
				}
				const active = store.activeAttempt;
				if (active) {
					throw new Error(
						`Module ${active.moduleId} is still active. Call finish_module for it before starting ${params.id}.`,
					);
				}
				const decision = await gate("before_start", params.id, signal);
				if (decision.action !== "continue") return halt(ctx);
				store.applyEdits(decision.edits ?? []);

				const startEntryId = entryBeforeToolCall(ctx, toolCallId);
				const cp = await host.checkpoint?.({
					boundary: "before_start",
					sessionEntryId: startEntryId,
					planVersion: store.planVersion,
				});
				const attempt = store.startAttempt(params.id, startEntryId, cp?.commit);
				if (cp) host.emit({ type: "checkpoint", checkpoint: { ...cp, attemptId: attempt.attemptId } });

				const version = store.latest(params.id) as ModuleVersion;
				const note = decision.note ? `\n\nOverseer note: ${decision.note}` : "";
				return {
					content: text(
						`Started ${attempt.attemptId} (attempt ${attempt.n}).\n\n${formatModule(version)}${note}\n\nWhen done, call finish_module with id "${params.id}".`,
					),
					details: { attemptId: attempt.attemptId, moduleVersion: version.version },
				};
			},
		});

		pi.registerTool({
			name: "finish_module",
			label: "Finish module",
			description:
				"Finish the active module with an honest status, a summary, its outputs and one validation result per criterion.",
			promptSnippet: "finish_module: end the active module with status, summary and validation results",
			parameters: FinishParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const attempt = store.activeAttempt;
				if (!attempt) throw new Error("No module is active. Call start_module first.");
				if (attempt.moduleId !== params.id) {
					throw new Error(`The active module is ${attempt.moduleId}, not ${params.id}.`);
				}
				const cp = await checkpoint("after_finish", attempt.attemptId);
				const diffed =
					cp && attempt.startCheckpoint && host.diffCheckpoints
						? await host.diffCheckpoints(attempt.startCheckpoint, cp.commit)
						: undefined;
				const validation: ValidationResult[] | undefined = params.validation?.map((v) => ({
					criterion: v.criterion,
					met: v.met,
					evidence: v.evidence,
				}));
				store.endAttempt(attempt.attemptId, {
					status: params.status,
					summary: params.summary,
					outputs: params.outputs,
					validation,
					endCheckpoint: cp?.commit,
					fileChanges: diffed,
				});

				const decision = await gate("after_finish", params.id, signal);
				if (decision.action !== "continue") return halt(ctx);
				const edited = store.applyEdits(decision.edits ?? []);
				const next = store.nextUnfinishedModule();
				const hint = next ? ` Next in the plan: ${next}.` : " All planned modules are finished.";
				return {
					content: text(
						`Finished ${attempt.attemptId} as ${params.status}.${hint}${describeEdits(edited, decision.note)}`,
					),
					details: { attemptId: attempt.attemptId, status: params.status },
				};
			},
		});

		pi.on("tool_call", (event) => {
			if (halted) return { block: true, reason: HALTED_REASON, terminate: true };
			if (MODULE_TOOLS.has(event.toolName) || event.parentToolCallId) return;
			const input = event.input as Record<string, unknown>;
			if (gateEdits && !store.activeAttemptId && EDIT_TOOLS.has(event.toolName)) {
				return { block: true, reason: GATE_REASON };
			}
			host.emit({
				type: "action_started",
				action: {
					actionId: event.toolCallId,
					attemptId: store.activeAttemptId,
					tool: event.toolName,
					args: captureArgs(input),
					startedAt: Date.now(),
					isTest: event.toolName === "bash" && isTest(input.command),
				},
			});
		});

		pi.on("tool_result", (event) => {
			if (MODULE_TOOLS.has(event.toolName) || event.parentToolCallId) return;
			let content = event.content;
			let changed = false;
			const original = contentText(content);
			const rewritten = host.rewriteToolResult?.(event.toolName, event.input, original);
			if (rewritten !== undefined) {
				content = text(rewritten);
				changed = true;
			}
			const seen = stripAnsi(rewritten ?? original);
			const command = typeof event.input.command === "string" ? event.input.command : undefined;
			host.emit({
				type: "action_ended",
				actionId: event.toolCallId,
				isError: event.isError,
				resultPreview: preview(seen),
				fileChanges: fileChangesFor(event.toolName, event.input, event.details),
				test: event.toolName === "bash" && isTest(command) ? parseTestRun(command, seen, event.isError) : undefined,
			});
			const writes = EDIT_TOOLS.has(event.toolName) || (!!command && writesFiles(command));
			if (remind && writes) {
				const reminder = !store.activeAttemptId
					? store.planVersion > 0
						? UNASSIGNED_REMINDER
						: UNPLANNED_REMINDER
					: event.toolName === "bash"
						? COMMAND_REMINDER
						: undefined;
				if (reminder) {
					content = [...content, ...text(reminder)];
					changed = true;
				}
			}
			return changed ? { content } : undefined;
		});

		pi.on("message_end", (event) => {
			const message = event.message as { role?: string; content?: unknown };
			if (message.role !== "assistant" || !Array.isArray(message.content)) return;
			const said = contentText(message.content).trim();
			if (said) host.emit({ type: "assistant_text", attemptId: store.activeAttemptId, text: said });
		});
	};

	return { factory, store };
}
