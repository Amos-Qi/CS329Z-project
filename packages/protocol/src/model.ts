/**
 * Module data model. See docs/design.md §4.
 *
 * Identity (Module.id) is stable; definitions are versioned (ModuleVersion); executions are
 * separate records (Attempt). The graph shows the latest plan; the timeline shows attempts.
 */

export type ModuleId = string;
export type Author = "agent" | "user";

/** The fields an agent (or user) writes when defining a module. */
export interface ModuleSpec {
	title: string;
	purpose: string;
	instructions: string;
	/** Optional pi skill names this module relies on. */
	skills: string[];
	inputs: string[];
	outputs: string[];
	/** Declared prerequisites. Recorded file dependencies are derived separately. */
	dependsOn: ModuleId[];
	/** Criteria the module's result is checked against. */
	validation: string[];
}

export interface ModuleVersion extends ModuleSpec {
	moduleId: ModuleId;
	version: number;
	author: Author;
	/** Why this version exists (re-plan rationale, user edit note). */
	reason?: string;
	createdAt: number;
}

export interface PlanVersion {
	version: number;
	/** Module ids in intended execution order. Modules absent here are dropped from the plan. */
	moduleOrder: ModuleId[];
	author: Author;
	rationale?: string;
	createdAt: number;
}

export type AttemptStatus = "running" | "completed" | "failed" | "invalidated" | "abandoned";

export interface ValidationResult {
	criterion: string;
	met: boolean | null;
	evidence?: string;
}

export interface Attempt {
	attemptId: string;
	moduleId: ModuleId;
	moduleVersion: number;
	/** 1-based attempt number for this module. */
	n: number;
	status: AttemptStatus;
	startedAt: number;
	endedAt?: number;
	/** pi session entry to rewind to in order to redo this attempt (parent of the start_module call). */
	startEntryId?: string | null;
	startCheckpoint?: string;
	endCheckpoint?: string;
	summary?: string;
	outputs?: string[];
	validation?: ValidationResult[];
	/** Files changed between this attempt's start and end checkpoints. */
	fileChanges?: FileChange[];
	/** Why it was invalidated/abandoned. */
	statusReason?: string;
}

export interface FileChange {
	path: string;
	/** edit/write: from that tool call. diff: from comparing two checkpoints (may include bash changes). */
	kind: "edit" | "write" | "diff";
	/** Unified diff when available. */
	patch?: string;
}

export interface TestRun {
	command: string;
	passed?: number;
	failed?: number;
	errors?: number;
	exitCode?: number;
	ok: boolean;
}

export interface Action {
	/** pi toolCallId. */
	actionId: string;
	attemptId: string | null;
	tool: string;
	args: Record<string, unknown>;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
	resultPreview?: string;
	fileChanges?: FileChange[];
	test?: TestRun;
}

export type BoundaryKind = "after_plan" | "before_start" | "after_finish";

export interface Checkpoint {
	checkpointId: string;
	commit: string;
	boundary: BoundaryKind;
	attemptId?: string;
	sessionEntryId?: string | null;
	planVersion: number;
	createdAt: number;
}

export type DependencyKind = "declared" | "recorded" | "inferred";

export interface Dependency {
	from: ModuleId;
	to: ModuleId;
	kind: DependencyKind;
	/** E.g. the file that links two modules for a recorded dependency. */
	label?: string;
}

export type InterventionKind = "pause" | "resume" | "edit_instructions" | "note" | "revise" | "stop";

export interface Intervention {
	interventionId: string;
	kind: InterventionKind;
	moduleId?: ModuleId;
	attemptId?: string;
	note?: string;
	at: number;
}
