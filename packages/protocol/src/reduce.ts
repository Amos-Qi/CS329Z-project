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

export type RunStatus = "idle" | "running" | "paused" | "completed" | "aborted" | "error";

/** Key in RunState.actionsByAttempt for actions taken while no module was active. */
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
	narration: { seq: number; t: number; attemptId: string | null; text: string }[];
	checkpoints: Checkpoint[];
	pendingBoundary?: { boundaryId: string; boundary: BoundaryKind; moduleId?: ModuleId };
	interventions: Intervention[];
	/** Declared (from module definitions) and recorded (from file accesses) dependencies. */
	dependencies: Dependency[];
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
		status: "idle",
		lastSeq: -1,
	};
}

export function reduceTrace(events: readonly TraceEvent[]): RunState {
	const state = emptyRunState();
	for (const event of events) applyEvent(state, event);
	// TODO: derive each module's status from its attempts and the pending boundary,
	// and derive state.dependencies (declared from latest versions; recorded from file accesses).
	return state;
}

function applyEvent(state: RunState, event: TraceEvent): void {
	state.lastSeq = event.seq;
	switch (event.type) {
		case "run_started":
			state.run = event.run;
			state.prompt = event.prompt;
			state.status = "running";
			state.startedAt = event.t;
			break;
		case "run_ended":
			state.status = event.status;
			state.error = event.error;
			state.endedAt = event.t;
			break;
		// TODO: plan_version, module_version, attempt_started, attempt_ended, attempts_invalidated,
		// action_started, action_ended, assistant_text, checkpoint, boundary_paused, boundary_resumed,
		// intervention, audit. See docs/design.md §4.
		default:
			break;
	}
}
