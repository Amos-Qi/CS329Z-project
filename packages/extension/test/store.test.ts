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
});
