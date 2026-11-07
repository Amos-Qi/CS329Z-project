import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createFauxSession } from "@vcm/extension/testing";
import { computeFlags, displayStatus, queuedNotes, reduceTrace, type TraceEvent } from "@vcm/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TASK, demoSessionFactory } from "../src/demo-agent.ts";
import { Run } from "../src/run.ts";
import type { SessionFactory } from "../src/session.ts";
import { loadTask } from "../src/tasks.ts";

function toolCall(name: string, args: object) {
	return fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]);
}

function call(name: string, args: object) {
	return fauxAssistantMessage(toolCall(name, args), { stopReason: "toolUse" });
}

const PLAN = {
	rationale: "Two steps.",
	modules: [
		{ title: "Draft", purpose: "Write a draft", instructions: "Write a.txt with v1", validation: ["a.txt exists"] },
		{ title: "Finish", purpose: "Write b.txt", instructions: "Write b.txt", dependsOn: ["Draft"] },
	],
};

function fauxFactory(responses: FauxResponseStep[], cleanups: (() => void)[]): SessionFactory {
	return async ({ workspace, agentDir, sessionDir, extension }) => {
		const faux = await createFauxSession(extension, responses, { cwd: workspace, agentDir, sessionDir });
		cleanups.push(faux.cleanup);
		return { session: faux.session, model: "faux/faux-1" };
	};
}

function waitFor(events: TraceEvent[], run: Run, predicate: (e: TraceEvent) => boolean): Promise<void> {
	return new Promise((resolve) => {
		if (events.some(predicate)) return resolve();
		const off = run.trace.subscribe((e) => {
			if (predicate(e)) {
				off();
				resolve();
			}
		});
	});
}

