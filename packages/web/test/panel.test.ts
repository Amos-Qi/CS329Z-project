import {
	type Action,
	type FileChange,
	type ModuleVersion,
	type RunControlState,
	reduceTrace,
	type TestRun,
	type TraceEvent,
	type TraceEventBody,
} from "@vcm/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Controls } from "../src/controls.ts";
import {
	capLines,
	clock,
	commandName,
	foldSteps,
	joinAnd,
	newFileLines,
	outputLines,
	parsePatch,
	seconds,
} from "../src/model/format.ts";
import { buildPanel, type Panel, PRE, redoPreview, shownStatus, slotLabel } from "../src/model/panel.ts";
import { defaultRow, editorOn, initialUi, overviewOpen, UiStore, visibleEvents } from "../src/state/ui.ts";

const T0 = 1_000_000;
const WS = "/ws";

/** A synthetic trace builder: every event is one second after the previous one. */
function trace() {
	const events: TraceEvent[] = [];
	let actions = 0;
	let interventions = 0;
	const time = () => T0 + 1000 * events.length;
	const push = (body: TraceEventBody) => {
		events.push({ ...body, seq: events.length, t: time() } as TraceEvent);
	};
	const version = (moduleId: string, over: Partial<ModuleVersion> = {}): ModuleVersion => ({
		moduleId,
		version: 1,
		author: "agent",
		createdAt: time(),
		title: `Module ${moduleId}`,
		label: `L${moduleId}`,
		purpose: `Purpose of ${moduleId}`,
		instructions: `Do ${moduleId}`,
		skills: [],
		inputs: [],
		outputs: [],
		dependsOn: [],
		validation: [`${moduleId} works`],
		...over,
	});
	/** Each module's latest definition, which a user version carries over (as the store's applyEdits does). */
	const latest = new Map<string, ModuleVersion>();
	let attempt: string | null = null;
	const b = {
		events,
		start() {
			push({
				type: "run_started",
				run: { runId: "r1", taskId: "toy", model: "m", workspace: WS },
				prompt: "Add discount codes to the cart.\nMore details.",
			});
			return b;
		},
		plan(
			order: string[],
			deps: Record<string, string[]> = {},
			v = 1,
			rationale?: string,
			author: "agent" | "user" = "agent",
		) {
			const modules = order.map((id) => version(id, { dependsOn: deps[id] ?? [] }));
			for (const m of modules) latest.set(m.moduleId, m);
			push({
				type: "plan_version",
				plan: { version: v, moduleOrder: order, author, rationale, createdAt: time() },
				modules,
			});
			return b;
		},
		begin(moduleId: string, n = 1) {
			attempt = `${moduleId}.${n}`;
			push({
				type: "attempt_started",
				attempt: {
					attemptId: attempt,
					moduleId,
					moduleVersion: 1,
					n,
					status: "running",
					startedAt: time(),
					startEntryId: `e-${moduleId}`,
					startCheckpoint: `c-${moduleId}`,
				},
			});
			return b;
		},
		finish(moduleId: string, fileChanges?: FileChange[], n = 1) {
			push({
				type: "attempt_ended",
				attemptId: `${moduleId}.${n}`,
				status: "completed",
				summary: `${moduleId} done`,
				validation: [{ criterion: `${moduleId} works`, met: true }],
				endCheckpoint: fileChanges ? `end-${moduleId}` : undefined,
				fileChanges,
			});
			attempt = null;
			return b;
		},
		/** Starts an action; `end` finishes it in the next event unless `open`. */
		act(
			tool: string,
			args: Record<string, unknown>,
			end: {
				open?: boolean;
				isError?: boolean;
				isTest?: boolean;
				resultPreview?: string;
				fileChanges?: FileChange[];
				test?: TestRun;
				attemptId?: string | null;
			} = {},
		) {
			const actionId = `a${++actions}`;
			const attemptId = end.attemptId === undefined ? attempt : end.attemptId;
			const action: Action = { actionId, attemptId, tool, args, startedAt: time(), isTest: end.isTest };
			push({ type: "action_started", action });
			if (!end.open) {
				push({
					type: "action_ended",
					actionId,
					isError: end.isError ?? false,
					resultPreview: end.resultPreview,
					fileChanges: end.fileChanges,
					test: end.test,
				});
			}
			return b;
		},
		read(path: string, text = "line 1\nline 2\nline 3\n", attemptId?: string | null) {
			return b.act("read", { path }, { resultPreview: text, attemptId });
		},
		edit(path: string, patch = "--- a\n+++ b\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n+more", attemptId?: string | null) {
			return b.act("edit", { path }, { fileChanges: [{ path, kind: "edit", patch }], attemptId });
		},
		write(path: string, content: string) {
			return b.act("write", { path, content }, { fileChanges: [{ path, kind: "write" }] });
		},
		test(passed: number, failed = 0, open = false) {
			const ok = failed === 0;
			const preview = ok
				? `${".".repeat(passed)}    [100%]\n${passed} passed in 0.01s\n`
				: `${".".repeat(passed)}F    [100%]\nFAILED tests/test_x.py::test_round\nE   assert 199 == 200\n${passed} passed, ${failed} failed in 0.2s\n`;
			return b.act(
				"bash",
				{ command: "python -m pytest -q" },
				{ isTest: true, open, isError: !ok, resultPreview: preview, test: { command: "pytest", passed, failed, ok } },
			);
		},
		say(text: string) {
			push({ type: "assistant_text", attemptId: attempt, text });
			return b;
		},
		intervene(kind: "note" | "correct" | "pause" | "resume" | "stop" | "revise", fields: Record<string, string> = {}) {
			const interventionId = `i${++interventions}`;
			push({ type: "intervention", intervention: { interventionId, kind, at: time(), ...fields } });
			return interventionId;
		},
		deliver(interventionId: string) {
			push({ type: "intervention_delivered", interventionId });
			return b;
		},
		hold(boundary: "after_plan" | "before_start" | "after_finish", moduleId?: string, boundaryId = "b1") {
			push({ type: "boundary_paused", boundaryId, boundary, moduleId });
			return b;
		},
		resume(boundaryId = "b1") {
			push({ type: "boundary_resumed", boundaryId, decision: "continue" });
			return b;
		},
		userVersion(moduleId: string, v: number, instructions: string) {
			const prev = latest.get(moduleId) ?? version(moduleId);
			const module: ModuleVersion = { ...prev, version: v, author: "user", instructions, createdAt: time() };
			latest.set(moduleId, module);
			push({ type: "module_version", module });
			return b;
		},
		invalidate(ids: string[]) {
			push({ type: "attempts_invalidated", attemptIds: ids, reason: "The overseer revised" });
			return b;
		},
		audit(unassigned: number) {
			push({
				type: "audit",
				report: { missingActions: [], unattributedChanges: [], assignedActions: 5, unassignedActions: unassigned },
			});
			return b;
		},
		end(status: "completed" | "aborted" | "error" = "completed", error?: string) {
			push({ type: "run_ended", status, error });
			return b;
		},
	};
	return b;
}

