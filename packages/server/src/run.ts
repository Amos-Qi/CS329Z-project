/**
 * One agent run on one task: workspace, pi session, modules extension, boundary gate,
 * checkpoints, trace, and the intervention controller (docs/design.md §7).
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	captureArgs,
	contentText,
	createModulesExtension,
	formatModule,
	MODULE_TOOLS,
	type ModuleStore,
	preview,
	stripAnsi,
} from "@vcm/extension";
import {
	type AuditReport,
	type ClientMessage,
	type InterventionKind,
	type ModuleEdit,
	normalizePath,
	type RunControlState,
	type RunSummary,
	reduceTrace,
} from "@vcm/protocol";
import { BoundaryGate } from "./boundary-gate.ts";
import { Checkpointer } from "./checkpointer.ts";
import type { SessionFactory } from "./session.ts";
import { makeRewriter, prepareWorkspace, type TaskSpec, type Variant } from "./tasks.ts";
import { TraceStore } from "./trace-store.ts";

export interface RunOptions {
	runId: string;
	runDir: string;
	task: TaskSpec;
	variant?: Variant;
	createSession: SessionFactory;
	pauseAfterPlan?: boolean;
	/** Block edit/write outside a module (the extension's light gate). */
	gateEdits?: boolean;
}

/** Raw session events worth archiving for the omission audit (streaming deltas are skipped). */
const RAW_EVENTS = new Set(["tool_execution_start", "tool_execution_end", "message_end", "agent_end", "agent_settled"]);

export class Run {
	readonly runId: string;
	readonly task: TaskSpec;
	readonly variant: Variant | undefined;
	readonly workspace: string;
	readonly trace: TraceStore;
	readonly gate: BoundaryGate;
	readonly checkpointer: Checkpointer;
	readonly store: ModuleStore;
	readonly startedAt = Date.now();
	model = "";
	private session!: AgentSession;
	private readonly runDir: string;
	private readonly rawFile: string;
	private readonly rawToolCalls = new Set<string>();
	private readonly controlListeners = new Set<(state: RunControlState) => void>();
	private baseline = "";
	private running: Promise<void> | undefined;
	private revising = false;
	private stopRequested = false;
	private interventions = 0;
	/** Steered notes and corrections not yet delivered to the agent: intervention id → steered text. */
	private readonly steered = new Map<string, string>();

	private constructor(options: RunOptions, extension: ReturnType<typeof createModulesExtension>, trace: TraceStore) {
		this.runId = options.runId;
		this.task = options.task;
		this.variant = options.variant;
		this.runDir = options.runDir;
		this.workspace = join(options.runDir, "workspace");
		this.rawFile = join(options.runDir, "raw.jsonl");
		this.trace = trace;
		this.store = extension.store;
		this.checkpointer = new Checkpointer(join(options.runDir, "snapshots.git"), this.workspace);
		this.gate = new BoundaryGate(
			(e) => this.trace.append(e),
			() => this.notifyControl(),
			options.pauseAfterPlan,
		);
	}

