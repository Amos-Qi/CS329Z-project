import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind, RunSummary, StartRunRequest, TaskSummary, TraceEvent } from "@vcm/protocol";
import type { Config } from "./config.ts";
import { DEMO_TASK } from "./demo-agent.ts";
import { Run } from "./run.ts";
import type { SessionFactory } from "./session.ts";
import { loadTasks, summarizeTask, type TaskSpec } from "./tasks.ts";
import { readTrace } from "./trace-store.ts";

function timestamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** A run id not used by a live run or a run directory: `<timestamp>-<task>[-<variant>]`, `-2`, `-3`… on a clash. */
function uniqueRunId(base: string, taken: (id: string) => boolean): string {
	let id = base;
	for (let n = 2; taken(id); n++) id = `${base}-${n}`;
	return id;
}

export class RunManager {
	private readonly runs = new Map<string, Run>();
	/** Run ids being created (Run.create is async), so a second start in the same second gets another id. */
	private readonly starting = new Set<string>();
	private readonly config: Config;
	private readonly agents: Partial<Record<AgentKind, SessionFactory>>;

	/** `agents.model` runs the configured model; `agents.scripted` is the scripted demo agent. */
	constructor(config: Config, agents: Partial<Record<AgentKind, SessionFactory>>) {
		this.config = config;
		this.agents = agents;
	}

	tasks(): TaskSpec[] {
		return loadTasks(this.config.tasksDir);
	}

	listTasks(): TaskSummary[] {
		return this.tasks().map((task) => summarizeTask(task, !!this.agents.scripted && task.id === DEMO_TASK));
	}

	async startRun({ taskId, variant: variantId, agent = "model", pauseAfterPlan }: StartRunRequest): Promise<Run> {
		const createSession = this.agents[agent];
		if (!createSession) throw new Error(`No ${agent} agent is configured`);
		const task = this.tasks().find((t) => t.id === taskId);
		if (!task) throw new Error(`Unknown task ${taskId}`);
		const variant = variantId ? task.variants.find((v) => v.id === variantId) : undefined;
		if (variantId && !variant) throw new Error(`Task ${taskId} has no variant ${variantId}`);
		// two starts of the same task within one second must not share a directory, trace and workspace
		const runId = uniqueRunId(
			`${timestamp()}-${task.id}${variant ? `-${variant.id}` : ""}`,
			(id) => this.runs.has(id) || this.starting.has(id) || existsSync(join(this.config.runsDir, id)),
		);
		this.starting.add(runId);
		let run: Run;
		try {
			run = await Run.create({
				runId,
				runDir: join(this.config.runsDir, runId),
				task,
				variant,
				createSession,
				pauseAfterPlan: pauseAfterPlan ?? this.config.pauseAfterPlan,
				gateEdits: this.config.gateEdits,
			});
		} finally {
			this.starting.delete(runId);
		}
		this.runs.set(runId, run);
		run.start();
		return run;
	}

	live(runId: string): Run | undefined {
		return this.runs.get(runId);
	}

	trace(runId: string): TraceEvent[] {
		return this.runs.get(runId)?.trace.events ?? readTrace(join(this.config.runsDir, runId, "trace.jsonl"));
	}

	listRuns(): RunSummary[] {
		const summaries = new Map<string, RunSummary>();
		if (existsSync(this.config.runsDir)) {
			for (const entry of readdirSync(this.config.runsDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const events = readTrace(join(this.config.runsDir, entry.name, "trace.jsonl"));
				const started = events.find((e) => e.type === "run_started");
				if (started?.type !== "run_started") continue;
				const ended = events.findLast((e) => e.type === "run_ended");
				summaries.set(entry.name, {
					runId: entry.name,
					taskId: started.run.taskId,
					variant: started.run.variant,
					model: started.run.model,
					startedAt: started.t,
					live: false,
					status: ended?.type === "run_ended" ? ended.status : "incomplete",
				});
			}
		}
		for (const run of this.runs.values()) summaries.set(run.runId, run.summary());
		return [...summaries.values()].sort((a, b) => b.startedAt - a.startedAt);
	}
}
