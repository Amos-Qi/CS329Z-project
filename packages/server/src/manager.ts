import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunSummary, TaskSummary, TraceEvent } from "@vcm/protocol";
import type { Config } from "./config.ts";
import { Run } from "./run.ts";
import type { SessionFactory } from "./session.ts";
import { loadTasks, summarizeTask, type TaskSpec } from "./tasks.ts";
import { readTrace } from "./trace-store.ts";

function timestamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export class RunManager {
	private readonly runs = new Map<string, Run>();
	private readonly config: Config;
	private readonly createSession: SessionFactory;

	constructor(config: Config, createSession: SessionFactory) {
		this.config = config;
		this.createSession = createSession;
	}

	tasks(): TaskSpec[] {
		return loadTasks(this.config.tasksDir);
	}

	listTasks(): TaskSummary[] {
		return this.tasks().map(summarizeTask);
	}

	async startRun(taskId: string, variantId?: string): Promise<Run> {
		const task = this.tasks().find((t) => t.id === taskId);
		if (!task) throw new Error(`Unknown task ${taskId}`);
		const variant = variantId ? task.variants.find((v) => v.id === variantId) : undefined;
		if (variantId && !variant) throw new Error(`Task ${taskId} has no variant ${variantId}`);
		const runId = `${timestamp()}-${task.id}${variant ? `-${variant.id}` : ""}`;
		const run = await Run.create({
			runId,
			runDir: join(this.config.runsDir, runId),
			task,
			variant,
			createSession: this.createSession,
		});
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
