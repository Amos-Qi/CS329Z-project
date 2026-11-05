import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createFauxSession } from "@vcm/extension/testing";
import { reduceTrace, type TraceEventBody } from "@vcm/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BoundaryGate } from "../src/boundary-gate.ts";
import { Checkpointer } from "../src/checkpointer.ts";
import { Run } from "../src/run.ts";
import type { SessionFactory } from "../src/session.ts";
import { loadTask } from "../src/tasks.ts";

function call(name: string, args: object) {
	return fauxAssistantMessage(fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]), {
		stopReason: "toolUse",
	});
}

const PLAN = {
	rationale: "Two steps.",
	modules: [
		{ title: "Draft", purpose: "Write a draft", instructions: "Write a.txt with v1" },
		{ title: "Finish", purpose: "Write b.txt", instructions: "Write b.txt", dependsOn: ["Draft"] },
	],
};

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function tmp(): string {
	const root = mkdtempSync(join(tmpdir(), "vcm-review-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function toyTask() {
	const root = tmp();
	const taskDir = join(root, "tasks", "toy");
	mkdirSync(join(taskDir, "repo"), { recursive: true });
	writeFileSync(join(taskDir, "repo", "README.md"), "toy\n");
	writeFileSync(
		join(taskDir, "task.yaml"),
		"id: toy\ntitle: Toy\nsplit: dev\nsource:\n  path: repo\nprompt: Write the files.\ntest_command: 'true'\n",
	);
	return { root, task: loadTask(taskDir) };
}

function fauxFactory(responses: FauxResponseStep[]): SessionFactory {
	return async ({ workspace, agentDir, sessionDir, extension }) => {
		const faux = await createFauxSession(extension, responses, { cwd: workspace, agentDir, sessionDir });
		cleanups.push(faux.cleanup);
		return { session: faux.session, model: "faux/faux-1" };
	};
}

function ended(run: Run, count: number): Promise<void> {
	return new Promise((resolve) => {
		const done = () => run.trace.events.filter((e) => e.type === "run_ended").length >= count;
		if (done()) return resolve();
		const off = run.trace.subscribe(() => {
			if (done()) {
				off();
				resolve();
			}
		});
	});
}

/** Holds after M1 (pause armed when M1 starts), re-arms the pause, then stops there. */
async function stoppedAfterM1(rest: FauxResponseStep[]): Promise<Run> {
	const { root, task } = toyTask();
	const run = await Run.create({
		runId: "r",
		runDir: join(root, "runs", "r"),
		task,
		createSession: fauxFactory([
			call("plan_modules", PLAN),
			call("start_module", { id: "M1" }),
			call("write", { path: "a.txt", content: "v1" }),
			call("finish_module", { id: "M1", status: "completed", summary: "Wrote v1." }),
			...rest,
		]),
	});
	let stopped = false;
	run.trace.subscribe((event) => {
		if (event.type === "attempt_started" && event.attempt.attemptId === "M1.1") run.gate.pauseAtBoundary = true;
		if (event.type === "boundary_paused" && !stopped) {
			stopped = true;
			setTimeout(async () => {
				// a change that changes nothing is no intervention
				await run.handle({
					type: "edit",
					runId: run.runId,
					edits: [{ moduleId: "M2", changes: { instructions: "Write b.txt" } }],
				});
				await run.handle({ type: "set_pause_at_boundary", runId: run.runId, value: true });
				await run.handle({ type: "stop", runId: run.runId });
			}, 0);
		}
	});
	run.start();
	await ended(run, 1);
	await run.settled();
	return run;
}

describe("Run: stop and redo", () => {
	it("a redo after a stop completes as completed, with the stop's armed pause gone", async () => {
		const run = await stoppedAfterM1([
			call("start_module", { id: "M1" }),
			call("write", { path: "a.txt", content: "v2" }),
			call("finish_module", { id: "M1", status: "completed", summary: "Wrote v2." }),
			call("start_module", { id: "M2" }),
			call("write", { path: "b.txt", content: "done" }),
			call("finish_module", { id: "M2", status: "completed", summary: "Wrote b." }),
			fauxAssistantMessage(fauxText("Finished.")),
		]);
		expect(reduceTrace(run.trace.events).status).toBe("aborted");
		expect(run.controlState().pauseAtBoundary).toBe(false);

		await run.revise("M1.1", [{ moduleId: "M1", changes: { instructions: "Write a.txt with v2" } }], undefined);
		await ended(run, 2);
		await run.settled();
		const state = reduceTrace(run.trace.events);
		expect(state.status).toBe("completed");
		expect(run.trace.events.filter((e) => e.type === "boundary_paused")).toHaveLength(1);
		expect(readFileSync(join(run.workspace, "a.txt"), "utf8")).toBe("v2");
		expect(state.interventions.map((i) => i.kind)).toEqual(["pause", "stop", "revise"]);

		// M1.1 was replaced: a stale redo panel cannot rewind to it
		await expect(run.revise("M1.1", [], undefined)).rejects.toThrow(/already replaced/);
	});

	it("a stop while a redo is being set up ends the run instead of redoing", async () => {
		const run = await stoppedAfterM1([call("start_module", { id: "M1" })]);
		const redo = run.revise("M1.1", [], undefined);
		void run.stop();
		await redo;
		await run.settled();
		const state = reduceTrace(run.trace.events);
		expect(state.status).toBe("aborted");
		expect(state.attemptOrder).toEqual(["M1.1"]);
		expect(run.trace.events.filter((e) => e.type === "run_ended")).toHaveLength(2);
	});
});

describe("BoundaryGate", () => {
	it("an already aborted agent is stopped, not held forever", async () => {
		const emitted: TraceEventBody[] = [];
		const gate = new BoundaryGate(
			(e) => emitted.push(e),
			() => {},
			true,
		);
		gate.pauseAtBoundary = true;
		const signal = AbortSignal.abort();
		await expect(gate.wait({ boundaryId: "b1", boundary: "after_plan" }, signal)).resolves.toEqual({ action: "stop" });
		expect(emitted).toEqual([]);
		expect(gate.current).toBeUndefined();
	});
});

describe("Checkpointer", () => {
	it("lists both paths of a move and non-ASCII paths as they are", async () => {
		const root = tmp();
		const ws = join(root, "ws");
		mkdirSync(ws);
		writeFileSync(join(ws, "a.py"), "x = 1\n");
		writeFileSync(join(ws, "café.py"), "y = 1\n");
		const cp = new Checkpointer(join(root, "snap.git"), ws);
		const base = await cp.init();
		renameSync(join(ws, "a.py"), join(ws, "b.py"));
		writeFileSync(join(ws, "café.py"), "y = 2\n");
		const next = await cp.snapshot("next");
		const changes = await cp.diff(base, next);
		expect(changes.map((c) => c.path).sort()).toEqual(["a.py", "b.py", "café.py"]);
		expect(changes.find((c) => c.path === "café.py")?.patch).toContain("+y = 2");
		expect(changes.find((c) => c.path === "a.py")?.patch).toContain("deleted file");
	});
});
