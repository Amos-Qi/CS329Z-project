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
	/**
	 * A bash command is recorded as a test run when one of its simple commands (quoted strings and heredoc
	 * bodies removed) matches this. Default: TEST_COMMAND (pytest or `python -m pytest`, `node --test`, or a
	 * package's test script such as `npm test`).
	 */
	testCommandPattern?: RegExp;
	/** Append a reminder to mutating tool results when no module is active. Default: true. */
	remindUnassigned?: boolean;
	/**
	 * Light gate (docs/design.md §10): block edit and write calls while no module is active, telling the
	 * agent to plan and start a module first. Default: false (the protocol only reminds).
	 */
	gateEdits?: boolean;
}
