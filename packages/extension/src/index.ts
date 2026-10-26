/**
 * The modules extension: makes one pi agent's work visible and controllable as modules.
 *
 * - plan_modules / start_module / finish_module tools (the agent announces structure)
 * - tool_call / tool_result / message_end hooks (every action is attributed to the active module)
 * - boundary gates in the module tools (the host can pause, edit, revise or stop)
 *
 * See docs/design.md §3–§7. Everything marked TODO is project work.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ModulesExtensionOptions, ModulesHost } from "./host.ts";
import { MODULE_PROTOCOL } from "./prompt.ts";

export type {
	BoundaryDecision,
	BoundaryRequest,
	CheckpointRequest,
	ModulesExtensionOptions,
	ModulesHost,
} from "./host.ts";
export { MODULE_PROTOCOL } from "./prompt.ts";

export const MODULE_TOOLS = new Set(["plan_modules", "start_module", "finish_module"]);

const ModuleInput = Type.Object({
	id: Type.Optional(
		Type.String({ description: "Existing module id (e.g. M2) to keep or revise. Omit for a new module." }),
	),
	title: Type.String({ description: "Short name of the subgoal." }),
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
	modules: Type.Array(ModuleInput, { minItems: 1, description: "All modules, in intended execution order." }),
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

export interface ModulesExtension {
	factory: ExtensionFactory;
}

export function createModulesExtension(host: ModulesHost, _options: ModulesExtensionOptions = {}): ModulesExtension {
	// TODO: a module store (plan versions, module versions, attempts, active attempt) that emits every
	// change through host.emit() as a TraceEvent, so the trace can be replayed with reduceTrace().

	const factory: ExtensionFactory = (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => {
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
			async execute(_toolCallId, params) {
				// TODO: assign stable ids, create module/plan versions, emit plan_version,
				// checkpoint, then await host.boundary({ boundary: "after_plan", ... }).
				return { content: text(`Plan recorded with ${params.modules.length} module(s).`), details: undefined };
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
			async execute(_toolCallId, params) {
				// TODO: reject unknown ids or a second active module; await the before_start boundary;
				// apply user edits; record the session entry to rewind to; checkpoint; emit attempt_started;
				// return the module's latest definition.
				return { content: text(`Started ${params.id}.`), details: undefined };
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
			async execute(_toolCallId, params) {
				// TODO: checkpoint, diff against the attempt's start checkpoint, emit attempt_ended,
				// then await the after_finish boundary.
				return { content: text(`Finished ${params.id} as ${params.status}.`), details: undefined };
			},
		});

		pi.on("tool_call", (event) => {
			if (MODULE_TOOLS.has(event.toolName) || event.parentToolCallId) return;
			// TODO: emit action_started, tagged with the active attempt (or unassigned).
		});

		pi.on("tool_result", (event) => {
			if (MODULE_TOOLS.has(event.toolName) || event.parentToolCallId) return;
			// TODO: emit action_ended with a result preview, file changes (edit: event.details.patch)
			// and parsed test runs; apply host.rewriteToolResult for seeded failures; remind the agent
			// when it acts with no active module.
		});

		pi.on("message_end", (_event) => {
			// TODO: emit assistant_text for assistant messages, tagged with the active attempt.
		});

		void host;
	};

	return { factory };
}
