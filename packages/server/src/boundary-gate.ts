import type { BoundaryDecision, BoundaryRequest } from "@vcm/extension";
import type { PendingBoundary, TraceEventBody } from "@vcm/protocol";

interface Pending {
	request: BoundaryRequest;
	resolve: (decision: BoundaryDecision) => void;
}

/**
 * Holds the agent at a module boundary until the overseer decides. The module tools await
 * wait(); the UI's resume/revise/stop messages call decide().
 *
 * "Pause at next boundary" is one-shot: an armed pause holds the agent once and then disarms, so
 * Continue goes on to the next module instead of stopping again at its start (docs/design.md §7).
 */
export class BoundaryGate {
	pauseAtBoundary = false;
	pauseAfterPlan: boolean;
	private pending: Pending | undefined;
	private readonly emit: (event: TraceEventBody) => void;
	private readonly onChange: () => void;

	constructor(emit: (event: TraceEventBody) => void, onChange: () => void, pauseAfterPlan = false) {
		this.emit = emit;
		this.onChange = onChange;
		this.pauseAfterPlan = pauseAfterPlan;
	}

	get current(): PendingBoundary | undefined {
		if (!this.pending) return undefined;
		const { boundaryId, boundary, moduleId } = this.pending.request;
		return { boundaryId, boundary, moduleId };
	}

	wait(request: BoundaryRequest, signal?: AbortSignal): Promise<BoundaryDecision> {
		// Stop or Redo aborted the agent while the tool was still taking its snapshot: an abort listener
		// added now would never fire, so the agent would hold forever
		if (signal?.aborted) return Promise.resolve({ action: "stop" });
		const firstPlan = this.pauseAfterPlan && request.boundary === "after_plan";
		if (!this.pauseAtBoundary && !firstPlan) return Promise.resolve({ action: "continue" });
		if (firstPlan) this.pauseAfterPlan = false;
		this.pauseAtBoundary = false;

		this.emit({
			type: "boundary_paused",
			boundaryId: request.boundaryId,
			boundary: request.boundary,
			moduleId: request.moduleId,
		});
		return new Promise((resolve) => {
			const onAbort = () => this.decide(request.boundaryId, { action: "stop" });
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending = {
				request,
				resolve: (decision) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(decision);
				},
			};
			this.onChange();
		});
	}

	decide(boundaryId: string, decision: BoundaryDecision): boolean {
		const pending = this.pending;
		if (!pending || pending.request.boundaryId !== boundaryId) return false;
		this.pending = undefined;
		this.emit({
			type: "boundary_resumed",
			boundaryId,
			decision: decision.action === "continue" ? (decision.edits?.length ? "edit" : "continue") : decision.action,
		});
		pending.resolve(decision);
		this.onChange();
		return true;
	}
}
