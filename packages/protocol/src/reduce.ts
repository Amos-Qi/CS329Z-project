/**
 * reduceTrace(): the one function both UI conditions use to turn a trace into state.
 * Keeping a single reducer is part of the equivalence contract (docs/design.md §6.3):
 * the views may only differ in how they organize this state, not in what it contains.
 */

import type { AuditReport, RunInfo, TraceEvent } from "./events.ts";
import type {
	Action,
	Attempt,
	BoundaryKind,
	Checkpoint,
	Dependency,
	Intervention,
	ModuleId,
	ModuleVersion,
	PlanVersion,
} from "./model.ts";

export type ModuleStatus = "pending" | "active" | "paused" | "completed" | "failed" | "invalidated" | "dropped";

export interface ModuleState {
	id: ModuleId;
	versions: ModuleVersion[];
	latest: ModuleVersion;
	attemptIds: string[];
	inPlan: boolean;
	status: ModuleStatus;
}

export interface Narration {
	seq: number;
	t: number;
	attemptId: string | null;
	text: string;
}

export type RunStatus = "idle" | "running" | "paused" | "completed" | "aborted" | "error";

export const UNASSIGNED = "unassigned";

export interface RunState {
	run?: RunInfo;
	prompt?: string;
	plans: PlanVersion[];
	modules: Record<ModuleId, ModuleState>;
	/** Current plan order, followed by dropped modules. */
	moduleOrder: ModuleId[];
	attempts: Record<string, Attempt>;
	attemptOrder: string[];
	actions: Record<string, Action>;
	actionOrder: string[];
	/** Action ids per attempt id; unassigned actions are under UNASSIGNED. */
	actionsByAttempt: Record<string, string[]>;
	activeAttemptId: string | null;
	narration: Narration[];
	checkpoints: Checkpoint[];
	/** The boundary the agent is held at; `since` is when it started waiting. */
	pendingBoundary?: { boundaryId: string; boundary: BoundaryKind; moduleId?: ModuleId; since: number };
	interventions: Intervention[];
	dependencies: Dependency[];
	/** Trace position of each action's start, attempt start/end and the first plan (for ordering). */
	actionSeq: Record<string, number>;
	attemptSeq: Record<string, { start: number; end?: number }>;
	firstPlanSeq?: number;
	/** Trace position of the latest attempt start or end, plan version or redo (what the Now bar's action is "since"). */
	boundarySeq?: number;
	/** Trace spans a redo discarded: from the start of the first replaced attempt to the invalidation. */
	discarded: { from: number; to: number }[];
	audit?: AuditReport;
	status: RunStatus;
	error?: string;
	lastSeq: number;
	startedAt?: number;
	endedAt?: number;
}

export function emptyRunState(): RunState {
	return {
		plans: [],
		modules: {},
		moduleOrder: [],
		attempts: {},
		attemptOrder: [],
		actions: {},
		actionOrder: [],
		actionsByAttempt: { [UNASSIGNED]: [] },
		activeAttemptId: null,
		narration: [],
		checkpoints: [],
		interventions: [],
		dependencies: [],
		actionSeq: {},
		attemptSeq: {},
		discarded: [],
		status: "idle",
		lastSeq: -1,
	};
}

export function reduceTrace(events: readonly TraceEvent[]): RunState {
	const state = emptyRunState();
	const tracker = new FileDependencyTracker();
	for (const event of events) applyEvent(state, event, tracker);
	finalize(state, tracker);
	return state;
}

function addModuleVersion(state: RunState, version: ModuleVersion): void {
	const existing = state.modules[version.moduleId];
	if (existing) {
		existing.versions.push(version);
		existing.latest = version;
	} else {
		state.modules[version.moduleId] = {
			id: version.moduleId,
			versions: [version],
			latest: version,
			attemptIds: [],
			inPlan: false,
			status: "pending",
		};
	}
}