	static async create(options: RunOptions): Promise<Run> {
		mkdirSync(options.runDir, { recursive: true });
		const trace = new TraceStore(join(options.runDir, "trace.jsonl"));
		// The extension needs the host before the Run exists, so route its calls through a late-bound reference.
		let run: Run | undefined;
		const extension = createModulesExtension(
			{
				emit: (event) => trace.append(event),
				boundary: (request, signal) => (run as Run).gate.wait(request, signal),
				checkpoint: async (request) => {
					const commit = await (run as Run).checkpointer.snapshot(
						`${request.boundary}${request.attemptId ? `-${request.attemptId}` : ""}-${Date.now()}`,
					);
					return {
						checkpointId: commit.slice(0, 12),
						commit,
						boundary: request.boundary,
						attemptId: request.attemptId,
						sessionEntryId: request.sessionEntryId,
						planVersion: request.planVersion,
						createdAt: Date.now(),
					};
				},
				diffCheckpoints: (from, to) => (run as Run).checkpointer.diff(from, to),
				rewriteToolResult: makeRewriter(options.variant),
			},
			{ gateEdits: options.gateEdits },
		);
		run = new Run(options, extension, trace);

		await prepareWorkspace(options.task, options.variant, run.workspace);
		run.baseline = await run.checkpointer.init();
		const { session, model } = await options.createSession({
			taskId: options.task.id,
			variant: options.variant?.id,
			workspace: run.workspace,
			agentDir: join(options.runDir, ".pi-agent"),
			sessionDir: join(options.runDir, "session"),
			extension: extension.factory,
		});
		run.session = session;
		run.model = model;
		// Tool calls pi rejects before any extension hook (e.g. invalid arguments) never reach the extension;
		// record them from the raw events so the trace has every attempt the agent made.
		const traced = new Set<string>();
		const rawStarts = new Map<string, { args: Record<string, unknown>; attemptId: string | null; at: number }>();
		trace.subscribe((event) => {
			if (event.type === "action_started") traced.add(event.action.actionId);
		});
		session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") run.markDelivered(event.message.content);
			if (!RAW_EVENTS.has(event.type)) return;
			appendFileSync(run.rawFile, `${JSON.stringify({ t: Date.now(), ...event })}\n`);
			if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
			if (event.parentToolCallId || MODULE_TOOLS.has(event.toolName)) return;
			if (event.type === "tool_execution_start") {
				rawStarts.set(event.toolCallId, {
					args: event.args ?? {},
					attemptId: run.store.activeAttemptId,
					at: Date.now(),
				});
			}
			if (event.type === "tool_execution_end") {
				run.rawToolCalls.add(event.toolCallId);
				const start = rawStarts.get(event.toolCallId);
				rawStarts.delete(event.toolCallId);
				if (traced.has(event.toolCallId)) return;
				const content = event.result?.content;
				const text = stripAnsi(Array.isArray(content) ? contentText(content) : String(event.result ?? ""));
				trace.append({
					type: "action_started",
					action: {
						actionId: event.toolCallId,
						attemptId: start?.attemptId ?? run.store.activeAttemptId,
						tool: event.toolName,
						args: captureArgs(start?.args ?? {}),
						startedAt: start?.at ?? Date.now(),
						source: "host",
					},
				});
				trace.append({
					type: "action_ended",
					actionId: event.toolCallId,
					isError: event.isError,
					resultPreview: preview(text),
				});
			}
		});
		return run;
	}

	get prompt(): string {
		const base =
			this.variant?.kind === "prompt_override" && this.variant.prompt ? this.variant.prompt : this.task.prompt;
		return `${base.trim()}\n\nThe repository is in the current directory. Run the tests with \`${this.task.testCommand}\`.`;
	}

	start(): void {
		this.trace.append({
			type: "run_started",
			run: {
				runId: this.runId,
				taskId: this.task.id,
				model: this.model,
				variant: this.variant?.id,
				workspace: this.workspace,
			},
			prompt: this.prompt,
		});
		this.runPrompt(this.prompt);
	}

	/** Resolves when the current agent work (including any revision) has settled. */
	async settled(): Promise<void> {
		while (this.running) await this.running;
	}

	private runPrompt(text: string): void {
		const work = (async () => {
			let error: string | undefined;
			try {
				await this.session.prompt(text);
				// A failed model call (after pi's retries) ends the prompt normally with an error message.
				const last = this.session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string };
				if (last?.role === "assistant" && last.stopReason === "error") {
					error = `Model call failed: ${last.errorMessage ?? "unknown error"}`;
				}
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			if (this.revising) return;
			await this.endRun(error);
		})();
		this.running = work;
		this.notifyControl();
		void work.finally(() => {
			if (this.running === work) this.running = undefined;
			this.notifyControl();
		});
	}

	/** Audit, stats and run_ended. A Stop wins over the error an aborted model call reports. */
	private async endRun(error: string | undefined): Promise<void> {
		this.trace.append({ type: "audit", report: await this.audit() });
		this.writeStats();
		const stopped = this.stopRequested;
		this.trace.append({
			type: "run_ended",
			status: stopped ? "aborted" : error ? "error" : "completed",
			error: stopped ? undefined : error,
		});
		// an armed pause belongs to the run that ended: a later redo must not hold at its first boundary
		this.disarm();
	}

	private disarm(): void {
		this.gate.pauseAtBoundary = false;
		this.gate.pauseAfterPlan = false;
		this.notifyControl();
	}

	// ---- interventions -------------------------------------------------------------------------

	private intervention(
		kind: InterventionKind,
		fields: { moduleId?: string; attemptId?: string; note?: string } = {},
	): string {
		const interventionId = `i${++this.interventions}`;
		this.trace.append({ type: "intervention", intervention: { interventionId, kind, at: Date.now(), ...fields } });
		return interventionId;
	}

	/** A steered message reached the agent: pi appends it to the conversation as a user message. */
	private markDelivered(content: unknown): void {
		if (this.steered.size === 0) return;
		const text = typeof content === "string" ? content : JSON.stringify(content);
		for (const [interventionId, steered] of this.steered) {
			if (!text.includes(JSON.stringify(steered).slice(1, -1)) && !text.includes(steered)) continue;
			this.steered.delete(interventionId);
			this.trace.append({ type: "intervention_delivered", interventionId });
		}
	}

	/**
	 * A note to the agent, or a correction for the running module. Both are delivered with steer(),
	 * after the agent's current step (or when it continues from a boundary). docs/design.md §7.
	 */
	private async note(text: string, moduleId: string | undefined): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) throw new Error("The note is empty");
		if (!this.session.isStreaming) throw new Error("The agent is not running, so it cannot read a note now");
		if (moduleId && this.store.activeAttempt?.moduleId !== moduleId) {
			throw new Error(`${moduleId} is not running, so it cannot take a correction; change its instructions instead`);
		}
		const interventionId = this.intervention(moduleId ? "correct" : "note", { moduleId, note: trimmed });
		const steered = moduleId ? `[Overseer] Correction for ${moduleId}: ${trimmed}` : `[Overseer] Note: ${trimmed}`;
		this.steered.set(interventionId, steered);
		await this.session.steer(steered);
	}

	async handle(message: ClientMessage): Promise<void> {
		switch (message.type) {
			case "subscribe":
				return;
			case "set_pause_at_boundary":
				this.gate.pauseAtBoundary = message.value;
				// disarming also drops the automatic pause after the first plan (the panel shows it as armed)
				if (!message.value) this.gate.pauseAfterPlan = false;
				this.intervention(message.value ? "pause" : "resume");
				this.notifyControl();
				return;
			case "resume":
				for (const edit of message.edits ?? []) {
					if (this.store.changes(edit))
						this.intervention("edit_instructions", { moduleId: edit.moduleId, note: edit.note });
				}
				if (message.note) this.intervention("note", { note: message.note });
				this.gate.decide(message.boundaryId, { action: "continue", edits: message.edits, note: message.note });
				return;
			case "edit":
				return this.edit(message.edits, message.note);
			case "note":
				return this.note(message.text, message.moduleId);
			case "revise":
				return this.revise(message.attemptId, message.edits, message.note);
			case "stop":
				return this.stop();
		}
	}

	private edit(edits: ModuleEdit[], note: string | undefined): void {
		// an edit that changes nothing creates no version, so it is no intervention either
		const real = edits.filter((edit) => this.store.changes(edit));
		for (const edit of real) this.intervention("edit_instructions", { moduleId: edit.moduleId, note: edit.note });
		const created = this.store.applyEdits(real);
		const active = this.store.activeAttempt;
		const activeEdit = created.find((v) => v.moduleId === active?.moduleId);
		const parts: string[] = [];
		if (activeEdit) parts.push(`The overseer updated the active module's instructions:\n${formatModule(activeEdit)}`);
		if (note) parts.push(`Overseer note: ${note}`);
		if (parts.length && this.session.isStreaming) void this.session.steer(`[Overseer] ${parts.join("\n\n")}`);
	}

	async stop(): Promise<void> {
		// also seen by a redo that is still setting up: it then ends the run instead of prompting
		this.stopRequested = true;
		this.intervention("stop");
		this.gate.pauseAtBoundary = false;
		this.gate.pauseAfterPlan = false;
		const pending = this.gate.current;
		if (pending) this.gate.decide(pending.boundaryId, { action: "stop" });
		await this.session.abort();
		await this.settled();
		this.notifyControl();
	}

	/**
	 * Conservative revision: rewind the conversation and workspace to just before `attemptId`
	 * started, invalidate it and everything after it, apply the edits, and re-run from there.
	 */
	async revise(attemptId: string, edits: ModuleEdit[], note: string | undefined): Promise<void> {
		const attempt = this.store.attempt(attemptId);
		if (!attempt) throw new Error(`Unknown attempt ${attemptId}`);
		// a stale redo panel (another tab redid an earlier module) must not rewind to discarded work
		if (attempt.status === "invalidated") {
			throw new Error(`${attemptId} was already replaced by a redo; redo ${attempt.moduleId} from its current attempt`);
		}
		if (!attempt.startCheckpoint || !attempt.startEntryId) {
			throw new Error(`Attempt ${attemptId} has no checkpoint or session entry to rewind to`);
		}
		if (this.revising) throw new Error("A revision is already in progress");
		this.revising = true;
		// a Stop before this redo ended the earlier prompt; one pressed from here on cancels the redo
		this.stopRequested = false;
		this.notifyControl();
		try {
			this.intervention("revise", { moduleId: attempt.moduleId, attemptId, note });
			const pending = this.gate.current;
			if (pending) this.gate.decide(pending.boundaryId, { action: "revise" });
			if (this.session.isStreaming) await this.session.abort();
			await this.settled();

			const discarded = [attempt, ...this.store.attemptsAfter(attemptId)]
				.filter((a) => a.status !== "invalidated")
				.map((a) => a.attemptId);
			this.store.invalidate(discarded, `The overseer revised ${attempt.moduleId}`);
			const checkpoint = this.trace.events.find(
				(e) => e.type === "checkpoint" && e.checkpoint.commit === attempt.startCheckpoint,
			);
			if (checkpoint?.type === "checkpoint") {
				const reason = `Restored the plan from before ${attempt.moduleId}`;
				// rewinding past a re-plan: its order and the module definitions it changed go back too
				if (this.store.restorePlan(checkpoint.checkpoint.planVersion, reason)) {
					this.store.restoreVersions(checkpoint.checkpoint.createdAt, reason);
				}
			}
			const created = this.store.applyEdits(edits);
			await this.checkpointer.restore(attempt.startCheckpoint);
			const nav = await this.session.navigateTree(attempt.startEntryId, { summarize: false });

			const version = created.find((v) => v.moduleId === attempt.moduleId) ?? this.store.latest(attempt.moduleId);
			const message = [
				nav.editorText,
				`[Overseer] I revised module ${attempt.moduleId}${version ? ` (instructions v${version.version})` : ""}. ` +
					`The workspace has been restored to its state before ${attempt.moduleId}, and all later work was discarded.`,
				note ? `Note: ${note}` : undefined,
				`Call start_module("${attempt.moduleId}") and follow its instructions, then continue with the remaining modules.`,
			]
				.filter(Boolean)
				.join("\n\n");
			this.revising = false;
			// Stop pressed while the redo was set up: nothing is prompted, the run ends as stopped
			if (this.stopRequested) await this.endRun(undefined);
			else this.runPrompt(message);
		} finally {
			this.revising = false;
			this.notifyControl();
		}
	}

	// ---- audit & state --------------------------------------------------------------------------

	private async audit(): Promise<AuditReport> {
		const state = reduceTrace(this.trace.events);
		const traced = new Set(state.actionOrder);
		const attributedBy = new Map<string | null, Set<string>>();
		const allAttributed = new Set<string>();
		for (const id of state.actionOrder) {
			const action = state.actions[id];
			if (!action || action.isError) continue;
			for (const change of action.fileChanges ?? []) {
				const path = normalizePath(state, change.path);
				allAttributed.add(path);
				const set = attributedBy.get(action.attemptId) ?? new Set<string>();
				set.add(path);
				attributedBy.set(action.attemptId, set);
			}
		}
		const unattributedChanges: AuditReport["unattributedChanges"] = [];
		const seen = new Set<string>();
		for (const attemptId of state.attemptOrder) {
			const attempt = state.attempts[attemptId];
			if (!attempt || attempt.status === "invalidated") continue;
			for (const change of attempt.fileChanges ?? []) {
				seen.add(change.path);
				if (!attributedBy.get(attemptId)?.has(change.path)) unattributedChanges.push({ attemptId, path: change.path });
			}
		}
		const final = await this.checkpointer.snapshot(`final-${Date.now()}`);
		for (const change of await this.checkpointer.diff(this.baseline, final)) {
			if (!seen.has(change.path) && !allAttributed.has(change.path)) {
				unattributedChanges.push({ attemptId: null, path: change.path, patch: change.patch });
			}
		}
		return {
			missingActions: [...this.rawToolCalls].filter((id) => !traced.has(id)),
			unattributedChanges,
			assignedActions: state.actionOrder.length - (state.actionsByAttempt.unassigned?.length ?? 0),
			unassignedActions: state.actionsByAttempt.unassigned?.length ?? 0,
		};
	}

	private writeStats(): void {
		try {
			writeFileSync(join(this.runDir, "stats.json"), JSON.stringify(this.session.getSessionStats(), null, 2));
		} catch {
			// Stats are a convenience; never fail a run over them.
		}
	}

	controlState(): RunControlState {
		return {
			runId: this.runId,
			live: true,
			pauseAtBoundary: this.gate.pauseAtBoundary,
			pauseAfterPlan: this.gate.pauseAfterPlan,
			pending: this.gate.current,
			// a redo is being set up (abort, restore, rewind): another redo would be refused
			busy: this.revising,
		};
	}

	onControl(listener: (state: RunControlState) => void): () => void {
		this.controlListeners.add(listener);
		return () => this.controlListeners.delete(listener);
	}

	private notifyControl(): void {
		const state = this.controlState();
		for (const listener of this.controlListeners) listener(state);
	}

	summary(): RunSummary {
		return {
			runId: this.runId,
			taskId: this.task.id,
			variant: this.variant?.id,
			model: this.model,
			startedAt: this.startedAt,
			live: true,
			status: reduceTrace(this.trace.events).status,
		};
	}

	dispose(): void {
		this.session.dispose();
	}
}
