import { describe, expect, it } from "vitest";
import {
	type Action,
	attemptEvidence,
	computeFlags,
	criteria,
	currentAction,
	decision,
	diffStats,
	displayStatus,
	type FileChange,
	isTestCommand,
	pauseSlot,
	reduceTrace,
	STUCK_AFTER,
	type TestRun,
	type TraceEvent,
	type TraceEventBody,
	type ValidationResult,
	writesFiles,
} from "../src/index.ts";

/** A trace builder with explicit attempt ids, so redos and re-plans can be scripted. */
function run() {
	const events: TraceEvent[] = [];
	let actions = 0;
	let attempt: string | null = null;
	const push = (body: TraceEventBody) =>
		events.push({ ...body, seq: events.length, t: 1000 * events.length } as TraceEvent);
	const version = (moduleId: string, v = 1, over: Record<string, unknown> = {}) => ({
		moduleId,
		version: v,
		author: "agent" as const,
		createdAt: 0,
		title: `Module ${moduleId}`,
		purpose: "p",
		instructions: "i",
		skills: [],
		inputs: [],
		outputs: [],
		dependsOn: [],
		validation: [],
		...over,
	});
	const b = {
		events,
		start() {
			push({ type: "run_started", run: { runId: "r", taskId: "t", model: "m", workspace: "/ws" }, prompt: "go" });
			return b;
		},
		plan(order: string[], v = 1, validation: Record<string, string[]> = {}) {
			push({
				type: "plan_version",
				plan: { version: v, moduleOrder: order, author: "agent", createdAt: 0 },
				// new modules get their first version; known ones keep theirs
				modules: order
					.filter((id) => !events.some((e) => e.type === "plan_version" && e.plan.moduleOrder.includes(id)))
					.map((id) => version(id, 1, { validation: validation[id] ?? [] })),
			});
			return b;
		},
		begin(moduleId: string, n = 1) {
			attempt = `${moduleId}.${n}`;
			push({
				type: "attempt_started",
				attempt: { attemptId: attempt, moduleId, moduleVersion: 1, n, status: "running", startedAt: 0 },
			});
			return b;
		},
		finish(fileChanges?: FileChange[], validation?: ValidationResult[], status: "completed" | "failed" = "completed") {
			push({
				type: "attempt_ended",
				attemptId: attempt as string,
				status,
				validation,
				endCheckpoint: fileChanges ? "c" : undefined,
				fileChanges,
			});
			attempt = null;
			return b;
		},
		act(
			tool: string,
			args: Record<string, unknown>,
			end: { open?: boolean; isError?: boolean; isTest?: boolean; test?: TestRun; fileChanges?: FileChange[] } = {},
			attemptId: string | null = attempt,
		) {
			const actionId = `a${++actions}`;
			const action: Action = { actionId, attemptId, tool, args, startedAt: 0, isTest: end.isTest };
			push({ type: "action_started", action });
			if (!end.open) {
				push({
					type: "action_ended",
					actionId,
					isError: end.isError ?? false,
					test: end.test,
					fileChanges: end.fileChanges,
				});
			}
			return b;
		},
		edit(path: string, attemptId: string | null = attempt) {
			return b.act("edit", { path }, { fileChanges: [{ path, kind: "edit", patch: "@@\n-a\n+b" }] }, attemptId);
		},
		test(ok: boolean, passed = 3) {
			const test = { command: "pytest", passed, failed: ok ? 0 : 1, ok };
			return b.act("bash", { command: "python -m pytest -q" }, { isTest: true, isError: !ok, test });
		},
		invalidate(ids: string[]) {
			push({ type: "attempts_invalidated", attemptIds: ids, reason: "redo" });
			attempt = null;
			return b;
		},
		hold(boundary: "after_plan" | "before_start" | "after_finish", moduleId?: string) {
			push({ type: "boundary_paused", boundaryId: `b${events.length}`, boundary, moduleId });
			return b;
		},
		stop() {
			push({ type: "intervention", intervention: { interventionId: "i1", kind: "stop", at: 0 } });
			return b;
		},
		end(status: "completed" | "aborted" | "error" = "completed") {
			push({ type: "run_ended", status });
			return b;
		},
		state: () => reduceTrace(events),
	};
	return b;
}