const LIVE: RunControlState = { runId: "r1", live: true, pauseAtBoundary: false, busy: false };

function panelOf(
	events: TraceEvent[],
	opts: { control?: RunControlState; replaying?: boolean; now?: number } = {},
): Panel {
	return buildPanel(reduceTrace(events), {
		events,
		now: opts.now ?? (events.at(-1)?.t ?? T0) + 500,
		control: opts.control,
		replaying: opts.replaying ?? false,
	});
}

/** A finished three-module run: M1 verified, M2 verified, M3 claimed done without a test. */
function finishedRun() {
	const b = trace().start().read("README.md").act("bash", { command: "ls" }, { resultPreview: "README.md shop" });
	b.say("I'll split the work into three modules.").plan(["M1", "M2", "M3"], { M2: ["M1"], M3: ["M2"] });
	b.begin("M1").write("shop/discounts.py", "a = 1\nb = 2\n").test(4);
	b.finish("M1", [
		{ path: `${WS}/shop/discounts.py`, kind: "diff", patch: "--- a\n+++ b\n@@ -0,0 +1,2 @@\n+a = 1\n+b = 2" },
	]);
	b.begin("M2").read("shop/cart.py").edit("shop/cart.py").test(4);
	b.finish("M2", [{ path: "shop/cart.py", kind: "diff", patch: "@@ -1 +1,3 @@\n-x\n+y\n+z\n+w" }]);
	b.begin("M3").say("The guide says to truncate.").read("docs/CONTRIBUTING.md").edit("shop/cart.py");
	b.finish("M3", [{ path: "shop/cart.py", kind: "diff", patch: "@@ -1 +1 @@\n-y\n+q" }]);
	b.say("Done.").audit(2).end();
	return b.events;
}

describe("format helpers", () => {
	it("formats and parses clocks", () => {
		expect(clock(0)).toBe("0:00");
		expect(clock(61_900)).toBe("1:01");
		expect(clock(-5)).toBe("0:00");
		expect(clock(Number.NaN)).toBe("0:00");
		expect(clock(3_600_000)).toBe("60:00");
		expect(seconds("3:40")).toBe(220);
	});

	it("parses patches into h/c/a/d lines, dropping file headers", () => {
		expect(parsePatch("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n")).toEqual([
			["h", "@@ -1,2 +1,2 @@"],
			["c", " ctx"],
			["d", "-old"],
			["a", "+new"],
		]);
		expect(parsePatch(undefined)).toEqual([]);
		expect(newFileLines("a\nb\n")).toEqual([
			["h", "@@ -0,0 +1,2 @@ new file"],
			["a", "+a"],
			["a", "+b"],
		]);
	});

	it("marks failures and passing summaries in test output", () => {
		const out = outputLines(
			"...F   [100%]\nFAILED t.py::x\nE   assert 1 == 2\n3 passed, 1 failed in 0.1s\n",
			"pytest -q",
		);
		expect(out).toEqual([
			["c", "$ pytest -q"],
			["c", "...F   [100%]"],
			["f", "FAILED t.py::x"],
			["f", "E   assert 1 == 2"],
			["f", "3 passed, 1 failed in 0.1s"],
		]);
		expect(outputLines("....   [100%]\n4 passed in 0.01s\n")).toEqual([
			["o", "....   [100%]"],
			["o", "4 passed in 0.01s"],
		]);
	});

	it("names commands, joins ids, folds reads and caps long blocks", () => {
		expect(commandName("python -m pytest -q")).toBe("pytest");
		expect(commandName("FOO=1 npm test")).toBe("npm");
		expect(commandName("/usr/bin/ls -la")).toBe("ls");
		expect(joinAnd(["M1"])).toBe("M1");
		expect(joinAnd(["M1", "M2", "M3"])).toBe("M1, M2 and M3");
		const folded = foldSteps([{ type: "read" }, { type: "read" }, { type: "edit" }, { type: "read" }]);
		expect(folded.map((s) => s.type)).toEqual(["fold", "edit", "read"]);
		const capped = capLines(
			Array.from({ length: 5 }, (_, i) => ["c", `${i}`] as ["c", string]),
			3,
		);
		expect(capped.at(-1)).toEqual(["h", "  … 2 more lines"]);
	});
});