function applyEvent(state: RunState, event: TraceEvent, tracker: FileDependencyTracker): void {
	state.lastSeq = event.seq;
	switch (event.type) {
		case "run_started":
			state.run = event.run;
			state.prompt = event.prompt;
			state.status = "running";
			state.startedAt = event.t;
			break;
		case "plan_version": {
			state.firstPlanSeq ??= event.seq;
			state.boundarySeq = event.seq;
			state.plans.push(event.plan);
			for (const version of event.modules) addModuleVersion(state, version);
			const inPlan = new Set(event.plan.moduleOrder);
			for (const module of Object.values(state.modules)) module.inPlan = inPlan.has(module.id);
			const dropped = state.moduleOrder.filter((id) => !inPlan.has(id));
			state.moduleOrder = [...event.plan.moduleOrder, ...dropped];
			break;
		}
		case "module_version":
			addModuleVersion(state, event.module);
			break;
		case "attempt_started": {
			const attempt = { ...event.attempt };
			state.attempts[attempt.attemptId] = attempt;
			state.attemptOrder.push(attempt.attemptId);
			state.attemptSeq[attempt.attemptId] = { start: event.seq };
			state.boundarySeq = event.seq;
			state.actionsByAttempt[attempt.attemptId] = [];
			state.modules[attempt.moduleId]?.attemptIds.push(attempt.attemptId);
			state.activeAttemptId = attempt.attemptId;
			break;
		}
		case "attempt_ended": {
			const attempt = state.attempts[event.attemptId];
			if (!attempt) break;
			attempt.status = event.status;
			attempt.endedAt = event.t;
			attempt.summary = event.summary;
			attempt.outputs = event.outputs;
			attempt.validation = event.validation;
			attempt.endCheckpoint = event.endCheckpoint;
			attempt.fileChanges = event.fileChanges;
			const seqs = state.attemptSeq[event.attemptId];
			if (seqs) seqs.end = event.seq;
			state.boundarySeq = event.seq;
			if (state.activeAttemptId === event.attemptId) state.activeAttemptId = null;
			break;
		}
		case "attempts_invalidated": {
			const starts: number[] = [];
			for (const id of event.attemptIds) {
				const attempt = state.attempts[id];
				if (!attempt) continue;
				attempt.status = "invalidated";
				attempt.statusReason = event.reason;
				// an attempt replaced while it ran never gets attempt_ended: it ended here
				attempt.endedAt ??= event.t;
				if (state.activeAttemptId === id) state.activeAttemptId = null;
				const start = state.attemptSeq[id]?.start;
				if (start !== undefined) starts.push(start);
			}
			if (starts.length) state.discarded.push({ from: Math.min(...starts), to: event.seq });
			state.boundarySeq = event.seq;
			tracker.onInvalidate(event.attemptIds);
			break;
		}
		case "action_started": {
			const action = { ...event.action };
			state.actions[action.actionId] = action;
			state.actionOrder.push(action.actionId);
			state.actionSeq[action.actionId] = event.seq;
			const key = action.attemptId ?? UNASSIGNED;
			state.actionsByAttempt[key] = [...(state.actionsByAttempt[key] ?? []), action.actionId];
			tracker.onAccess(state, action);
			break;
		}
		case "action_ended": {
			const action = state.actions[event.actionId];
			if (!action) break;
			action.endedAt = event.t;
			action.isError = event.isError;
			action.resultPreview = event.resultPreview;
			action.fileChanges = event.fileChanges;
			action.test = event.test;
			// a command that looked like a test run but printed no test summary was not one
			if (action.isTest && !event.test) action.isTest = false;
			if (!event.isError) tracker.onWrite(state, action);
			break;
		}
		case "assistant_text":
			state.narration.push({ seq: event.seq, t: event.t, attemptId: event.attemptId, text: event.text });
			break;
		case "checkpoint":
			state.checkpoints.push(event.checkpoint);
			break;
		case "boundary_paused":
			state.pendingBoundary = {
				boundaryId: event.boundaryId,
				boundary: event.boundary,
				moduleId: event.moduleId,
				since: event.t,
			};
			state.status = "paused";
			break;
		case "boundary_resumed":
			if (state.pendingBoundary?.boundaryId === event.boundaryId) state.pendingBoundary = undefined;
			if (state.status === "paused") state.status = "running";
			break;
		case "intervention":
			state.interventions.push({ ...event.intervention });
			if (event.intervention.kind === "revise") state.status = "running";
			break;
		case "intervention_delivered": {
			const intervention = state.interventions.find((i) => i.interventionId === event.interventionId);
			if (intervention) intervention.deliveredAt = event.t;
			break;
		}
		case "audit":
			state.audit = event.report;
			break;
		case "run_ended":
			state.status = event.status;
			state.error = event.error;
			state.endedAt = event.t;
			state.pendingBoundary = undefined;
			break;
	}
}