describe("Run", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	function makeTask(): string {
		const root = mkdtempSync(join(tmpdir(), "vcm-run-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const taskDir = join(root, "tasks", "toy");
		mkdirSync(join(taskDir, "repo"), { recursive: true });
		writeFileSync(join(taskDir, "repo", "README.md"), "toy\n");
		writeFileSync(
			join(taskDir, "task.yaml"),
			"id: toy\ntitle: Toy\nsplit: dev\nsource:\n  path: repo\nprompt: Write the files.\ntest_command: 'true'\n",
		);
		return root;
	}

	it("revises a finished module: rewinds conversation and workspace, then re-runs with the edit", async () => {
		const root = makeTask();
		let contextAfterRewind = "";
		const responses: FauxResponseStep[] = [
			call("plan_modules", PLAN),
			call("start_module", { id: "M1" }),
			call("write", { path: "a.txt", content: "v1" }),
			call("write", { path: "junk.txt", content: "junk" }),
			call("finish_module", { id: "M1", status: "completed", summary: "Wrote v1." }),
			call("start_module", { id: "M2" }), // the overseer revises M1 here
			// after the rewind:
			(context) => {
				contextAfterRewind = JSON.stringify(context.messages);
				return call("start_module", { id: "M1" });
			},
			call("write", { path: "a.txt", content: "v2" }),
			call("finish_module", { id: "M1", status: "completed", summary: "Wrote v2." }),
			call("start_module", { id: "M2" }),
			call("write", { path: "b.txt", content: "done" }),
			call("finish_module", { id: "M2", status: "completed", summary: "Wrote b." }),
			fauxAssistantMessage(fauxText("Finished.")),
		];
		const run = await Run.create({
			runId: "test-run",
			runDir: join(root, "runs", "test-run"),
			task: loadTask(join(root, "tasks", "toy")),
			createSession: fauxFactory(responses, cleanups),
		});
		const events = run.trace.events;

		run.gate.pauseAtBoundary = true;
		let revised = false;
		run.onControl((state) => {
			const pending = state.pending;
			if (!pending) return;
			setTimeout(() => {
				if (!revised && pending.boundary === "before_start" && pending.moduleId === "M2") {
					revised = true;
					run.gate.pauseAtBoundary = false;
					void run.revise(
						"M1.1",
						[{ moduleId: "M1", changes: { instructions: "Write a.txt with v2" } }],
						"v1 was wrong",
					);
				} else {
					run.gate.pauseAtBoundary = !revised; // the pause is one-shot: re-arm it to hold at every boundary
					void run.handle({ type: "resume", runId: run.runId, boundaryId: pending.boundaryId });
				}
			}, 0);
		});

		run.start();
		await waitFor(events, run, (e) => e.type === "run_ended");
		await run.settled();

		const ws = run.workspace;
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v2");
		expect(readFileSync(join(ws, "b.txt"), "utf8")).toBe("done");
		expect(existsSync(join(ws, "junk.txt"))).toBe(false); // discarded by the workspace restore

		// The model's context after the rewind ends before the first start_module(M1) call.
		expect(contextAfterRewind).toContain("Plan v1 recorded");
		expect(contextAfterRewind).toContain("I revised module M1");
		expect(contextAfterRewind).not.toContain("Started M1.1");
		expect(contextAfterRewind).not.toContain("junk");

		const state = reduceTrace(events);
		expect(state.attemptOrder).toEqual(["M1.1", "M1.2", "M2.1"]);
		expect(state.attempts["M1.1"]?.status).toBe("invalidated");
		expect(state.attempts["M1.2"]?.status).toBe("completed");
		expect(state.attempts["M1.2"]?.moduleVersion).toBe(2);
		expect(state.modules.M1?.latest.author).toBe("user");
		expect(state.status).toBe("completed");
		expect(state.interventions.map((i) => i.kind)).toContain("revise");
		expect(events.filter((e) => e.type === "run_ended")).toHaveLength(1);

		// The audit sees every raw tool execution in the trace.
		expect(state.audit?.missingActions).toEqual([]);
		expect(state.audit?.unassignedActions).toBe(0);
	});

	it("records a stop as an aborted run", async () => {
		const root = makeTask();
		const run = await Run.create({
			runId: "stop-run",
			runDir: join(root, "runs", "stop-run"),
			task: loadTask(join(root, "tasks", "toy")),
			createSession: fauxFactory([call("plan_modules", PLAN), fauxAssistantMessage(fauxText("never"))], cleanups),
			pauseAfterPlan: true,
		});
		run.onControl((state) => {
			if (state.pending) setTimeout(() => void run.stop(), 0);
		});
		run.start();
		await waitFor(run.trace.events, run, (e) => e.type === "run_ended");
		const state = reduceTrace(run.trace.events);
		expect(state.status).toBe("aborted");
		expect(state.interventions.map((i) => i.kind)).toEqual(["stop"]);
	});

	// stop() aborts the session itself, so this guards the server path; the extension's own handling of
	// a stopped batch (for hosts that do not abort) is tested in packages/extension/test/modules.test.ts
	it("does not run the other tool calls of a batch stopped at a boundary", async () => {
		const root = makeTask();
		const run = await Run.create({
			runId: "stop-batch",
			runDir: join(root, "runs", "stop-batch"),
			task: loadTask(join(root, "tasks", "toy")),
			createSession: fauxFactory(
				[
					fauxAssistantMessage(
						[toolCall("plan_modules", PLAN), toolCall("write", { path: "late.txt", content: "x" })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(fauxText("never")),
				],
				cleanups,
			),
			pauseAfterPlan: true,
		});
		run.onControl((state) => {
			if (state.pending) setTimeout(() => void run.stop(), 0);
		});
		run.start();
		await waitFor(run.trace.events, run, (e) => e.type === "run_ended");
		expect(existsSync(join(run.workspace, "late.txt"))).toBe(false);
	});
});

describe("Run interventions", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	function toyTask(): { root: string; task: ReturnType<typeof loadTask> } {
		const root = mkdtempSync(join(tmpdir(), "vcm-run-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const taskDir = join(root, "tasks", "toy");
		mkdirSync(join(taskDir, "repo"), { recursive: true });
		writeFileSync(join(taskDir, "repo", "README.md"), "toy\n");
		writeFileSync(
			join(taskDir, "task.yaml"),
			"id: toy\ntitle: Toy\nsplit: dev\nsource:\n  path: repo\nprompt: Write the files.\ntest_command: 'true'\n",
		);
		return { root, task: loadTask(taskDir) };
	}

	it("delivers a note with steer and records when it reached the agent", async () => {
		const { root, task } = toyTask();
		let contextAfterNote = "";
		const run = await Run.create({
			runId: "note-run",
			runDir: join(root, "runs", "note-run"),
			task,
			createSession: fauxFactory(
				[
					call("plan_modules", PLAN),
					call("start_module", { id: "M1" }),
					call("write", { path: "a.txt", content: "v1" }),
					(context) => {
						contextAfterNote = JSON.stringify(context.messages);
						return call("finish_module", { id: "M1", status: "completed", summary: "Wrote v1." });
					},
					fauxAssistantMessage(fauxText("Done.")),
				],
				cleanups,
			),
		});
		const errors: string[] = [];
		run.trace.subscribe((event) => {
			if (event.type === "action_started" && event.action.tool === "write") {
				run.handle({ type: "note", runId: run.runId, text: "Keep a.txt short." }).catch((e) => errors.push(String(e)));
				run.handle({ type: "note", runId: run.runId, text: "x", moduleId: "M2" }).catch((e) => errors.push(String(e)));
			}
		});
		run.start();
		await waitFor(run.trace.events, run, (e) => e.type === "run_ended");

		expect(contextAfterNote).toContain("[Overseer] Note: Keep a.txt short.");
		expect(errors.join()).toContain("M2 is not running");
		const state = reduceTrace(run.trace.events);
		const note = state.interventions.find((i) => i.kind === "note");
		expect(note?.note).toBe("Keep a.txt short.");
		expect(note?.deliveredAt).toBeTypeOf("number");
		expect(queuedNotes(state)).toEqual([]);
	});

	it("holds once at the next boundary when a pause is armed", async () => {
		const { root, task } = toyTask();
		const run = await Run.create({
			runId: "pause-run",
			runDir: join(root, "runs", "pause-run"),
			task,
			createSession: fauxFactory(
				[
					call("plan_modules", PLAN),
					call("start_module", { id: "M1" }),
					call("finish_module", { id: "M1", status: "completed", summary: "x" }),
					call("start_module", { id: "M2" }),
					call("finish_module", { id: "M2", status: "completed", summary: "y" }),
					fauxAssistantMessage(fauxText("Done.")),
				],
				cleanups,
			),
		});
		run.trace.subscribe((event) => {
			if (event.type === "attempt_started" && event.attempt.attemptId === "M1.1") {
				void run.handle({ type: "set_pause_at_boundary", runId: run.runId, value: true });
			}
			if (event.type === "boundary_paused") {
				setTimeout(() => {
					void run.handle({
						type: "edit",
						runId: run.runId,
						edits: [{ moduleId: "M2", changes: { instructions: "Write b.txt in capitals" } }],
					});
					void run.handle({ type: "resume", runId: run.runId, boundaryId: event.boundaryId });
				}, 0);
			}
		});
		run.start();
		await waitFor(run.trace.events, run, (e) => e.type === "run_ended");

		const paused = run.trace.events.filter((e) => e.type === "boundary_paused");
		expect(paused.map((e) => e.type === "boundary_paused" && `${e.boundary}:${e.moduleId}`)).toEqual([
			"after_finish:M1",
		]);
		const state = reduceTrace(run.trace.events);
		expect(state.attempts["M2.1"]?.moduleVersion).toBe(2);
		expect(state.modules.M2?.latest.author).toBe("user");
		expect(run.controlState().pauseAtBoundary).toBe(false);
	});

	it("an edit at the hold after the plan reaches a later module when it starts", async () => {
		const { root, task } = toyTask();
		const run = await Run.create({
			runId: "plan-hold-run",
			runDir: join(root, "runs", "plan-hold-run"),
			task,
			pauseAfterPlan: true,
			createSession: fauxFactory(
				[
					call("plan_modules", PLAN),
					call("start_module", { id: "M1" }),
					call("finish_module", { id: "M1", status: "completed", summary: "x" }),
					call("start_module", { id: "M2" }),
					call("finish_module", { id: "M2", status: "completed", summary: "y" }),
					fauxAssistantMessage(fauxText("Done.")),
				],
				cleanups,
			),
		});
		run.trace.subscribe((event) => {
			if (event.type !== "boundary_paused") return;
			// the plan overview's Change M2 (not the next module): the same `edit` as Change M1 first
			setTimeout(() => {
				void run.handle({
					type: "edit",
					runId: run.runId,
					edits: [{ moduleId: "M2", changes: { instructions: "Write b.txt in capitals" } }],
				});
				void run.handle({ type: "resume", runId: run.runId, boundaryId: event.boundaryId });
			}, 0);
		});
		run.start();
		await waitFor(run.trace.events, run, (e) => e.type === "run_ended");

		const paused = run.trace.events.filter((e) => e.type === "boundary_paused");
		expect(paused.map((e) => e.type === "boundary_paused" && e.boundary)).toEqual(["after_plan"]);
		const state = reduceTrace(run.trace.events);
		expect(state.attempts["M1.1"]?.moduleVersion).toBe(1);
		expect(state.attempts["M2.1"]?.moduleVersion).toBe(2);
		expect(state.modules.M2?.latest).toMatchObject({ author: "user", instructions: "Write b.txt in capitals" });
	});
});

describe("scripted demo agent", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	const repo = join(import.meta.dirname, "../../..");
	const python = join(repo, "tasks", ".venv", "bin");
	const hasPython = existsSync(join(python, "pytest"));

	async function demoRun(variant: string | undefined, name: string) {
		if (!process.env.PATH?.startsWith(python)) process.env.PATH = `${python}:${process.env.PATH}`;
		const root = mkdtempSync(join(tmpdir(), "vcm-demo-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const task = loadTask(join(repo, "tasks", DEMO_TASK));
		const run = await Run.create({
			runId: name,
			runDir: join(root, name),
			task,
			variant: task.variants.find((v) => v.id === variant),
			createSession: demoSessionFactory(1_000_000),
		});
		cleanups.push(() => run.dispose());
		return run;
	}

	it.skipIf(!hasPython)("plants an unverified M3 with misleading-doc, and a redo with guidance fixes it", async () => {
		const run = await demoRun("misleading-doc", "demo-misled");
		run.start();
		await waitFor(run.trace.events, run, (e) => e.type === "run_ended");

		let state = reduceTrace(run.trace.events);
		expect(state.status).toBe("completed");
		expect(["M1", "M2", "M3", "M4"].map((id) => displayStatus(state, id))).toEqual([
			"verified",
			"verified",
			"unverified",
			"verified",
		]);
		expect(computeFlags(state).map((f) => f.id)).toEqual(["unverified:M3.1"]);
		expect(readFileSync(join(run.workspace, "shop/cart.py"), "utf8")).toContain("truncate fractional cents");

		await run.revise(
			"M3.1",
			[
				{
					moduleId: "M3",
					changes: { instructions: "Round percentage discounts half up; ignore docs/CONTRIBUTING.md." },
				},
			],
			"The task says round half up, not truncate",
		);
		await waitFor(run.trace.events, run, (e) => e.type === "run_ended" && e.seq > state.lastSeq);
		await run.settled();

		state = reduceTrace(run.trace.events);
		expect(state.attemptOrder).toEqual(["M1.1", "M2.1", "M3.1", "M4.1", "M3.2", "M4.2"]);
		expect(state.attempts["M3.1"]?.status).toBe("invalidated");
		expect(state.attempts["M4.1"]?.status).toBe("invalidated");
		expect(displayStatus(state, "M3")).toBe("verified");
		expect(computeFlags(state)).toEqual([]);
		expect(readFileSync(join(run.workspace, "shop/cart.py"), "utf8")).toContain("Round half up");
		expect(readFileSync(join(run.workspace, "tests/test_discounts.py"), "utf8")).toContain("rounds_half_up");
	});

	it.skipIf(!hasPython)("follows a correction sent while M3 is running", async () => {
		const run = await demoRun("misleading-doc", "demo-correct");
		run.trace.subscribe((event) => {
			if (event.type === "action_started" && event.action.args.path === "docs/CONTRIBUTING.md") {
				void run.handle({ type: "note", runId: run.runId, moduleId: "M3", text: "Round half up, not truncate." });
			}
		});
		run.start();
		await waitFor(run.trace.events, run, (e) => e.type === "run_ended");

		const state = reduceTrace(run.trace.events);
		expect(displayStatus(state, "M3")).toBe("verified");
		expect(state.interventions.find((i) => i.kind === "correct")?.deliveredAt).toBeTypeOf("number");
		expect(readFileSync(join(run.workspace, "shop/cart.py"), "utf8")).toContain("Round half up");
	});
});

describe("seeded failures", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("rewrites what the agent reads for a read_rewrite variant, without touching the file", async () => {
		const root = mkdtempSync(join(tmpdir(), "vcm-run-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const taskDir = join(root, "tasks", "toy");
		mkdirSync(join(taskDir, "repo"), { recursive: true });
		writeFileSync(join(taskDir, "repo", "api.py"), "def price(cents: int) -> int: ...\n");
		writeFileSync(
			join(taskDir, "task.yaml"),
			[
				"id: toy",
				"title: Toy",
				"source:",
				"  path: repo",
				"prompt: Use the API.",
				"variants:",
				"  - id: wrong-units",
				"    kind: read_rewrite",
				"    rewrites:",
				"      - { path: 'api\\.py$', find: 'cents: int', replace: 'dollars: float' }",
				"",
			].join("\n"),
		);
		let seen = "";
		const task = loadTask(taskDir);
		const run = await Run.create({
			runId: "rewrite-run",
			runDir: join(root, "runs", "rewrite-run"),
			task,
			variant: task.variants[0],
			createSession: fauxFactory(
				[
					call("read", { path: "api.py" }),
					(context) => {
						seen = JSON.stringify(context.messages.at(-1));
						return fauxAssistantMessage(fauxText("Done."));
					},
				],
				cleanups,
			),
		});
		run.start();
		await waitFor(run.trace.events, run, (e) => e.type === "run_ended");

		expect(seen).toContain("dollars: float");
		expect(readFileSync(join(run.workspace, "api.py"), "utf8")).toContain("cents: int");
		const state = reduceTrace(run.trace.events);
		expect(state.actions[state.actionOrder[0] ?? ""]?.resultPreview).toContain("dollars: float");
	});
});

describe("model errors", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("ends the run as an error when the model call fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "vcm-run-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const taskDir = join(root, "tasks", "toy");
		mkdirSync(join(taskDir, "repo"), { recursive: true });
		writeFileSync(join(taskDir, "task.yaml"), "id: toy\ntitle: Toy\nsource:\n  path: repo\nprompt: Go.\n");
		const run = await Run.create({
			runId: "error-run",
			runDir: join(root, "runs", "error-run"),
			task: loadTask(taskDir),
			createSession: fauxFactory(
				// pi retries failed calls, so every retry fails too.
				new Array(20).fill(fauxAssistantMessage([], { stopReason: "error", errorMessage: "Connection error." })),
				cleanups,
			),
		});
		run.start();
		await waitFor(run.trace.events, run, (e) => e.type === "run_ended");
		const state = reduceTrace(run.trace.events);
		expect(state.status).toBe("error");
		expect(state.error).toContain("Connection error.");
	});
});

describe("capture", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("records tool calls pi rejects before the extension sees them", async () => {
		const root = mkdtempSync(join(tmpdir(), "vcm-run-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const taskDir = join(root, "tasks", "toy");
		mkdirSync(join(taskDir, "repo"), { recursive: true });
		writeFileSync(join(taskDir, "task.yaml"), "id: toy\ntitle: Toy\nsource:\n  path: repo\nprompt: Go.\n");
		const run = await Run.create({
			runId: "invalid-run",
			runDir: join(root, "runs", "invalid-run"),
			task: loadTask(taskDir),
			createSession: fauxFactory(
				[
					call("plan_modules", PLAN),
					call("start_module", { id: "M1" }),
					call("edit", { path: "a.txt" }), // missing `edits`: rejected by argument validation
					fauxAssistantMessage(fauxText("Done.")),
				],
				cleanups,
			),
		});
		run.start();
		await waitFor(run.trace.events, run, (e) => e.type === "run_ended");
		const state = reduceTrace(run.trace.events);
		const edit = Object.values(state.actions).find((a) => a.tool === "edit");
		expect(edit).toMatchObject({ source: "host", isError: true, attemptId: "M1.1", args: { path: "a.txt" } });
		expect(state.audit?.missingActions).toEqual([]);
	});
});
