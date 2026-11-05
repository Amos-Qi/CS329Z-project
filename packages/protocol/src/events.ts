/**
 * The trace: an append-only list of TraceEvents. It is the single source of truth for both the
 * modular view and the log view, which both derive their state with reduceTrace().
 */

import type {
	Action,
	Attempt,
	AttemptStatus,
	BoundaryKind,
	Checkpoint,
	FileChange,
	Intervention,
	ModuleId,
	ModuleVersion,
	PlanVersion,
	TestRun,
	ValidationResult,
} from "./model.ts";

export interface RunInfo {
	runId: string;
	taskId: string;
	model: string;
	/** Seeded-failure variant id, if any. Hidden from participants in study mode. */
	variant?: string;
	workspace: string;
}

export interface AuditReport {
	/** Raw tool executions that have no trace action. */
	missingActions: string[];
	/** Files changed between checkpoints that no edit/write action accounts for. */
	/** `patch`: the change's diff, for changes outside any module (from the final diff; absent in older traces). */
	unattributedChanges: { attemptId: string | null; path: string; patch?: string }[];
	assignedActions: number;
	unassignedActions: number;
}

export type TraceEventBody =
	| { type: "run_started"; run: RunInfo; prompt: string }
	| { type: "plan_version"; plan: PlanVersion; modules: ModuleVersion[] }
	| { type: "module_version"; module: ModuleVersion }
	| { type: "attempt_started"; attempt: Attempt }
	| {
			type: "attempt_ended";
			attemptId: string;
			status: AttemptStatus;
			summary?: string;
			outputs?: string[];
			validation?: ValidationResult[];
			endCheckpoint?: string;
			fileChanges?: FileChange[];
	  }
	| { type: "attempts_invalidated"; attemptIds: string[]; reason: string }
	| { type: "action_started"; action: Action }
	| {
			type: "action_ended";
			actionId: string;
			isError: boolean;
			resultPreview?: string;
			fileChanges?: FileChange[];
			test?: TestRun;
	  }
	| { type: "assistant_text"; attemptId: string | null; text: string }
	| { type: "checkpoint"; checkpoint: Checkpoint }
	| { type: "boundary_paused"; boundaryId: string; boundary: BoundaryKind; moduleId?: ModuleId }
	| { type: "boundary_resumed"; boundaryId: string; decision: "continue" | "edit" | "revise" | "stop" }
	| { type: "intervention"; intervention: Intervention }
	/** A steered note or correction left pi's steering queue and reached the agent. */
	| { type: "intervention_delivered"; interventionId: string }
	| { type: "audit"; report: AuditReport }
	| { type: "run_ended"; status: "completed" | "aborted" | "error"; error?: string };

export type TraceEvent = TraceEventBody & {
	/** Position in the trace, starting at 0. */
	seq: number;
	/** Wall-clock milliseconds. */
	t: number;
};

export type TraceEventType = TraceEventBody["type"];
