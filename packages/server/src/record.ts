/**
 * Records one run into runs/ without the UI, then prints protocol compliance (docs/design.md §3),
 * flags, cost and the grade. Use it for the model bake-off (docs/milestone.md) and to make traces
 * for replay.
 *
 *   npm run record -- [--task <id>] [--variant <id>] [--agent model|scripted] [--model <openrouter id>] [--gate] [--json]
 *   npm run demo:record [-- --variant misleading-doc]      the scripted agent (no API key)
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { computeFlags, planModules, reduceTrace, UNASSIGNED } from "@vcm/protocol";
import { config, prepareAgentEnvironment } from "./config.ts";
import { DEMO_TASK, demoSessionFactory } from "./demo-agent.ts";
import { RunManager } from "./manager.ts";
import { piSessionFactory } from "./session.ts";

const { values } = parseArgs({
	options: {
		task: { type: "string", default: DEMO_TASK },
		variant: { type: "string" },
		agent: { type: "string", default: "model" },
		model: { type: "string" },
		json: { type: "boolean", default: false },
		gate: { type: "boolean", default: false },
	},
});
prepareAgentEnvironment();

const agent = values.agent === "scripted" ? "scripted" : "model";
const runConfig = { ...config, model: values.model ?? config.model, gateEdits: values.gate || config.gateEdits };
const manager = new RunManager(runConfig, { model: piSessionFactory(runConfig), scripted: demoSessionFactory(2000) });
const run = await manager.startRun({ taskId: values.task, variant: values.variant, agent, pauseAfterPlan: false });
await new Promise<void>((resolve) => {
	const off = run.trace.subscribe((event) => {
		if (event.type === "run_ended") {
			off();
			resolve();
		}
	});
});
await run.settled();
const state = reduceTrace(run.trace.events);
run.dispose();

const runDir = join(config.runsDir, run.runId);
const stats = existsSync(join(runDir, "stats.json"))
	? JSON.parse(readFileSync(join(runDir, "stats.json"), "utf8"))
	: {};
const unassigned = state.actionsByAttempt[UNASSIGNED]?.length ?? 0;
const beforePlan = (state.actionsByAttempt[UNASSIGNED] ?? []).filter(
	(id) => (state.actionSeq[id] ?? 0) < (state.firstPlanSeq ?? Number.POSITIVE_INFINITY),
).length;
const actions = state.actionOrder.length;
const attempts = state.attemptOrder.length;

let grade: { ok: boolean; hidden?: { passed: number; failed: number; errors: number } } | undefined;
const python = join(config.pythonBin ?? "", "python");
const task = manager.tasks().find((t) => t.id === values.task);
if (task && existsSync(python)) {
	const result = await promisify(execFile)(python, [
		join(config.repoRoot, "tasks", "grade.py"),
		task.dir,
		run.workspace,
		"--json",
	]).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
	try {
		grade = JSON.parse(result.stdout);
	} catch {
		grade = undefined;
	}
}

const record = {
	runId: run.runId,
	task: values.task,
	variant: values.variant,
	model: run.model,
	status: state.status,
	error: state.error,
	modules: planModules(state).length,
	planVersions: state.plans.length,
	attempts,
	actions,
	/**
	 * Share of actions inside a module; actions before the first plan count as orientation, not misses.
	 * null when the agent never planned (nothing could be assigned: the protocol was not followed).
	 */
	assigned:
		state.firstPlanSeq === undefined
			? null
			: actions - beforePlan > 0
				? (actions - unassigned) / (actions - beforePlan)
				: 1,
	unassignedAfterPlan: unassigned - beforePlan,
	meanActionsPerAttempt: attempts ? (actions - unassigned) / attempts : 0,
	flags: computeFlags(state).map((f) => f.text),
	missingActions: state.audit?.missingActions.length ?? 0,
	unattributedChanges: state.audit?.unattributedChanges.length ?? 0,
	tokens: stats.tokens?.total,
	cost: stats.cost,
	minutes: state.endedAt && state.startedAt ? (state.endedAt - state.startedAt) / 60000 : undefined,
	grade: grade ? { ok: grade.ok, hidden: grade.hidden } : undefined,
};

if (values.json) {
	console.log(JSON.stringify(record));
} else {
	const pct = (x: number) => `${Math.round(x * 100)}%`;
	console.log(`Recorded ${run.runId} (${record.model}): ${record.status}${record.error ? ` — ${record.error}` : ""}`);
	console.log(
		`  protocol:  ${record.modules} modules, ${record.planVersions} plan version(s), ${attempts} attempts, ${actions} actions, ` +
			`${record.assigned === null ? "no plan, n/a" : pct(record.assigned)} assigned after the plan, ${record.meanActionsPerAttempt.toFixed(1)} actions/attempt`,
	);
	console.log(`  flags:     ${record.flags.length ? record.flags.join("; ") : "none"}`);
	console.log(
		`  audit:     ${record.missingActions} missing actions, ${record.unattributedChanges} unattributed changes`,
	);
	console.log(
		`  cost:      ${record.tokens ?? "?"} tokens, $${typeof record.cost === "number" ? record.cost.toFixed(3) : "?"}, ${record.minutes?.toFixed(1) ?? "?"} min`,
	);
	if (grade?.hidden) {
		const h = grade.hidden;
		console.log(
			`  grade:     ${grade.ok ? "PASS" : "FAIL"} (hidden ${h.passed} passed, ${h.failed + h.errors} failed)`,
		);
	}
	console.log(`  replay:    open the panel and pick runs/${run.runId}`);
}
