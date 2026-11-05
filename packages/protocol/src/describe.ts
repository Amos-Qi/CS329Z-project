/** One-line descriptions of trace events, used by the log view and by analysis exports. */

import type { TraceEvent } from "./events.ts";
import type { RunState } from "./reduce.ts";

export interface LogRow {
	seq: number;
	t: number;
	type: TraceEvent["type"];
	/** Module the event belongs to, if any. */
	moduleId?: string;
	attemptId?: string | null;
	summary: string;
}

const MAX = 160;

function clip(text: string, max = MAX): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function argSummary(tool: string, args: Record<string, unknown>): string {
	if (tool === "bash" && typeof args.command === "string") return clip(args.command, 120);
	if (typeof args.path === "string") return args.path;
	return clip(JSON.stringify(args), 120);
}

export function describeEvent(event: TraceEvent, state: RunState): LogRow {
	const base = { seq: event.seq, t: event.t, type: event.type };
	const moduleOfAttempt = (attemptId: string | null | undefined) =>
		attemptId ? state.attempts[attemptId]?.moduleId : undefined;

	switch (event.type) {
		case "run_started":
			return { ...base, summary: `Run started on ${event.run.taskId} with ${event.run.model}` };
		case "plan_version":
			return {
				...base,
				summary: `Plan v${event.plan.version} (${event.plan.author}): ${event.plan.moduleOrder
					.map((id) => {
						const title = event.modules.find((m) => m.moduleId === id)?.title ?? state.modules[id]?.latest.title;
						return title ? `${id} ${title}` : id;
					})
					.join(" → ")}`,
			};
		case "module_version":
			return {
				...base,
				moduleId: event.module.moduleId,
				summary: `${event.module.moduleId} instructions v${event.module.version} by ${event.module.author}: ${clip(event.module.instructions)}`,
			};
		case "attempt_started":
			return {
				...base,
				moduleId: event.attempt.moduleId,
				attemptId: event.attempt.attemptId,
				summary: `start_module ${event.attempt.moduleId} (attempt ${event.attempt.n}, v${event.attempt.moduleVersion})`,
			};
		case "attempt_ended":
			return {
				...base,
				moduleId: moduleOfAttempt(event.attemptId),
				attemptId: event.attemptId,
				summary: `finish_module ${moduleOfAttempt(event.attemptId) ?? ""} → ${event.status}${event.summary ? `: ${clip(event.summary)}` : ""}`,
			};
		case "attempts_invalidated":
			return { ...base, summary: `Invalidated ${event.attemptIds.length} attempt(s): ${event.reason}` };
		case "action_started": {
			const a = event.action;
			return {
				...base,
				moduleId: moduleOfAttempt(a.attemptId),
				attemptId: a.attemptId,
				summary: `${a.tool} ${argSummary(a.tool, a.args)}`,
			};
		}
		case "action_ended": {
			const a = state.actions[event.actionId];
			const status = event.isError ? "error" : "ok";
			const test = event.test ? ` · tests ${event.test.passed ?? 0} passed, ${event.test.failed ?? 0} failed` : "";
			return {
				...base,
				moduleId: moduleOfAttempt(a?.attemptId),
				attemptId: a?.attemptId,
				summary: `${a ? `${a.tool} ${argSummary(a.tool, a.args)}` : "tool"} → ${status}${test}${event.resultPreview ? ` — ${clip(event.resultPreview, 100)}` : ""}`,
			};
		}
		case "assistant_text":
			return {
				...base,
				moduleId: moduleOfAttempt(event.attemptId),
				attemptId: event.attemptId,
				summary: clip(event.text),
			};
		case "checkpoint":
			return {
				...base,
				attemptId: event.checkpoint.attemptId,
				moduleId: moduleOfAttempt(event.checkpoint.attemptId),
				summary: `Checkpoint ${event.checkpoint.commit.slice(0, 8)} (${event.checkpoint.boundary})`,
			};
		case "boundary_paused":
			return {
				...base,
				moduleId: event.moduleId,
				summary: `Paused at ${event.boundary}${event.moduleId ? ` ${event.moduleId}` : ""}`,
			};
		case "boundary_resumed":
			return { ...base, summary: `Resumed (${event.decision})` };
		case "intervention":
			return {
				...base,
				moduleId: event.intervention.moduleId,
				summary: `User ${event.intervention.kind}${event.intervention.moduleId ? ` ${event.intervention.moduleId}` : ""}${event.intervention.note ? `: ${clip(event.intervention.note)}` : ""}`,
			};
		case "intervention_delivered":
			return { ...base, summary: `Delivered ${event.interventionId} to the agent` };
		case "audit":
			return {
				...base,
				summary: `Audit: ${event.report.unassignedActions} unassigned action(s), ${event.report.unattributedChanges.length} unattributed change(s), ${event.report.missingActions.length} missing`,
			};
		case "run_ended":
			return { ...base, summary: `Run ${event.status}${event.error ? `: ${event.error}` : ""}` };
	}
}