describe("buildPanel: a finished run", () => {
	const events = finishedRun();
	const panel = panelOf(events);

	it("puts actions before the plan on the before-plan station", () => {
		expect(panel.pre.title).toBe("Before plan");
		expect(panel.pre.status).toBe("pre");
		expect(panel.pre.actions.map((a) => [a.type, a.target])).toEqual([
			["read", "README.md"],
			["bash", "ls"],
		]);
		expect(panel.pre.looked).toEqual(["README.md"]);
		expect(panel.pre.desc).toBe("Read 1 file, ran 1 command");
		expect(panel.pre.span).toBe("0:00–0:06");
		// the agent's narration outside modules after the plan (its final report) is here too, tagged
		expect(panel.pre.steps.map((s) => s.kind)).toEqual(["act", "act", "say", "say"]);
		expect(panel.pre.steps.at(-1)).toMatchObject({ kind: "say", text: "Done.", where: "after M3" });
		expect(panel.pre.steps[2]).not.toHaveProperty("where");
		expect(panel.pre.goal).toBe("Add discount codes to the cart.");
	});

	it("derives statuses, flags and the plan structure", () => {
		expect(panel.ids).toEqual(["M1", "M2", "M3"]);
		expect(panel.modules.map((m) => m.status)).toEqual(["verified", "verified", "unverified"]);
		expect(panel.edges).toEqual([
			["M1", "M2"],
			["M2", "M3"],
		]);
		const m2 = panel.byId.M2!;
		expect(m2.short).toBe("LM2");
		expect(m2.deps).toEqual(["M1"]);
		expect(m2.dependents).toEqual(["M3"]);
		expect(m2.depsText).toBe("needs M1 · needed by M3");
		const m3 = panel.byId.M3!;
		expect(m3.flag).toBe(true);
		expect(m3.flags.map((f) => f.rule)).toEqual(["unverified"]);
		expect(m3.criteria).toEqual([{ text: "M3 works", st: "agent" }]);
		expect(panel.byId.M1!.criteria).toEqual([{ text: "M1 works", st: "verified" }]);
		expect(panel.flags).toHaveLength(1);
		expect(m3.tip).toBe("M3 · Module M3 — Done, unverified (no passing test after last edit) · needs M2");
	});

	it("uses the checkpoint fileStats for files, and tests/looked/steps of the attempt", () => {
		const m1 = panel.byId.M1!;
		expect(m1.files).toEqual([
			expect.objectContaining({ path: "shop/discounts.py", add: 2, del: 0, diff: expect.any(Array) }),
		]);
		expect(m1.tests).toMatchObject({ pass: 4, fail: 0, live: false });
		expect(m1.actions[0]).toMatchObject({ type: "write", target: "shop/discounts.py", add: 2, del: 0 });
		expect(m1.actions[1]).toMatchObject({ type: "test", target: "pytest", cmd: "python -m pytest -q", pass: 4 });
		expect(m1.actions[1]!.out[0]).toEqual(["c", "$ python -m pytest -q"]);
		expect(m1.evidenceText).toBe("+2 −0 lines · tests 4 passed, 0 failed");
		const m2 = panel.byId.M2!;
		expect(m2.files).toEqual([expect.objectContaining({ path: "shop/cart.py", add: 3, del: 1 })]);
		expect(m2.looked).toEqual(["shop/cart.py"]);
		expect(m2.actions.find((a) => a.type === "edit")).toMatchObject({ add: 2, del: 1 });
		const m3 = panel.byId.M3!;
		expect(m3.tests).toBeNull();
		expect(m3.steps.map((s) => s.kind)).toEqual(["say", "act", "act"]);
		expect(m3.start).toBe(clock(panel.byId.M3!.actions[0]!.at - T0 - 2000));
		expect(m3.dur).toBeDefined();
	});

	it("finished and not live: nothing selected, no controls, a run summary", () => {
		expect(panel.live).toBe(false);
		expect(panel.serverHeld).toBe(false);
		expect(panel.now.kind).toBe("finished");
		expect(panel.defaultSel).toBeNull();
		expect(panel.modules.every((m) => m.primary === null)).toBe(true);
		expect(panel.summary?.files).toEqual([
			{ path: "shop/discounts.py", add: 2, del: 0, by: ["M1"] },
			{ path: "shop/cart.py", add: 4, del: 2, by: ["M2", "M3"] },
		]);
		expect(panel.summary?.total).toEqual({ files: 2, add: 6, del: 2 });
		expect(panel.summary?.runClock).toBe(panel.now.runClock);
		expect(panel.now.runClock).toBe(clock(events.at(-1)!.t - T0));
	});

	it("builds the log rows in trace order, with the flag on M3's finish row", () => {
		const texts = panel.events.map((e) => e.text);
		expect(texts[0]).toBe("Run started");
		expect(texts).toContain("Read README.md");
		expect(texts).toContain("Run ls");
		expect(texts).toContain("Plan v1 · 3 modules");
		expect(texts).toContain("Start M1 · Module M1");
		expect(texts).toContain("Run pytest");
		expect(texts).toContain("Finish M1 · verified");
		expect(texts).toContain("Finish M3 · unverified");
		// before-plan exploration is not "outside modules" (the Modules view's summary counts it the same way)
		expect(texts).toContain("Audit");
		expect(panel.events.find((e) => e.id === "audit")?.detail).toMatchObject({
			text: "5 actions in modules, 0 outside modules, 2 before plan",
		});
		expect(texts.at(-1)).toBe("Run finished · 3 modules · 1 flag");
		expect(panel.events.map((e) => e.seq)).toEqual([...panel.events.map((e) => e.seq)].sort((a, b) => a - b));
		const flagged = panel.events.filter((e) => e.flag).map((e) => e.id);
		expect(flagged).toEqual(["f:M3.1"]);
		const plan = panel.events.find((e) => e.kind === "plan")!;
		expect(plan.current).toBe(true);
		expect(plan.detail).toMatchObject({
			kind: "plan",
			modules: [{ id: "M1" }, { id: "M2", deps: ["M1"] }, { id: "M3" }],
		});
		const pre = panel.events.filter((e) => e.mod === PRE).map((e) => e.type);
		expect(pre).toEqual(["read", "bash", "say"]);
		expect(panel.events.find((e) => e.text === "Done.")?.mod).toBe("run");
		const finish = panel.events.find((e) => e.id === "f:M3.1")!;
		expect(finish.detail).toMatchObject({ kind: "finish", criteria: [{ text: "M3 works", st: "agent" }] });
	});

	it("filters log rows like the mockup", () => {
		const ui = initialUi();
		const only = (lf: Partial<typeof ui.lf>) =>
			visibleEvents(panel, { ...ui, lf: { ...ui.lf, ...lf } }).map((e) => e.id);
		expect(only({ flag: true })).toEqual(["f:M3.1"]);
		expect(only({ mod: "M1" })).toContain("plan:1");
		expect(only({ mod: PRE })).not.toContain("plan:1");
		expect(only({ type: "edit" }).every((id) => id.startsWith("a:"))).toBe(true);
		expect(only({ q: "unverified" })).toEqual(["f:M3.1"]);
	});

	it("previews a redo: kept modules, replaced attempts, restored files", () => {
		const held = panelOf(events, { control: { ...LIVE, live: true } });
		expect(held.serverHeld).toBe(true);
		expect(held.byId.M2!.canRedo).toBe(true);
		expect(held.byId.M2!.primary).toBe("redo");
		const preview = redoPreview(held, "M2")!;
		expect(preview.kept).toEqual(["M1"]);
		expect(preview.affected).toEqual([
			{ id: "M2", n: 1, attemptId: "M2.1" },
			{ id: "M3", n: 1, attemptId: "M3.1" },
		]);
		expect(preview.files).toEqual(["shop/cart.py"]);
		expect(preview.running).toBe(false);
		expect(preview.cutRow).toBe("s:M2.1");
		expect(shownStatus(held, "M2", "M3")).toBe("replaced");
		expect(shownStatus(held, "M2", "M1")).toBe("verified");
		expect(defaultRow(held, "redo", "M2")).toBe("s:M2.1");
	});
});

