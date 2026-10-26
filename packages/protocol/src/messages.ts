/** WebSocket / HTTP messages between the web UI and the server. */

import type { TraceEvent } from "./events.ts";
import type { BoundaryKind, ModuleId, ModuleSpec } from "./model.ts";

/** A user's change to one module's definition. Unset fields keep their current value. */
export interface ModuleEdit {
	moduleId: ModuleId;
	changes: Partial<Pick<ModuleSpec, "instructions" | "validation" | "purpose">>;
	note?: string;
}

export interface PendingBoundary {
	boundaryId: string;
	boundary: BoundaryKind;
	moduleId?: ModuleId;
}

export type ClientMessage =
	| { type: "subscribe"; runId: string }
	| { type: "set_pause_at_boundary"; runId: string; value: boolean }
	| { type: "resume"; runId: string; boundaryId: string; edits?: ModuleEdit[]; note?: string }
	/** Edit modules while the agent runs. Edits to the active module are also sent as a steering message. */
	| { type: "edit"; runId: string; edits: ModuleEdit[]; note?: string }
	| { type: "revise"; runId: string; attemptId: string; edits: ModuleEdit[]; note?: string }
	| { type: "stop"; runId: string };

export interface RunControlState {
	runId: string;
	live: boolean;
	pauseAtBoundary: boolean;
	pending?: PendingBoundary;
	busy: boolean;
}

export type ServerMessage =
	| { type: "events"; runId: string; events: TraceEvent[] }
	| { type: "control"; state: RunControlState }
	| { type: "error"; message: string };

export interface TaskSummary {
	id: string;
	title: string;
	split: "pilot" | "eval" | "dev";
	variants: string[];
}

export interface RunSummary {
	runId: string;
	taskId: string;
	variant?: string;
	model: string;
	startedAt: number;
	live: boolean;
	status?: string;
}