describe("the Now bar's current action", () => {
	it("never shows a previous module's action, and prefers one still running", () => {
		const b = run().start().act("bash", { command: "head x" }, {}, null).plan(["M1", "M2"]);
		// right after the plan nothing has happened since: not the pre-plan head
		expect(currentAction(b.state())).toBeUndefined();
		b.begin("M1");
		expect(currentAction(b.state())).toBeUndefined();
		b.edit("a.py").finish();
		b.begin("M2");
		expect(currentAction(b.state())).toBeUndefined();
		b.act("read", { path: "b.py" });
		expect(currentAction(b.state())?.args.path).toBe("b.py");

		// a write still running beats a later finished (rejected) call
		const c = run().start().plan(["M1"]).begin("M1");
		c.act("write", { path: "shop/discounts.py" }, { open: true }).act("edit", {}, { isError: true });
		expect(currentAction(c.state())?.args.path).toBe("shop/discounts.py");
	});

	it("does not show the replaced attempt's action during a redo", () => {
		const b = run().start().plan(["M1", "M2"]).begin("M1").edit("a.py").finish();
		b.begin("M2").act("bash", { command: "pytest" }, { open: true }).invalidate(["M2.1"]).begin("M2", 2);
		expect(currentAction(b.state())).toBeUndefined();
		// the replaced attempt ended at its invalidation, so its card's duration stops there
		expect(b.state().attempts["M2.1"]?.endedAt).toBe(b.events.find((e) => e.type === "attempts_invalidated")?.t);
	});
});

describe("statuses and flags", () => {
	it("keeps flags of a module a re-plan dropped after it ran", () => {
		const b = run().start().plan(["M1", "M2"]).begin("M1").edit("a.py").finish();
		b.plan(["M2", "M3"], 2);
		expect(computeFlags(b.state()).map((f) => f.id)).toEqual(["unverified:M1.1"]);
	});

	it("a command after the last passing test leaves the module unverified", () => {
		const b = run().start().plan(["M1"]).begin("M1").edit("a.py").test(true);
		b.act("bash", { command: "sed -i 's/x/y/' shop/cart.py" });
		b.finish([
			{ path: "a.py", kind: "diff", patch: "-a\n+b" },
			{ path: "shop/cart.py", kind: "diff", patch: "-x\n+y" },
		]);
		const state = b.state();
		expect(displayStatus(state, "M1")).toBe("unverified");
		expect(computeFlags(state).map((f) => f.rule)).toEqual(["unverified", "command_change"]);
	});

	it("a module the agent never finished in a completed run is unverified and flagged, not stopped", () => {
		const done = run().start().plan(["M1"]).begin("M1").edit("a.py").end();
		expect(displayStatus(done.state(), "M1")).toBe("unverified");
		expect(computeFlags(done.state()).map((f) => f.text)).toEqual(["M1 was never finished (no finish_module)"]);
		const stopped = run().start().plan(["M1"]).begin("M1").edit("a.py").stop().end("aborted");
		expect(displayStatus(stopped.state(), "M1")).toBe("stopped");
		expect(computeFlags(stopped.state())).toEqual([]);
	});

	it("a module that changed nothing but whose tests fail is not verified", () => {
		const b = run().start().plan(["M1"]).begin("M1").test(false).finish();
		expect(displayStatus(b.state(), "M1")).toBe("unverified");
		expect(computeFlags(b.state()).map((f) => f.rule)).toEqual(["unverified"]);
	});

	it("re-running the same passing test is no progress", () => {
		const b = run().start().plan(["M1"]).begin("M1");
		for (let i = 0; i < STUCK_AFTER + 1; i++) b.act("read", { path: "a.py" }).test(true);
		expect(computeFlags(b.state()).some((f) => f.rule === "stuck")).toBe(true);
	});

	it("matches criteria by text, by position only one-to-one, and marks unreported ones", () => {
		const texts = ["Percent discounts round correctly", "BIG20 stops applying below $50"];
		const b = run().start().plan(["M1"], 1, { M1: texts }).begin("M1").test(true);
		b.finish(undefined, [{ criterion: "BIG20 minimum is re-checked after removal", met: false }]);
		expect(criteria(b.state(), "M1").map((c) => c.status)).toEqual(["unreported", "unreported"]);
		const both = run().start().plan(["M1"], 1, { M1: texts }).begin("M1").test(true);
		both.finish(undefined, [
			{ criterion: "Rounding works", met: true },
			{ criterion: "BIG20 minimum", met: false },
		]);
		expect(criteria(both.state(), "M1").map((c) => c.status)).toEqual(["verified", "failed"]);
	});

	it("work a redo discarded raises no flag and no recorded dependency", () => {
		const b = run().start().plan(["M1", "M2"]).begin("M1").edit("a.py").test(true).finish();
		b.edit("stray.txt", null).begin("M2").edit("notes.md").test(true).finish();
		b.invalidate(["M1.1", "M2.1"]).begin("M1", 2).act("read", { path: "notes.md" });
		const state = b.state();
		expect(computeFlags(state).filter((f) => f.rule === "unassigned_edit")).toEqual([]);
		expect(state.dependencies.filter((d) => d.kind === "recorded")).toEqual([]);
	});
});

