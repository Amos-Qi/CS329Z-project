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
	/** Arms (or disarms) a one-shot pause: the agent waits at the next module boundary. */
	| { type: "set_pause_at_boundary"; runId: string; value: boolean }
	| { type: "resume"; runId: string; boundaryId: string; edits?: ModuleEdit[]; note?: string }
	/** Edit modules while the agent runs. Edits to the active module are also sent as a steering message. */
	| { type: "edit"; runId: string; edits: ModuleEdit[]; note?: string }
	| { type: "revise"; runId: string; attemptId: string; edits: ModuleEdit[]; note?: string }
	/** Note to the agent, or a correction for the running module (moduleId). Delivered with steer(). */
	| { type: "note"; runId: string; text: string; moduleId?: ModuleId }
	| { type: "stop"; runId: string };

export interface RunControlState {
	runId: string;
	live: boolean;
	pauseAtBoundary: boolean;
	/** The run will hold after its first plan (StartRunRequest.pauseAfterPlan), until that plan or a disarm. */
	pauseAfterPlan?: boolean;
	pending?: PendingBoundary;
	/** A redo is being set up (the agent is stopped, the workspace and conversation are being rewound). */
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
	/** The scripted demo agent (no API key) can run this task. */
	scripted: boolean;
}

/** GET /api/info */
export interface ServerInfo {
	/** provider/model the "model" agent uses. */
	model: string;
	hasApiKey: boolean;
	/** Default for StartRunRequest.pauseAfterPlan. */
	pauseAfterPlan: boolean;
}

/** Which agent drives a new run: the configured model, or the scripted demo agent. */
export type AgentKind = "model" | "scripted";

export interface StartRunRequest {
	taskId: string;
	variant?: string;
	agent?: AgentKind;
	/** Wait for the overseer after the first plan. */
	pauseAfterPlan?: boolean;
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
