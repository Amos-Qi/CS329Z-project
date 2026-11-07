import type { TraceEventBody } from "@vcm/protocol";
import { describe, expect, it } from "vitest";
import { parseTestRun } from "../src/capture.ts";
import { ModuleStore, type PlannedModuleInput } from "../src/index.ts";

const DRAFT: PlannedModuleInput = {
	title: "Draft",
	purpose: "Write a draft",
	instructions: "Write a.txt",
	validation: ["a.txt exists"],
};
const FINISH: PlannedModuleInput = {
	title: "Finish",
	purpose: "Write b.txt",
	instructions: "Write b.txt",
	dependsOn: ["Draft"],
};
const MODULES = [DRAFT, FINISH];

function store() {
	const events: TraceEventBody[] = [];
	return { events, store: new ModuleStore((e) => events.push(e)) };
}

describe("ModuleStore", () => {
	it("a re-plan that repeats the agent's own definition keeps the overseer's edit", () => {
		const { store: s } = store();
		s.plan(MODULES, "first", "agent");
		s.applyEdits([{ moduleId: "M2", changes: { instructions: "Write b.txt IN CAPITALS" } }]);
		s.plan(
			MODULES.map((m, i) => ({ ...m, id: `M${i + 1}` })),
			"again",
			"agent",
		);
		expect(s.latest("M2")).toMatchObject({ version: 2, author: "user", instructions: "Write b.txt IN CAPITALS" });
		// a field the agent does change is the agent's; the overseer's other edits stay
		s.plan(
			[
				{ ...DRAFT, id: "M1" },
				{ ...FINISH, id: "M2", title: "Finish up" },
			],
			"rename",
			"agent",
		);
		expect(s.latest("M2")).toMatchObject({ version: 3, title: "Finish up", instructions: "Write b.txt IN CAPITALS" });
	});

	it("rewinding past a re-plan restores the definitions the agent changed after the checkpoint", async () => {
		const { store: s } = store();
		s.plan(MODULES, "first", "agent");
		const asOf = Date.now();
		await new Promise((r) => setTimeout(r, 5));
		s.plan(
			[
				{ ...DRAFT, id: "M1", instructions: "done" },
				{ ...FINISH, id: "M2", instructions: "done", dependsOn: [] },
			],
			"re-plan",
			"agent",
		);
		s.restorePlan(1, "Restored");
		const created = s.restoreVersions(asOf, "Restored");
		expect(created.map((v) => v.moduleId)).toEqual(["M1", "M2"]);
		expect(s.latest("M2")).toMatchObject({ version: 3, instructions: "Write b.txt", dependsOn: ["M1"] });
	});

	it("knows whether an edit changes anything", () => {
		const { store: s } = store();
		s.plan(MODULES, "first", "agent");
		expect(s.changes({ moduleId: "M2", changes: { instructions: "Write b.txt" } })).toBe(false);
		expect(s.changes({ moduleId: "M2", changes: { instructions: "Write c.txt" } })).toBe(true);
	});
});

describe("parseTestRun", () => {
	it("is no test run when a successful command printed no counts", () => {
		expect(parseTestRun("pytest --fixtures", "cache -- scope: session\n", false)).toBeUndefined();
		expect(parseTestRun("pytest", "ImportError while loading conftest", true)).toMatchObject({ ok: false });
		expect(parseTestRun("pytest -q", "3 passed in 0.1s", false)).toMatchObject({ passed: 3, ok: true });
	});

	it("reads the summary of Node's test runner", () => {
		const summary = (pass: number, fail: number, mark = "ℹ") =>
			[`${mark} tests ${pass + fail}`, `${mark} pass ${pass}`, `${mark} fail ${fail}`, `${mark} cancelled 0`].join(
				"\n",
			);
		expect(parseTestRun("npm test", `> snake@1.0.0 test\n> node --test\n\n✔ moves\n${summary(4, 0)}\n`, false)).toEqual(
			{
				command: "npm test",
				passed: 4,
				failed: 0,
				errors: 0,
				exitCode: undefined,
				ok: true,
			},
		);
		expect(parseTestRun("node --test", `✖ eats food\n${summary(3, 1)}\n`, true)).toMatchObject({
			passed: 3,
			failed: 1,
			ok: false,
		});
		expect(parseTestRun("node --test --test-reporter=tap", `${summary(2, 0, "#")}\n`, false)).toMatchObject({
			passed: 2,
			ok: true,
		});
		expect(parseTestRun("npm test", 'npm error Missing script: "test"', true)).toMatchObject({ ok: false });
		// "3 passed" in a test name does not override Node's own summary
		expect(
			parseTestRun("npm test", `✔ shows 3 passed levels\n✔ ends after 2 failed moves\n${summary(2, 0)}\n`, false),
		).toMatchObject({ passed: 2, failed: 0, ok: true });
		// `| tail` keeps the failing tests Node lists after its summary, and hides the exit code
		const tail =
			"test at test/game.test.js:4:1\n✖ grows when eating food (1.2ms)\n  AssertionError [ERR_ASSERTION]: 3 !== 4\n";
		expect(parseTestRun("npm test 2>&1 | tail -20", tail, false)).toMatchObject({ failed: 1, ok: false });
		// Node's failing-tests list names leaf tests only, not the suite around them
		const listed =
			"▶ snake\n  ✖ grows (0.5ms)\n✖ snake (7ms)\n✖ failing tests:\n\ntest at a.test.js:2:50\n✖ grows (0.5ms)\n";
		expect(parseTestRun("npm test | tail -30", listed, false)).toMatchObject({ failed: 1, ok: false });
		// `| tail` that kept only the error properties of the last failure
		const props = "      at Test.run (node:internal/test_runner/test:1258:12) {\n    code: 'ERR_ASSERTION',\n  }\n";
		expect(parseTestRun("npm test | tail", props, false)).toMatchObject({ ok: false });
		expect(parseTestRun("node --test --test-reporter=tap | tail", "not ok 2 - grows\n  ---\n", false)).toMatchObject({
			failed: 1,
			ok: false,
		});
	});
});
