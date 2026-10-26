import type { BoundaryDecision, BoundaryRequest } from "@vcm/extension";
import type { PendingBoundary, TraceEventBody } from "@vcm/protocol";

/**
 * Holds the agent at a module boundary until the overseer decides. The module tools await
 * wait(); the UI's resume/revise/stop messages call decide(). See docs/design.md §7.
 */
export class BoundaryGate {
	pauseAtBoundary = false;
	private readonly emit: (event: TraceEventBody) => void;

	constructor(emit: (event: TraceEventBody) => void) {
		this.emit = emit;
	}

	/** The boundary the agent is currently held at, if any. */
	get current(): PendingBoundary | undefined {
		// TODO
		return undefined;
	}

	wait(_request: BoundaryRequest, _signal?: AbortSignal): Promise<BoundaryDecision> {
		// TODO: when pauseAtBoundary is set, emit boundary_paused and return a promise that decide()
		// resolves (and that resolves to { action: "stop" } if the signal aborts).
		void this.emit;
		return Promise.resolve({ action: "continue" });
	}

	decide(_boundaryId: string, _decision: BoundaryDecision): boolean {
		// TODO: resolve the pending boundary and emit boundary_resumed.
		return false;
	}
}