describe("buildPanel: a live run", () => {
	function working() {
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1").edit("shop/a.py");
		const correction = b.intervene("correct", { moduleId: "M1", note: "Round half up" });
		const note = b.intervene("note", { note: "Keep it small" });
		b.deliver(correction);
		b.test(0, 0, true);
		return { events: b.events, correction, note };
	}

	it("shows the working module, the current action and live tests", () => {
		const { events } = working();
		const panel = panelOf(events, { control: { ...LIVE, pauseAtBoundary: true } });
		expect(panel.live).toBe(true);
		expect(panel.running).toBe(true);
		expect(panel.now.kind).toBe("working");
		expect(panel.now.module?.id).toBe("M1");
		expect(panel.now.action).toMatchObject({ type: "test", object: "pytest", label: "Current action: running pytest" });
		expect(panel.now.next?.id).toBe("M2");
		expect(panel.now.armed).toBe(true);
		expect(panel.now.slot).toMatchObject({ after: "M1", boundary: "after_finish" });
		expect(panel.now.slotLabel).toBe("after M1");
		expect(panel.now.when).toBe("Reaches the agent after its current step (pytest)");
		expect(panel.now.reaches).toBe("after pytest");
		const m1 = panel.byId.M1!;
		expect(m1.status).toBe("working");
		expect(m1.tests).toMatchObject({ live: true, stopped: false });
		expect(m1.actions.at(-1)!.out.at(-1)).toEqual(["h", "  running …"]);
		expect(m1.primary).toBe("correct");
		expect(m1.canCorrect).toBe(true);
		expect(panel.byId.M2!.primary).toBe("change");
		expect(panel.byId.M2!.status).toBe("pending");
		expect(panel.defaultSel).toBe("M1");
		expect(panel.summary).toBeUndefined();
		expect(panel.events.at(-1)?.text).toBe("Run pytest · running");
	});

	it("lists queued notes and puts what you sent into the module's steps and the log", () => {
		const { events, note } = working();
		const panel = panelOf(events, { control: LIVE });
		expect(panel.now.queued).toEqual([
			expect.objectContaining({ interventionId: note, kind: "note", text: "Keep it small" }),
		]);
		const you = panel.byId.M1!.steps.filter((s) => s.kind === "you");
		expect(you.map((s) => (s.kind === "you" ? [s.what, s.text, s.queued] : null))).toEqual([
			["correct", "Round half up", false],
			["note", "Keep it small", true],
		]);
		const rows = panel.events.filter((e) => e.type === "user").map((e) => [e.text, e.mod, e.queued]);
		expect(rows).toEqual([
			["Correction for M1 · by you", "M1", false],
			["Note to agent · by you", "run", true],
		]);
		expect(defaultRow(panel, "correct", "M1")).toBe(panel.events.filter((e) => e.mod === "M1").at(-1)!.id);
		expect(defaultRow(panel, "change", "M2")).toBe("plan:1");
	});

	it("replaying: the same trace with every control hidden", () => {
		const { events } = working();
		const panel = panelOf(events, { control: LIVE, replaying: true });
		expect(panel.live).toBe(false);
		expect(panel.serverHeld).toBe(false);
		expect(panel.now.kind).toBe("working");
		expect(panel.now.armed).toBe(false);
		expect(panel.now.slot).toBeUndefined();
		expect(panel.modules.every((m) => m.primary === null && !m.canChange && !m.canCorrect && !m.canRedo)).toBe(true);
	});

	it("a recorded run without a server session is not live", () => {
		const { events } = working();
		const panel = panelOf(events);
		expect(panel.live).toBe(false);
		expect(panel.byId.M1!.primary).toBeNull();
	});

	it("ticks the run clock and the working module's duration with `now`", () => {
		const { events } = working();
		const later = panelOf(events, { control: LIVE, now: T0 + 90_000 });
		expect(later.now.runClock).toBe("1:30");
		const m1Start = later.byId.M1!.actions[0]!.at - 1000;
		expect(later.byId.M1!.dur).toBe(clock(T0 + 90_000 - m1Start));
	});
});

