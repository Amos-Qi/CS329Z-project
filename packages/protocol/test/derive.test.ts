import { describe, expect, it } from "vitest";
import {
	type Action,
	computeFlags,
	criteria,
	decision,
	displayStatus,
	fileStats,
	pauseSlot,
	reduceTrace,
	STUCK_AFTER,
	type TraceEvent,
	type TraceEventBody,
} from "../src/index.ts";

/** A tiny trace builder: plan two modules, then script attempts and actions. */
function trace() {
	const events: TraceEvent[] = [];
	let actions = 0;
	const push = (body: TraceEventBody) =>
		events.push({ ...body, seq: events.length, t: 1000 * events.length } as TraceEvent);
	const version = (moduleId: string, validation: string[] = []) => ({
		moduleId,
		version: 1,
		author: "agent" as const,
		createdAt: 0,
		title: `Module ${moduleId}`,
		purpose: "p",
		instructions: "i",
		skills: [],
		inputs: [],
		outputs: [],
		dependsOn: [],
		validation,
	});
	const api = {
		events,
		start(workspace = "/ws") {
			push({ type: "run_started", run: { runId: "r", taskId: "t", model: "m", workspace }, prompt: "go" });
			return api;
		},
		plan() {
			push({
				type: "plan_version",
				plan: { version: 1, moduleOrder: ["M1", "M2"], author: "agent", createdAt: 0 },
				modules: [version("M1", ["works"]), version("M2")],
			});
			return api;
		},
		begin(moduleId: string) {
			push({
				type: "attempt_started",
				attempt: { attemptId: `${moduleId}.1`, moduleId, moduleVersion: 1, n: 1, status: "running", startedAt: 0 },
			});
			return api;
		},
		act(tool: string, args: Record<string, unknown>, end: Partial<Action> & { attemptId?: string | null } = {}) {
			const actionId = `a${++actions}`;
			const attemptId = end.attemptId === undefined ? lastAttempt() : end.attemptId;
			push({ type: "action_started", action: { actionId, attemptId, tool, args, startedAt: 0, isTest: end.isTest } });
			push({
				type: "action_ended",
				actionId,
				isError: end.isError ?? false,
				fileChanges: end.fileChanges,
				test: end.test,
			});
			return api;
		},
		edit(path: string, attemptId?: string | null) {
			return api.act("edit", { path }, { attemptId, fileChanges: [{ path, kind: "edit", patch: "@@\n-a\n+b\n+c" }] });
		},
		test(ok: boolean) {
			const test = { command: "pytest", passed: 3, failed: ok ? 0 : 1, ok };
			return api.act("bash", { command: "pytest" }, { isTest: true, isError: !ok, test });
		},
		finish(moduleId: string, fileChanges?: { path: string; kind: "diff"; patch?: string }[]) {
			push({
				type: "attempt_ended",
				attemptId: `${moduleId}.1`,
				status: "completed",
				validation: [{ criterion: "works", met: true }],
				endCheckpoint: fileChanges ? "c1" : undefined,
				fileChanges,
			});
			return api;
		},
		pause(boundary: "after_plan" | "before_start" | "after_finish", moduleId?: string) {
			push({ type: "boundary_paused", boundaryId: "b1", boundary, moduleId });
			return api;
		},
		state: () => reduceTrace(events),
	};
	function lastAttempt(): string | null {
		const started = events.findLast((e) => e.type === "attempt_started");
		const ended = events.findLast((e) => e.type === "attempt_ended");
		if (started?.type !== "attempt_started") return null;
		return ended && ended.seq > started.seq ? null : started.attempt.attemptId;
	}
	return api;
}

describe("derive", () => {
	it("verifies a module only by a passing test after its last edit", () => {
		const verified = trace().start().plan().begin("M1").edit("a.py").test(true).finish("M1").state();
		expect(displayStatus(verified, "M1")).toBe("verified");
		expect(criteria(verified, "M1")).toEqual([{ text: "works", status: "verified" }]);
		expect(computeFlags(verified)).toEqual([]);

		const stale = trace().start().plan().begin("M1").test(true).edit("a.py").finish("M1").state();
		expect(displayStatus(stale, "M1")).toBe("unverified");
		expect(criteria(stale, "M1")).toEqual([{ text: "works", status: "agent" }]);
		expect(computeFlags(stale).map((f) => f.rule)).toEqual(["unverified"]);

		const readOnly = trace().start().plan().begin("M1").act("read", { path: "a.py" }).finish("M1").state();
		expect(displayStatus(readOnly, "M1")).toBe("verified");
	});

	it("flags failing tests, command changes, unassigned edits and stuck modules", () => {
		const failing = trace().start().plan().begin("M1").edit("a.py").test(false).state();
		expect(displayStatus(failing, "M1")).toBe("working");
		expect(computeFlags(failing).map((f) => f.rule)).toEqual(["tests_failing"]);

		const bash = trace()
			.start()
			.plan()
			.begin("M1")
			.edit("a.py")
			.act("bash", { command: "sed -i s/x/y/ b.py" })
			.test(true)
			.finish("M1", [
				{ path: "a.py", kind: "diff", patch: "-a\n+b" },
				{ path: "b.py", kind: "diff", patch: "-x\n+y" },
			])
			.state();
		expect(computeFlags(bash).map((f) => f.id)).toEqual(["command_change:M1.1:b.py"]);
		expect(fileStats(bash, bash.attempts["M1.1"] ?? null)).toEqual([
			{ path: "a.py", add: 1, del: 1, patch: "-a\n+b" },
			{ path: "b.py", add: 1, del: 1, patch: "-x\n+y" },
		]);

		const outside = trace()
			.start()
			.act("read", { path: "a.py" }, { attemptId: null })
			.plan()
			.edit("/ws/c.py", null)
			.state();
		expect(computeFlags(outside).map((f) => f.text)).toEqual(["Edit outside any module: c.py"]);

		const stuck = trace().start().plan().begin("M1");
		for (let i = 0; i < STUCK_AFTER + 1; i++) stuck.test(false);
		expect(computeFlags(stuck.state()).some((f) => f.rule === "stuck")).toBe(true);
	});

	it("places the pause marker and the decision card", () => {
		const t = trace().start();
		expect(pauseSlot(t.state())).toEqual({ after: null, boundary: "after_plan" });
		t.plan().begin("M1");
		expect(pauseSlot(t.state())).toMatchObject({ after: "M1", boundary: "after_finish" });
		t.edit("a.py").test(true).finish("M1");
		expect(pauseSlot(t.state())).toMatchObject({ after: "M1", boundary: "before_start", moduleId: "M2" });
		t.pause("after_finish", "M1");
		expect(pauseSlot(t.state())).toBeUndefined();
		expect(decision(t.state())).toMatchObject({ after: "M1", next: "M2", redo: { moduleId: "M1", attemptId: "M1.1" } });
	});
});
