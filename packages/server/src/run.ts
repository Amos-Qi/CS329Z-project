/**
 * One agent run on one task: workspace, pi session, modules extension, boundary gate,
 * checkpoints, trace, and the intervention controller (docs/design.md §7).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createModulesExtension } from "@vcm/extension";
import type { ClientMessage, RunControlState, RunSummary } from "@vcm/protocol";
import { BoundaryGate } from "./boundary-gate.ts";
import { Checkpointer } from "./checkpointer.ts";
import type { SessionFactory } from "./session.ts";
import { prepareWorkspace, type TaskSpec, type Variant } from "./tasks.ts";
import { TraceStore } from "./trace-store.ts";

export interface RunOptions {
	runId: string;
	runDir: string;
	task: TaskSpec;
	variant?: Variant;
	createSession: SessionFactory;
}

export class Run {
	readonly runId: string;
	readonly task: TaskSpec;
	readonly variant: Variant | undefined;
	readonly workspace: string;
	readonly trace: TraceStore;
	readonly gate: BoundaryGate;
	readonly checkpointer: Checkpointer;
	readonly startedAt = Date.now();
	model = "";
	private session!: AgentSession;
	private running: Promise<void> | undefined;
	private readonly controlListeners = new Set<(state: RunControlState) => void>();

	private constructor(options: RunOptions, trace: TraceStore) {
		this.runId = options.runId;
		this.task = options.task;
		this.variant = options.variant;
		this.workspace = join(options.runDir, "workspace");
		this.trace = trace;
		this.checkpointer = new Checkpointer(join(options.runDir, "snapshots.git"), this.workspace);
		this.gate = new BoundaryGate((event) => this.trace.append(event));
	}

	static async create(options: RunOptions): Promise<Run> {
		mkdirSync(options.runDir, { recursive: true });
		const trace = new TraceStore(join(options.runDir, "trace.jsonl"));
		const run = new Run(options, trace);
		const extension = createModulesExtension({
			emit: (event) => trace.append(event),
			boundary: (request, signal) => run.gate.wait(request, signal),
			// TODO: checkpoint / diffCheckpoints via run.checkpointer; rewriteToolResult for read_rewrite variants.
		});

		await prepareWorkspace(options.task, options.variant, run.workspace);
		// TODO: await run.checkpointer.init() once it is implemented (baseline snapshot).
		const { session, model } = await options.createSession({
			taskId: options.task.id,
			variant: options.variant?.id,
			workspace: run.workspace,
			agentDir: join(options.runDir, ".pi-agent"),
			sessionDir: join(options.runDir, "session"),
			extension: extension.factory,
		});
		run.session = session;
		run.model = model;
		// TODO: session.subscribe() to archive raw events (raw.jsonl) for the omission audit.
		return run;
	}

	get prompt(): string {
		const base =
			this.variant?.kind === "prompt_override" && this.variant.prompt ? this.variant.prompt : this.task.prompt;
		return `${base.trim()}\n\nThe repository is in the current directory. Run the tests with \`${this.task.testCommand}\`.`;
	}

	start(): void {
		this.trace.append({
			type: "run_started",
			run: {
				runId: this.runId,
				taskId: this.task.id,
				model: this.model,
				variant: this.variant?.id,
				workspace: this.workspace,
			},
			prompt: this.prompt,
		});
		this.running = (async () => {
			let error: string | undefined;
			try {
				await this.session.prompt(this.prompt);
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			// TODO: emit an audit event before run_ended.
			this.trace.append({ type: "run_ended", status: error ? "error" : "completed", error });
			this.running = undefined;
			this.notifyControl();
		})();
		this.notifyControl();
	}

	async handle(message: ClientMessage): Promise<void> {
		switch (message.type) {
			case "subscribe":
				return;
			case "set_pause_at_boundary":
				this.gate.pauseAtBoundary = message.value;
				this.notifyControl();
				return;
			case "stop":
				await this.session.abort();
				return;
			// TODO: resume (gate.decide), edit (new module versions; steer if the module is active),
			// revise (rewind conversation with session.navigateTree + checkpointer.restore, invalidate
			// later attempts, re-prompt). Emit an intervention event for each.
			default:
				throw new Error(`TODO: ${message.type} is not implemented yet`);
		}
	}

	controlState(): RunControlState {
		return {
			runId: this.runId,
			live: true,
			pauseAtBoundary: this.gate.pauseAtBoundary,
			pending: this.gate.current,
			busy: this.running !== undefined,
		};
	}

	onControl(listener: (state: RunControlState) => void): () => void {
		this.controlListeners.add(listener);
		return () => this.controlListeners.delete(listener);
	}

	private notifyControl(): void {
		const state = this.controlState();
		for (const listener of this.controlListeners) listener(state);
	}

	summary(): RunSummary {
		return {
			runId: this.runId,
			taskId: this.task.id,
			variant: this.variant?.id,
			model: this.model,
			startedAt: this.startedAt,
			live: true,
		};
	}

	dispose(): void {
		this.session.dispose();
	}
}
