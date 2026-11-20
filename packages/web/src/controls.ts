/**
 * The intervention controls both conditions share (docs/design.md §6.3, §7), as ClientMessages.
 * They only send; what happened comes back through the trace (and errors as ServerMessage
 * `error`, surfaced by RunConnection.error/errorId). Each returns whether the message was sent (false
 * when not connected), so the UI keeps what you typed when it was not. UI bookkeeping (focus, toasts, drafts) lives in
 * state/ui.ts, whose transitions call these.
 */

import type { ModuleId } from "@vcm/protocol";
import { useMemo } from "react";
import type { RunConnection } from "./api.ts";

/** Everything the panel can ask the server to do for one run. */
export interface Controls {
	/** Arms (true) or disarms the one-shot "pause at the next boundary" (`set_pause_at_boundary`). */
	armPause(on: boolean): boolean;
	/** Lets a held agent go on (`resume {boundaryId}`). Returns false when nothing is held. */
	continueRun(): boolean;
	/** "Change Mk": new instructions for a module that has not started (`edit`); used when it starts. */
	change(moduleId: ModuleId, instructions: string, note?: string): boolean;
	/** "Correct Mk": a correction for the running module (`note {moduleId}`), steered after its current step. */
	correct(moduleId: ModuleId, text: string): boolean;
	/** "Note to agent" for the whole run (`note {text}`), steered after the current step / on continue. */
	note(text: string): boolean;
	/**
	 * "Redo from Mk" (`revise`): rewinds to before `attemptId` (Mk's current attempt) with new
	 * instructions; the server stops a running agent first. Works after the run ended while the
	 * server still holds the session (control.live).
	 */
	redo(moduleId: ModuleId, attemptId: string, instructions: string, note?: string): boolean;
	/** Stops the agent (`stop` → run_ended aborted). */
	stop(): boolean;
}

/** A Controls that does nothing (replay, Home, tests). */
export const NO_CONTROLS: Controls = {
	armPause: () => false,
	continueRun: () => false,
	change: () => false,
	correct: () => false,
	note: () => false,
	redo: () => false,
	stop: () => false,
};

/**
 * Controls for `runId` over `connection`. `heldBoundaryId` is the boundary the agent waits at
 * according to the trace (state.pendingBoundary); the server's `control.pending` wins when present.
 */
export function useControls(
	runId: string | undefined,
	connection: Pick<RunConnection, "send" | "control">,
	heldBoundaryId?: string,
): Controls {
	const { send, control } = connection;
	const boundaryId = control?.pending?.boundaryId ?? heldBoundaryId;
	return useMemo((): Controls => {
		if (!runId) return NO_CONTROLS;
		return {
			armPause: (on) => send({ type: "set_pause_at_boundary", runId, value: on }),
			continueRun: () => (boundaryId ? send({ type: "resume", runId, boundaryId }) : false),
			change: (moduleId, instructions, note) =>
				send({ type: "edit", runId, edits: [{ moduleId, changes: { instructions }, note }] }),
			correct: (moduleId, text) => send({ type: "note", runId, moduleId, text }),
			note: (text) => send({ type: "note", runId, text }),
			redo: (moduleId, attemptId, instructions, note) =>
				send({
					type: "revise",
					runId,
					attemptId,
					edits: [{ moduleId, changes: { instructions }, note }],
					note,
				}),
			stop: () => send({ type: "stop", runId }),
		};
	}, [runId, send, boundaryId]);
}