describe("buildPanel: boundaries, stops and redos", () => {
	it("waiting after a module: decision card, wait timer, held and continued rows", () => {
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1").edit("a.py").test(3).finish("M1").hold("after_finish", "M1");
		const since = b.events.at(-1)!.t;
		const panel = panelOf(b.events, {
			control: { ...LIVE, pending: { boundaryId: "b1", boundary: "after_finish", moduleId: "M1" } },
			now: since + 42_000,
		});
		expect(panel.now.kind).toBe("waiting");
		expect(panel.now.waitClock).toBe("0:42");
		expect(panel.now.module?.id).toBe("M1");
		const d = panel.now.decision!;
		expect(d.after).toBe("M1");
		expect(d.next).toBe("M2");
		expect(d.redo).toEqual({ moduleId: "M1", attemptId: "M1.1" });
		expect(d.what).toMatchObject({ glyph: "verified", mod: "M1", text: "done, tests pass" });
		expect(panel.now.when).toBe("Reaches the agent when it continues to M2");
		expect(panel.now.reaches).toBe("when it continues");
		expect(panel.defaultSel).toBe("M1");
		expect(panel.events.at(-1)?.text).toBe("Held after M1 · waiting for you");

		b.resume();
		const after = panelOf(b.events, { control: LIVE });
		expect(after.now.kind).toBe("starting");
		expect(after.events.map((e) => e.text).slice(-2)).toEqual(["Held after M1", "Continued by you"]);
	});

	it("waiting after the plan and before a module", () => {
		const plan = trace().start().plan(["M1", "M2"]).hold("after_plan");
		const p1 = panelOf(plan.events, { control: LIVE });
		expect(p1.now.decision?.what).toMatchObject({ icon: "plan", text: "Plan v1 · 2 modules" });
		expect(p1.now.decision?.next).toBe("M1");
		const before = trace().start().plan(["M1", "M2"]).hold("before_start", "M1");
		const p2 = panelOf(before.events, { control: LIVE });
		expect(p2.now.decision?.what.text).toBe("About to start M1");
		expect(p2.events.at(-1)?.text).toBe("Held before M1 · waiting for you");
	});

	it("stopped mid-test: stopped status, cut-off action, stop rows", () => {
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1").edit("a.py").test(0, 0, true);
		b.intervene("stop");
		b.end("aborted");
		const panel = panelOf(b.events);
		expect(panel.byId.M1!.status).toBe("stopped");
		const t = panel.byId.M1!.tests!;
		expect(t).toMatchObject({ live: false, stopped: true });
		expect(t.act.out.at(-1)).toEqual(["h", "  stopped by you before pytest finished"]);
		expect(panel.now.kind).toBe("stopped");
		expect(panel.now.module?.id).toBe("M1");
		expect(panel.now.stoppedWhere).toBe("in");
		expect(panel.now.action).toBeUndefined();
		const texts = panel.events.map((e) => e.text);
		expect(texts).toContain("Run pytest · stopped");
		expect(texts.slice(-2)).toEqual(["Stopped by you", "Run stopped"]);
	});

	it("after a redo: replaced attempts stay visible, the module runs again", () => {
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1").edit("a.py").test(2).finish("M1");
		b.begin("M2").edit("b.py").finish("M2");
		b.intervene("revise", { moduleId: "M1", attemptId: "M1.1", note: "wrong rounding" });
		b.invalidate(["M1.1", "M2.1"]).userVersion("M1", 2, "Round half up").begin("M1", 2).read("a.py");
		const panel = panelOf(b.events, { control: LIVE });
		const m1 = panel.byId.M1!;
		expect(m1.status).toBe("working");
		expect(m1.attempts).toEqual([
			{ attemptId: "M1.1", n: 1, status: "invalidated", replaced: true, current: false },
			{ attemptId: "M1.2", n: 2, status: "running", replaced: false, current: true },
		]);
		expect(m1.cur).toMatchObject({ v: 2, by: "you", text: "Round half up" });
		expect(m1.versions.map((v) => v.v)).toEqual([1, 2]);
		expect(m1.actions.map((a) => a.target)).toEqual(["a.py"]);
		expect(panel.byId.M2!.status).toBe("replaced");
		expect(panel.byId.M2!.primary).toBe("change");
		const texts = panel.events.map((e) => e.text);
		expect(texts).toContain("Redo from M1 · by you");
		expect(texts).toContain("Replaced M1 #1, M2 #1");
		expect(texts).toContain("M1 instructions v2 · by you");
		expect(texts).toContain("Start M1 · Module M1 #2");
		expect(panel.events.find((e) => e.id === "s:M1.1")?.current).toBe(false);
		expect(panel.events.find((e) => e.id === "s:M1.2")?.current).toBe(true);
		expect(redoPreview(panel, "M1")?.affected).toEqual([{ id: "M1", n: 2, attemptId: "M1.2" }]);
		expect(redoPreview(panel, "M1")?.running).toBe(true);
	});

	it("unassigned actions after the plan: 'Outside modules', tagged, flagged when they edit", () => {
		const b = trace().start().read("README.md").plan(["M1"]);
		b.begin("M1").edit("a.py").test(1).finish("M1");
		b.edit("stray.py", undefined, null);
		const panel = panelOf(b.events, { control: LIVE });
		expect(panel.pre.title).toBe("Outside modules");
		expect(panel.pre.span).toBeUndefined();
		expect(panel.pre.actions.map((a) => a.where)).toEqual(["before plan", "after M1"]);
		expect(panel.pre.flag).toBe(true);
		expect(panel.pre.flags[0]).toMatchObject({ rule: "unassigned_edit", path: "stray.py" });
		const stray = panel.events.find((e) => e.act?.path === "stray.py")!;
		expect(stray.mod).toBe(PRE);
		expect(stray.flag).toBe(true);
		expect(stray.flags[0]?.rule).toBe("unassigned_edit");
	});

	it("a failing test after the last edit flags that test's row", () => {
		const b = trace().start().plan(["M1"]);
		b.begin("M1").edit("a.py").test(11, 1);
		const panel = panelOf(b.events, { control: LIVE });
		const m1 = panel.byId.M1!;
		expect(m1.tests).toMatchObject({ pass: 11, fail: 1 });
		expect(m1.flags.map((f) => f.rule)).toEqual(["tests_failing"]);
		const row = panel.events.find((e) => e.act?.type === "test")!;
		expect(row.flag).toBe(true);
		expect(m1.actions.at(-1)!.flags.map((f) => f.rule)).toEqual(["tests_failing"]);
		expect(m1.actions.at(-1)!.out.filter(([k]) => k === "f").length).toBe(3);
	});

	it("folds consecutive reads into one step and maps grep to a command", () => {
		const b = trace().start().plan(["M1"]);
		b.begin("M1").read("a.py").read("b.py").act("grep", { pattern: "round" }, { resultPreview: "a.py:1: round" });
		const m1 = panelOf(b.events, { control: LIVE }).byId.M1!;
		expect(m1.steps.map((s) => s.kind)).toEqual(["fold", "act"]);
		const step = m1.steps[1]!;
		expect(step.kind === "act" && step.act).toMatchObject({
			type: "bash",
			target: "grep round",
			call: 'grep(pattern="round")',
		});
		expect(m1.looked).toEqual(["a.py", "b.py"]);
	});

	it("labels pause slots", () => {
		expect(slotLabel({ after: "M3", boundary: "after_finish", moduleId: "M3" })).toBe("after M3");
		expect(slotLabel({ after: null, boundary: "after_plan" })).toBe("after plan");
		expect(slotLabel({ after: "M3", boundary: "before_start", moduleId: "M4" })).toBe("before M4");
	});

	it("while held, the pause slot is the first boundary after Continue", () => {
		const afterM1 = trace().start().plan(["M1", "M2"]);
		afterM1.begin("M1").edit("a.py").finish("M1").hold("after_finish", "M1");
		const p1 = panelOf(afterM1.events, { control: LIVE });
		expect(p1.now.slot).toEqual({ after: "M1", boundary: "before_start", moduleId: "M2" });
		expect(p1.now.slotLabel).toBe("before M2");
		const beforeM1 = trace().start().plan(["M1", "M2"]).hold("before_start", "M1");
		expect(panelOf(beforeM1.events, { control: LIVE }).now.slotLabel).toBe("after M1");
		const plan = trace().start().plan(["M1", "M2"]).hold("after_plan");
		expect(panelOf(plan.events, { control: LIVE }).now.slot).toEqual({
			after: null,
			boundary: "before_start",
			moduleId: "M1",
		});
		// nothing can be armed when the agent cannot act
		expect(panelOf(plan.events).now.slot).toBeUndefined();
	});

	it("a redo after the run ended repeats the audit and run end, with unique row ids", () => {
		const b = trace().start().plan(["M1"]);
		b.begin("M1").edit("a.py").finish("M1").audit(0).end();
		b.intervene("revise", { moduleId: "M1", attemptId: "M1.1" });
		b.invalidate(["M1.1"]).begin("M1", 2).edit("a.py").finish("M1", undefined, 2).audit(0).end();
		const ids = panelOf(b.events, { control: LIVE }).events.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.filter((id) => id.startsWith("run1"))).toHaveLength(2);
	});

	it("the Agent type chip shows the agent's narration only", () => {
		const panel = panelOf(finishedRun());
		const rows = visibleEvents(panel, { ...initialUi(), lf: { mod: "all", type: "agent", flag: false, q: "" } });
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.type === "say")).toBe(true);
	});

	it("a run with no plan yet: starting, everything on the pre station", () => {
		const b = trace().start().read("README.md");
		const panel = panelOf(b.events, { control: LIVE });
		expect(panel.now.kind).toBe("starting");
		expect(panel.modules).toEqual([]);
		expect(panel.plan).toBeUndefined();
		expect(panel.defaultSel).toBe(PRE);
		expect(panel.now.slot).toEqual({ after: null, boundary: "after_plan" });
		expect(panel.now.slotLabel).toBe("after plan");
	});
});

/** Appends a raw event to a trace() builder's events (one second after the previous one). */
function raw(b: ReturnType<typeof trace>, body: TraceEventBody) {
	b.events.push({ ...body, seq: b.events.length, t: T0 + 1000 * b.events.length } as TraceEvent);
	return b;
}

describe("buildPanel: between modules (where the train waits)", () => {
	it("names the gap after the module that ended and the next one, live and in a recording", () => {
		const b = trace().start().plan(["M1", "M2", "M3"]);
		expect(panelOf(b.events, { control: LIVE }).between).toEqual({ after: null, next: "M1" });
		b.begin("M1").edit("a.py").test(1);
		expect(panelOf(b.events, { control: LIVE }).between).toBeUndefined();
		b.finish("M1");
		expect(panelOf(b.events, { control: LIVE }).between).toEqual({ after: "M1", next: "M2" });
		expect(panelOf(b.events).between).toEqual({ after: "M1", next: "M2" });
	});

	it("after the last module it waits at the end of the line, with no next module", () => {
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1").test(1).finish("M1").begin("M2").test(1).finish("M2");
		expect(panelOf(b.events, { control: LIVE }).between).toEqual({ after: "M2" });
		b.end();
		expect(panelOf(b.events).between).toBeUndefined();
	});

	it("after the plan and before the first module starts, the card shows the module about to run", () => {
		const b = trace().start().plan(["M1", "M2"]);
		expect(panelOf(b.events, { control: LIVE }).defaultSel).toBe("M1");
	});

	it("is unset before a plan, while held, and once you stopped the agent", () => {
		expect(panelOf(trace().start().events, { control: LIVE }).between).toBeUndefined();
		const held = trace().start().plan(["M1", "M2"]);
		held.begin("M1").test(1).finish("M1").hold("after_finish", "M1");
		const pending = { boundaryId: "b1", boundary: "after_finish" as const, moduleId: "M1" };
		expect(panelOf(held.events, { control: { ...LIVE, pending } }).between).toBeUndefined();
		const stopped = trace().start().plan(["M1", "M2"]);
		stopped.begin("M1").test(1).finish("M1").intervene("stop");
		expect(panelOf(stopped.events, { control: LIVE }).between).toBeUndefined();
	});
});

