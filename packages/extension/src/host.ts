import type { BoundaryKind, Checkpoint, FileChange, ModuleEdit, ModuleId, TraceEventBody } from "@vcm/protocol";

export interface BoundaryRequest {
	boundaryId: string;
	boundary: BoundaryKind;
	moduleId?: ModuleId;
	attemptId?: string;
}

export type BoundaryDecision =
	| { action: "continue"; edits?: ModuleEdit[]; note?: string }
	/** The host will rewind after the run settles; the tool ends the run. */
	| { action: "revise" }
	| { action: "stop" };

export interface CheckpointRequest {
	boundary: BoundaryKind;
	attemptId?: string;
	sessionEntryId?: string | null;
	planVersion: number;
}

/**
 * What the extension needs from whoever runs it. The server implements this with a trace store,
 * a boundary gate and a shadow-git checkpointer; the standalone CLI host only writes a file.
 */
export interface ModulesHost {
	emit(event: TraceEventBody): void;
	/** Resolves immediately unless the user asked to pause at the next boundary. */
	boundary(request: BoundaryRequest, signal?: AbortSignal): Promise<BoundaryDecision>;
	checkpoint?(request: CheckpointRequest): Promise<Checkpoint | undefined>;
	/** Files changed between two checkpoints, with patches. */
	diffCheckpoints?(fromCommit: string, toCommit: string): Promise<FileChange[]>;
	/** Seeded-failure hook: return replacement text for a tool result, or undefined to keep it. */
	rewriteToolResult?(toolName: string, input: Record<string, unknown>, text: string): string | undefined;
}

export interface ModulesExtensionOptions {
	/** Bash commands matching this are recorded as test runs. Default: /\bpytest\b/. */
	testCommandPattern?: RegExp;
	/** Append a reminder to mutating tool results when no module is active. Default: true. */
	remindUnassigned?: boolean;
}