describe("boundaries", () => {
	it("held at a re-plan: after the last finished module, with a redo", () => {
		const b = run().start().plan(["M1", "M2"]).begin("M1").edit("a.py").test(true).finish();
		b.begin("M2").edit("b.py").test(true).finish();
		// all planned modules are done: an armed pause would hold at the re-plan
		expect(pauseSlot(b.state())).toEqual({ after: "M2", boundary: "after_plan" });
		b.plan(["M1", "M2", "M3"], 2).hold("after_plan");
		expect(decision(b.state())).toMatchObject({
			after: "M2",
			next: "M3",
			redo: { moduleId: "M2", attemptId: "M2.1" },
		});
	});
});

describe("files and commands", () => {
	it("counts removed lines that start with -- inside a hunk", () => {
		expect(diffStats("--- a/x.md\n+++ b/x.md\n@@ -1,3 +1,1 @@\n----\n--- x\n text")).toEqual({ add: 0, del: 2 });
		expect(diffStats("@@\n-a\n+b\n+c")).toEqual({ add: 2, del: 1 });
	});

	it("finds test runs and file-writing commands by their command words", () => {
		for (const cmd of [
			"pytest -q",
			"python -m pytest -q",
			"cd x && .venv/bin/python -m pytest tests/",
			"npm test",
			"npm run test",
			"npm t",
			"CI=1 npm test -- --test-reporter=spec",
			"node --test",
			"node --test test/",
			"node --experimental-test-coverage --test",
			"pnpm test",
			"yarn test",
			"npm -s test",
			"npm --silent run test",
			"node test/game.test.js",
			"npm test 2>&1 | tail -20",
		]) {
			expect(isTestCommand(cmd), cmd).toBe(true);
		}
		for (const cmd of [
			"which pytest",
			"python -m pytest --version",
			"pytest --collect-only -q",
			"pip show pytest",
			"cat pytest.ini",
			"grep -rn pytest .",
			"cat > tests/test_x.py <<'EOF'\nimport pytest\nEOF",
			"node server.js",
			"node test/helpers.js",
			"node server.js --test",
			"npm run test:watch",
			"npm start",
			"npm test --help",
			"grep -rn 'npm test' README.md",
		]) {
			expect(isTestCommand(cmd), cmd).toBe(false);
		}
		for (const cmd of [
			"cat a > /dev/null",
			"command -v pytest >/dev/null 2>&1",
			"grep -n '>' f",
			"grep -rn '=>' src",
			"git log --format='%h -> %s'",
			"awk '$2 > 100' f",
			'python -c "print(1 > 0)"',
			'grep x <<< "$v"',
			"grep -rn 'rm -rf' scripts",
			"git checkout --help",
			"npm test",
			"node -e \"console.log(require('./package.json').scripts)\"",
		]) {
			expect(writesFiles(cmd), cmd).toBe(false);
		}
		for (const cmd of [
			"echo hi > out.txt",
			"ls 2>err.log",
			"make &> out",
			"sed --in-place 's/a/b/' f",
			"sed -e 's/a/b/' -i f",
			"perl -pi -e 's/a/b/' f",
			"git stash",
			"git reset --hard",
			"ruff check --fix .",
			"black .",
			"python -c \"open('x', 'w').write('1')\"",
			"cat > f <<'EOF'\nx\nEOF",
			"npm init -y",
			"npm pkg set scripts.test='node --test'",
			"node -e \"require('fs').writeFileSync('x.json', '{}')\"",
		]) {
			expect(writesFiles(cmd), cmd).toBe(true);
		}
	});

	it("a pytest-looking command without a test summary is not a test run", () => {
		const b = run().start().plan(["M1"]).begin("M1").act("bash", { command: "pytest --fixtures" }, { isTest: true });
		const state = b.state();
		const action = Object.values(state.actions)[0] as Action;
		expect(action.isTest).toBe(false);
		expect(attemptEvidence(state, state.attempts["M1.1"] as never).latestTest).toBeUndefined();
	});
});