describe("buildPanel: the plan overview", () => {
	const WHY = "M1 first; M2 needs it; M3 builds on M2.";
	const held = () =>
		trace()
			.start()
			.read("README.md")
			.plan(["M1", "M2", "M3"], { M2: ["M1"], M3: ["M1", "M2"] }, 1, `  ${WHY}  `)
			.hold("after_plan");

	it("at the hold after the plan: every module in order with its purpose, prerequisites and checks", () => {
		const ov = panelOf(held().events, { control: LIVE }).overview;
		expect(ov?.version).toBe(1);
		expect(ov?.expand).toBe(true);
		expect(ov?.rationale).toBe(WHY);
		expect(ov?.rows.map((r) => r.id)).toEqual(["M1", "M2", "M3"]);
		expect(ov?.rows[2]).toMatchObject({
			title: "Module M3",
			goal: "Purpose of M3",
			status: "pending",
			deps: ["M1", "M2"],
			checks: ["M3 works"],
			canChange: true,
			label: "M3 Module M3, Not started",
			desc: "Needs M1 and M2 · done when: M3 works",
		});
		expect(ov?.rows[0]?.desc).toBe("Done when: M1 works");
		expect(ov?.rows.every((r) => r.yours === undefined)).toBe(true);
	});

	it("shows a Change you made before the module started on its row", () => {
		const b = held().userVersion("M3", 2, "Round half up");
		const rows = panelOf(b.events, { control: LIVE }).overview?.rows;
		expect(rows?.map((r) => r.yours)).toEqual([undefined, undefined, 2]);
		expect(rows?.[2]?.deps).toEqual(["M1", "M2"]);
		expect(rows?.[2]?.desc).toBe("Needs M1 and M2 · done when: M3 works · instructions v2 by you");
	});

	it("opens until a module starts, then stays folded, with live statuses, also once the run ended", () => {
		const b = held().resume();
		expect(panelOf(b.events, { control: LIVE }).overview?.expand).toBe(true);
		b.begin("M1").edit("a.py");
		const working = panelOf(b.events, { control: LIVE }).overview;
		expect(working?.expand).toBe(false);
		expect(working?.rows.map((r) => [r.status, r.canChange])).toEqual([
			["working", false],
			["pending", true],
			["pending", true],
		]);
		b.test(1).finish("M1").end("aborted");
		const stopped = panelOf(b.events, { control: LIVE }).overview;
		expect(stopped?.expand).toBe(false);
		expect(stopped?.rows.map((r) => r.status)).toEqual(["verified", "pending", "pending"]);
		expect(stopped?.rows.some((r) => r.canChange)).toBe(false);
		expect(panelOf(trace().start().read("a.py").events, { control: LIVE }).overview).toBeUndefined();
	});

	it("a re-plan mid-run opens only while held after it, with only the modules not started changeable", () => {
		const b = trace().start().plan(["M1", "M2"]).begin("M1").edit("a.py").test(1).finish("M1");
		b.plan(["M1", "M2", "M3"], {}, 2);
		expect(panelOf(b.events, { control: LIVE }).overview).toMatchObject({ version: 2, expand: false });
		b.hold("after_plan");
		const ov = panelOf(b.events, { control: LIVE }).overview;
		expect(ov?.version).toBe(2);
		expect(ov?.expand).toBe(true);
		expect(ov?.rationale).toBeUndefined();
		expect(ov?.rows.map((r) => [r.id, r.status, r.canChange])).toEqual([
			["M1", "verified", false],
			["M2", "pending", true],
			["M3", "pending", true],
		]);
	});

	it("a re-plan that drops every module that ran does not open it mid-run", () => {
		const b = trace().start().plan(["M1", "M2"]).begin("M1").edit("a.py").test(1).finish("M1");
		b.plan(["M3", "M4"], {}, 2);
		const ov = panelOf(b.events, { control: LIVE }).overview;
		expect(ov?.rows.map((r) => [r.id, r.status])).toEqual([
			["M3", "pending"],
			["M4", "pending"],
		]);
		expect(ov?.expand).toBe(false);
	});

	it("shows only the agent's reason, in both views: a plan a redo restored carries none", () => {
		const b = held();
		const p1 = panelOf(b.events, { control: LIVE });
		const row = (p: typeof p1, v: number) => p.events.find((e) => e.id === `plan:${v}`)?.detail;
		expect(row(p1, 1)).toMatchObject({ kind: "plan", rationale: WHY });
		b.resume().begin("M1").edit("a.py").test(1).finish("M1");
		b.plan(["M1", "M2", "M3"], {}, 2, "Restored the plan from before M1", "user");
		const p2 = panelOf(b.events, { control: LIVE });
		expect(p2.overview?.version).toBe(2);
		expect(p2.overview?.rationale).toBeUndefined();
		expect(row(p2, 2)).toMatchObject({ kind: "plan", rationale: undefined });
		expect(row(p2, 1)).toMatchObject({ kind: "plan", rationale: WHY });
	});

	it("replaying back to the hold: the same overview with nothing to change", () => {
		const ov = panelOf(held().events, { control: LIVE, replaying: true }).overview;
		expect(ov?.rows).toHaveLength(3);
		expect(ov?.rows.some((r) => r.canChange)).toBe(false);
	});
});