function finalize(state: RunState, tracker: FileDependencyTracker): void {
	const deps = new Map<string, Dependency>();
	for (const module of Object.values(state.modules)) {
		for (const from of module.latest.dependsOn) {
			if (!state.modules[from]) continue;
			deps.set(`declared:${from}->${module.id}`, { from, to: module.id, kind: "declared" });
		}
	}
	for (const dep of tracker.recorded.values()) {
		if (!deps.has(`declared:${dep.from}->${dep.to}`)) deps.set(`recorded:${dep.from}->${dep.to}`, dep);
	}
	state.dependencies = [...deps.values()];

	for (const module of Object.values(state.modules)) module.status = moduleStatus(state, module);
}

function moduleStatus(state: RunState, module: ModuleState): ModuleStatus {
	const attempts = module.attemptIds.map((id) => state.attempts[id]).filter((a): a is Attempt => !!a);
	const live = attempts.filter((a) => a.status !== "invalidated" && a.status !== "abandoned");
	const last = live.at(-1);
	if (last?.status === "running") {
		return state.pendingBoundary && state.pendingBoundary.moduleId === module.id ? "paused" : "active";
	}
	if (state.pendingBoundary?.boundary === "before_start" && state.pendingBoundary.moduleId === module.id) {
		return "paused";
	}
	if (!module.inPlan) return "dropped";
	if (last?.status === "completed") return "completed";
	if (last?.status === "failed") return "failed";
	if (attempts.length > 0) return "invalidated";
	return "pending";
}

/** Derives "recorded" dependencies: module B touched a file last written by module A. */
class FileDependencyTracker {
	readonly recorded = new Map<string, Dependency>();
	private lastWriter = new Map<string, { moduleId: ModuleId; attemptId: string }>();

	onAccess(state: RunState, action: Action): void {
		const reader = moduleOf(state, action);
		const path = actionPath(state, action);
		if (!reader || !path) return;
		const writer = this.lastWriter.get(path)?.moduleId;
		if (writer && writer !== reader) {
			this.recorded.set(`${writer}->${reader}`, { from: writer, to: reader, kind: "recorded", label: path });
		}
	}

	onWrite(state: RunState, action: Action): void {
		const writer = moduleOf(state, action);
		if (!writer || !action.attemptId) return;
		for (const change of action.fileChanges ?? []) {
			this.lastWriter.set(normalizePath(state, change.path), { moduleId: writer, attemptId: action.attemptId });
		}
	}

	/** A redo restored the workspace: what replaced attempts wrote is gone. */
	onInvalidate(attemptIds: string[]): void {
		const gone = new Set(attemptIds);
		for (const [path, writer] of this.lastWriter) if (gone.has(writer.attemptId)) this.lastWriter.delete(path);
	}
}

function moduleOf(state: RunState, action: Action): ModuleId | undefined {
	return action.attemptId ? state.attempts[action.attemptId]?.moduleId : undefined;
}

function actionPath(state: RunState, action: Action): string | undefined {
	const path = action.args.path ?? action.args.file_path;
	return typeof path === "string" ? normalizePath(state, path) : undefined;
}

export function normalizePath(state: Pick<RunState, "run">, path: string): string {
	let p = path;
	const ws = state.run?.workspace;
	if (ws && p.startsWith(`${ws}/`)) p = p.slice(ws.length + 1);
	if (p.startsWith("./")) p = p.slice(2);
	return p;
}