describe("buildPanel: review fixes", () => {
	it("the run summary counts files changed outside modules and by modules a re-plan dropped", () => {
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1")
			.edit("a.py")
			.finish("M1", [{ path: "a.py", kind: "diff", patch: "@@ -1 +1 @@\n-x\n+y" }]);
		b.plan(["M2", "M3"], {}, 2);
		raw(b, {
			type: "audit",
			report: {
				missingActions: [],
				unattributedChanges: [{ attemptId: null, path: "gen.txt", patch: "@@ -0,0 +1,2 @@\n+a\n+b" }],
				assignedActions: 1,
				unassignedActions: 0,
			},
		});
		b.end();
		const panel = panelOf(b.events);
		expect(panel.summary?.files).toEqual([
			{ path: "a.py", add: 1, del: 1, by: ["M1"] },
			{ path: "gen.txt", add: 2, del: 0, by: [PRE] },
		]);
		expect(panel.flags.map((f) => f.id)).toContain("unverified:M1.1");
	});

	it("'running' means the agent is streaming, also between modules; not while held", () => {
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1").edit("a.py").test(1).finish("M1");
		expect(panelOf(b.events, { control: LIVE }).running).toBe(true);
		b.hold("before_start", "M2");
		const held = panelOf(b.events, { control: LIVE });
		expect(held.running).toBe(false);
		// held before M2: the held module is selected, not the one before it
		expect(held.defaultSel).toBe("M2");
	});

	it("a correction that reached a replaced attempt stays in the module's steps", () => {
		const b = trace().start().plan(["M1"]);
		b.begin("M1").edit("a.py");
		const id = b.intervene("correct", { moduleId: "M1", note: "Round half up" });
		b.deliver(id).finish("M1");
		b.intervene("revise", { moduleId: "M1", attemptId: "M1.1" });
		b.invalidate(["M1.1"]).begin("M1", 2).read("a.py");
		const you = panelOf(b.events, { control: LIVE }).byId.M1!.steps.find((s) => s.kind === "you");
		expect(you).toMatchObject({ kind: "you", text: "Round half up", attemptN: 1 });
	});

	it("an attempt replaced while it ran stops its duration at the redo", () => {
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1").edit("a.py");
		b.intervene("revise", { moduleId: "M1", attemptId: "M1.1" });
		b.invalidate(["M1.1"]);
		const at = (now: number) => panelOf(b.events, { control: LIVE, now }).byId.M1!.dur;
		expect(at(T0 + 60_000)).toBe(at(T0 + 120_000));
		expect(panelOf(b.events, { control: LIVE }).byId.M1!.tip).toContain("Replaced by redo");
	});

	it("an error names the module that was running, not an earlier failed one", () => {
		const b = trace().start().plan(["M1", "M2", "M3"]);
		b.begin("M1").edit("a.py");
		raw(b, { type: "attempt_ended", attemptId: "M1.1", status: "failed" });
		b.begin("M2").edit("b.py").test(1).finish("M2").begin("M3").edit("c.py").end("error", "Model call failed");
		const now = panelOf(b.events).now;
		expect(now.kind).toBe("error");
		expect(now.module?.id).toBe("M3");
		expect(now.stoppedWhere).toBe("in");
	});

	it("a failed read is never folded", () => {
		const b = trace().start().plan(["M1"]).begin("M1").read("a.py");
		b.act("read", { path: "missing.py" }, { isError: true, resultPreview: "ENOENT" }).read("b.py");
		const m1 = panelOf(b.events, { control: LIVE }).byId.M1!;
		expect(m1.steps.map((s) => s.kind)).toEqual(["act", "act", "act"]);
	});

	it("a call pi rejected names no made-up file", () => {
		const b = trace().start().plan(["M1"]).begin("M1");
		raw(b, {
			type: "action_started",
			action: { actionId: "h1", attemptId: "M1.1", tool: "edit", args: {}, startedAt: T0, source: "host" },
		});
		raw(b, {
			type: "action_ended",
			actionId: "h1",
			isError: true,
			resultPreview: 'Validation failed. Received arguments: {"path": "shop/cart.py", "edits": 3}',
		});
		raw(b, {
			type: "action_started",
			action: { actionId: "h2", attemptId: "M1.1", tool: "write", args: {}, startedAt: T0, source: "host" },
		});
		raw(b, { type: "action_ended", actionId: "h2", isError: true, resultPreview: "Invalid JSON" });
		const acts = panelOf(b.events, { control: LIVE }).byId.M1!.actions;
		expect(acts.map((a) => [a.target, a.call])).toEqual([
			["shop/cart.py", 'edit(path="shop/cart.py")'],
			["(invalid arguments)", "write({})"],
		]);
	});

	it("a finished module keeps the instructions its attempt ran after a re-plan restates it", () => {
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1").edit("a.py").test(1).finish("M1");
		raw(b, {
			type: "plan_version",
			plan: { version: 2, moduleOrder: ["M1", "M2"], author: "agent", createdAt: T0 },
			modules: [modVersion("M1", 2, "done")],
		});
		const m1 = panelOf(b.events, { control: LIVE }).byId.M1!;
		expect(m1.cur).toMatchObject({ v: 1, text: "Do M1" });
		expect(m1.instr).toBe("Do M1");
		expect(m1.versions.map((v) => v.v)).toEqual([1, 2]);
	});

	it("a recorded run whose trace never ended shows as stopped, not working", () => {
		const b = trace().start().plan(["M1", "M2"]).begin("M1").edit("a.py").test(0, 0, true);
		const panel = panelOf(b.events, { control: { ...LIVE, live: false } });
		expect(panel.now.kind).toBe("stopped");
		expect(panel.now.module?.id).toBe("M1");
		expect(panel.now.action).toBeUndefined();
		expect(panel.byId.M1!.status).toBe("stopped");
		expect(panel.byId.M1!.actions.at(-1)).toMatchObject({ live: false, stopped: true });
		expect(panel.summary).toBeDefined();
	});

	it("the automatic pause after the plan shows as armed", () => {
		const b = trace().start().read("README.md");
		const panel = panelOf(b.events, { control: { ...LIVE, pauseAfterPlan: true } });
		expect(panel.now.armed).toBe(true);
		expect(panel.now.slotLabel).toBe("after plan");
	});

	it("a note sent while held that no module took stays with the held module", () => {
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1").edit("a.py").test(1).finish("M1").hold("after_finish", "M1");
		b.intervene("note", { note: "Check rounding" });
		b.intervene("stop");
		b.end("aborted");
		const you = panelOf(b.events).byId.M1!.steps.filter((s) => s.kind === "you");
		expect(you).toEqual([expect.objectContaining({ text: "Check rounding", what: "note" })]);
	});
});

/** An agent version of a module with other instructions (a re-plan's restatement). */
function modVersion(moduleId: string, version: number, instructions: string): ModuleVersion {
	return {
		moduleId,
		version,
		author: "agent",
		createdAt: T0,
		title: `Module ${moduleId}`,
		label: `L${moduleId}`,
		purpose: `Purpose of ${moduleId}`,
		instructions,
		skills: [],
		inputs: [],
		outputs: [],
		dependsOn: [],
		validation: [`${moduleId} works`],
	};
}

describe("UiStore: editors stay true to the run", () => {
	// toasts use window timers; reconcile() reads the focused element
	beforeAll(() => {
		vi.stubGlobal("window", globalThis);
		vi.stubGlobal("document", { activeElement: null });
	});
	afterAll(() => vi.unstubAllGlobals());
	const sent: string[] = [];
	const controls: Controls = {
		armPause: () => true,
		continueRun: () => true,
		change: (id, text) => sent.push(`change ${id} ${text}`) > 0,
		correct: (id, text) => sent.push(`correct ${id} ${text}`) > 0,
		note: (text) => sent.push(`note ${text}`) > 0,
		redo: (id) => sent.push(`redo ${id}`) > 0,
		stop: () => true,
	};
	const ui = (panel: Panel) => {
		const store = new UiStore();
		store.panel = panel;
		store.controls = controls;
		return store;
	};

	it("saving an unchanged Change sends nothing", () => {
		sent.length = 0;
		const b = trace().start().plan(["M1", "M2"]).begin("M1").edit("a.py");
		const store = ui(panelOf(b.events, { control: LIVE }));
		store.openEditor("change", "M2");
		store.saveEditor();
		expect(sent).toEqual([]);
		expect(store.state.editor).toBeNull();
	});

	it("a Change editor whose module started closes into a draft; nothing is sent", () => {
		sent.length = 0;
		const b = trace().start().plan(["M1", "M2"]).begin("M1").edit("a.py");
		const store = ui(panelOf(b.events, { control: LIVE }));
		store.openEditor("change", "M2");
		store.setEditorField("text", "Write it in capitals");
		b.test(1).finish("M1").begin("M2");
		store.panel = panelOf(b.events, { control: LIVE });
		store.saveEditor();
		expect(sent).toEqual([]);
		expect(store.state.editor).toBeNull();
		expect(store.state.drafts["change:M2"]?.text).toBe("Write it in capitals");
	});

	it("sending a redo lets the card follow the agent again, as Continue does", () => {
		sent.length = 0;
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1").edit("a.py").test(1).finish("M1").begin("M2").edit("b.py").test(1).finish("M2");
		const store = ui(panelOf(b.events, { control: LIVE }));
		store.openEditor("redo", "M1");
		expect(store.state.pinned).toBe(true);
		store.redoGo();
		expect(sent).toEqual(["redo M1"]);
		expect(store.state.pinned).toBe(false);
		expect(store.state.sel).toBeNull();
	});

	it("a Redo panel for a module another redo replaced closes; nothing is sent", () => {
		sent.length = 0;
		const b = trace().start().plan(["M1", "M2"]);
		b.begin("M1").edit("a.py").test(1).finish("M1").begin("M2").edit("b.py").test(1).finish("M2");
		const store = ui(panelOf(b.events, { control: LIVE }));
		store.openEditor("redo", "M2");
		b.intervene("revise", { moduleId: "M1", attemptId: "M1.1" });
		b.invalidate(["M1.1", "M2.1"]).begin("M1", 2);
		store.panel = panelOf(b.events, { control: LIVE });
		store.redoGo();
		expect(sent).toEqual([]);
		expect(store.state.editor).toBeNull();
	});

	it("Change from a plan overview row: any module, the card's editor, focus back to the row", () => {
		sent.length = 0;
		const b = trace().start().plan(["M1", "M2", "M3"]).hold("after_plan");
		const store = ui(panelOf(b.events, { control: LIVE }));
		store.openEditor("change", "M3", { opener: "ov-chg-M3" });
		expect(store.state).toMatchObject({ sel: "M3", pinned: true, editor: { kind: "change", id: "M3", text: "Do M3" } });
		expect(editorOn(store.state, "change", "M3")).toBe(true);
		expect(editorOn({ ...store.state, view: "raw" }, "change", "M3")).toBe(false);
		store.setEditorField("text", "Round half up");
		store.saveEditor();
		expect(sent).toEqual(["change M3 Round half up"]);
		expect(store.state.editor).toBeNull();
		expect(store.state.focus).toEqual(["ov-chg-M3", "vchip"]);
	});

	it("a plan overview row selects its module's card and keeps focus; j/k walk the rows", () => {
		const b = trace().start().plan(["M1", "M2", "M3"]).hold("after_plan");
		const store = ui(panelOf(b.events, { control: LIVE }));
		store.selectMod("M2", "ov-M2");
		expect(store.state).toMatchObject({ sel: "M2", pinned: true, focus: ["ov-M2"] });
		const row = (id: string) => ({ closest: (q: string) => (q === ".ovr" ? { dataset: { id } } : null) });
		store.move(1, row("M2") as unknown as Element);
		expect(store.state).toMatchObject({ sel: "M3", focus: ["ov-M3"] });
		store.move(1, row("M3") as unknown as Element);
		expect(store.state.sel).toBe("M3");
		store.move(-1, row("M1") as unknown as Element);
		expect(store.state).toMatchObject({ sel: "M1", focus: ["ov-M1"] });
	});

	it("the plan overview: Continue folds it, the toggle opens it any time, a re-plan hold opens it again", () => {
		const b = trace().start().plan(["M1", "M2"]).hold("after_plan");
		const store = ui(panelOf(b.events, { control: LIVE }));
		// what useUi does after every panel change
		const step = () => {
			store.panel = panelOf(b.events, { control: LIVE });
			store.reconcile();
		};
		const open = () => overviewOpen(store.state, store.panel?.overview);
		store.reconcile();
		expect(open()).toBe(true);
		store.toggleOverview();
		expect(open()).toBe(false);
		expect(store.state.focus).toEqual(["ovtoggle"]);
		store.toggleOverview();
		expect(open()).toBe(true);
		store.continueRun();
		expect(open()).toBe(false);
		// Continued, before M1 starts: still folded; opened in that gap, it stays open when M1 starts
		b.resume();
		step();
		expect(open()).toBe(false);
		store.toggleOverview();
		b.begin("M1").edit("a.py");
		step();
		expect(open()).toBe(true);
		// your choice holds while modules run
		store.toggleOverview();
		b.test(1).finish("M1").begin("M2");
		step();
		expect(open()).toBe(false);
		// a re-plan hold is a new look at the plan: it opens whatever you chose before
		b.plan(["M1", "M2", "M3"], {}, 2).hold("after_plan", undefined, "b2");
		step();
		expect(open()).toBe(true);
	});

	it("Continue at the first hold does not keep the overview folded at a later re-plan hold", () => {
		const b = trace().start().plan(["M1", "M2"]).hold("after_plan");
		const store = ui(panelOf(b.events, { control: LIVE }));
		const step = () => {
			store.panel = panelOf(b.events, { control: LIVE });
			store.reconcile();
		};
		const open = () => overviewOpen(store.state, store.panel?.overview);
		store.reconcile();
		store.continueRun();
		b.resume().begin("M1").edit("a.py").test(1).finish("M1");
		step();
		expect(open()).toBe(false);
		b.plan(["M1", "M2", "M3"], {}, 2).hold("after_plan", undefined, "b2");
		step();
		expect(open()).toBe(true);
	});

	it("j/k on the open overview's header walk its rows", () => {
		const b = trace().start().plan(["M1", "M2", "M3"]).hold("after_plan");
		const store = ui(panelOf(b.events, { control: LIVE }));
		const header = { closest: (q: string) => (q === "#planOv" ? {} : null) } as unknown as Element;
		store.move(1, header);
		// the selection was M1 (the module about to run): the next row, focus on it
		expect(store.state).toMatchObject({ sel: "M2", focus: ["ov-M2"] });
		store.toggleOverview();
		store.move(1, header);
		// folded: j/k move along the line as anywhere else
		expect(store.state).toMatchObject({ sel: "M3", focus: ["st-M3"] });
	});
});
