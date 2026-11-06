/**
 * Home (no run selected): start a run (task, variant, agent, "Pause after plan") and the list of
 * runs (live first) to open for replay. Loads its own data through `api`. Few words, same visual
 * system (`.home`, `.hero`, `.hcard`, `.hrow`, `.rl`/`.rlb` in styles.css); the hero's sunset is
 * decoration, hidden from assistive tech.
 */

import type { AgentKind, RunSummary, ServerInfo, TaskSummary } from "@vcm/protocol";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { GlyphStatus } from "../model/panel.ts";
import { toast } from "../ui/announce.tsx";
import { Icon } from "../ui/icons.tsx";
import { Glyph } from "../ui/primitives.tsx";

/** Props of Home. */
export interface HomeProps {
	/** Open a run (after starting one, or picking one from the list). */
	onOpen: (runId: string) => void;
}

/** How often the runs list refreshes while Home is open (live runs move on, new ones appear). */
const REFRESH_MS = 5000;

/** A run's state on the list: glyph and words (the words are for screen readers and the tooltip). */
function runState(r: RunSummary): { glyph: GlyphStatus; label: string; active: boolean } {
	const active = r.live && (r.status === "running" || r.status === "idle");
	if (active) return { glyph: "working", label: "Working", active };
	switch (r.status) {
		case "paused":
			return r.live ? { glyph: "waiting", label: "Waiting for you", active: true } : stateOf("pending", "Incomplete");
		case "completed":
			return stateOf("end", "Finished");
		case "aborted":
			return stateOf("stopped", "Stopped");
		case "error":
			return stateOf("failed", "Error");
		default:
			return stateOf("pending", "Incomplete");
	}
}

function stateOf(glyph: GlyphStatus, label: string) {
	return { glyph, label, active: false };
}

/** Live runs (still going) first, then the newest first. */
function ordered(runs: readonly RunSummary[]): RunSummary[] {
	return [...runs].sort((a, b) => Number(runState(b).active) - Number(runState(a).active) || b.startedAt - a.startedAt);
}

const when = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The model a run used, in the picker's words (the scripted agent runs on pi's faux provider). */
function agentName(model: string): string {
	return model.startsWith("faux/") ? "Scripted agent" : model;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `<main class="home">`. */
export function Home({ onOpen }: HomeProps) {
	const [tasks, setTasks] = useState<TaskSummary[]>([]);
	const [info, setInfo] = useState<ServerInfo>();
	const [runs, setRuns] = useState<RunSummary[]>();
	const [taskId, setTaskId] = useState("");
	const [variant, setVariant] = useState("");
	const [agent, setAgent] = useState<AgentKind>();
	const [pause, setPause] = useState<boolean>();
	const [starting, setStarting] = useState(false);

	useEffect(() => {
		let alive = true;
		let failed = false;
		const fail = (error: unknown) => {
			if (!alive || failed) return;
			failed = true;
			toast(`Server: ${message(error)}`, { error: true });
		};
		api
			.info()
			.then((v) => alive && setInfo(v))
			.catch(fail);
		api
			.tasks()
			.then((v) => alive && setTasks(v))
			.catch(fail);
		const refresh = () =>
			api
				.runs()
				.then((v) => {
					if (!alive) return;
					failed = false;
					setRuns(ordered(v));
				})
				.catch(fail);
		refresh();
		const id = setInterval(refresh, REFRESH_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, []);

	const modelOk = !!info?.hasApiKey;
	// without an API key, default to a task the scripted agent can run
	const task = tasks.find((t) => t.id === taskId) ?? (modelOk ? undefined : tasks.find((t) => t.scripted)) ?? tasks[0];
	const scriptedOk = !!task?.scripted;
	const usable = (k: AgentKind | undefined) => (k === "model" ? modelOk : k === "scripted" ? scriptedOk : false);
	const agentKind: AgentKind = usable(agent) ? (agent as AgentKind) : !modelOk && scriptedOk ? "scripted" : "model";
	const variantId = task?.variants.includes(variant) ? variant : "";
	const pauseAfterPlan = pause ?? info?.pauseAfterPlan ?? false;
	const canStart = !!task && usable(agentKind) && !starting;

	const start = (e: FormEvent) => {
		e.preventDefault();
		if (!task || !canStart) return;
		setStarting(true);
		api
			.startRun({ taskId: task.id, variant: variantId || undefined, agent: agentKind, pauseAfterPlan })
			.then((run) => onOpen(run.runId))
			.catch((error) => {
				setStarting(false);
				toast(message(error), { error: true });
			});
	};

	return (
		<main id="main" className="home">
			<header className="hero">
				{/* decoration only: the sunset and the moving grid floor */}
				<div className="hero-art" aria-hidden="true">
					<span className="sun" />
					<span className="floor" />
				</div>
				<h1>
					<Icon name="activity" size={28} />
					Module Oversight
				</h1>
			</header>
			<section className="hcard" aria-labelledby="hStart">
				<h2 id="hStart">
					<Icon name="playc" size={16} />
					Start a run
				</h2>
				<form className="hrow" onSubmit={start}>
					<select
						className="field"
						aria-label="Task"
						value={task?.id ?? ""}
						disabled={!tasks.length}
						onChange={(e) => setTaskId(e.currentTarget.value)}
					>
						{tasks.map((t) => (
							<option key={t.id} value={t.id}>
								{t.title}
							</option>
						))}
					</select>
					<select
						className="field"
						aria-label="Variant"
						value={variantId}
						disabled={!task?.variants.length}
						onChange={(e) => setVariant(e.currentTarget.value)}
					>
						<option value="">No variant</option>
						{task?.variants.map((v) => (
							<option key={v} value={v}>
								{v}
							</option>
						))}
					</select>
					<select
						className="field"
						aria-label="Agent"
						aria-describedby={modelOk || !info ? undefined : "keyHint"}
						value={agentKind}
						onChange={(e) => setAgent(e.currentTarget.value as AgentKind)}
					>
						<option value="model" disabled={!modelOk}>
							{info?.model ?? "Model"}
						</option>
						{scriptedOk ? <option value="scripted">Scripted agent</option> : null}
					</select>
					<label className="check">
						<input type="checkbox" checked={pauseAfterPlan} onChange={(e) => setPause(e.currentTarget.checked)} />
						Pause after plan
					</label>
					<button type="submit" className="btn primary" disabled={!canStart}>
						<Icon name="playc" size={16} />
						Start
					</button>
				</form>
				{info && !modelOk ? (
					<div className="hint" id="keyHint">
						No API key: set OPENROUTER_API_KEY in .env
					</div>
				) : null}
			</section>
			<section className="hcard" aria-labelledby="hRuns">
				<h2 id="hRuns">
					<Icon name="history" size={16} />
					Runs
				</h2>
				{runs?.length ? (
					<ul className="rl">
						{runs.map((r) => (
							<RunRow key={r.runId} run={r} title={tasks.find((t) => t.id === r.taskId)?.title} onOpen={onOpen} />
						))}
					</ul>
				) : runs ? (
					<div className="empty">No runs yet</div>
				) : null}
			</section>
		</main>
	);
}

/** One run: state glyph, task (+ variant tag), agent, start time. Opens the run. */
function RunRow({ run, title, onOpen }: { run: RunSummary; title?: string; onOpen: (runId: string) => void }) {
	const st = runState(run);
	return (
		<li>
			{/* one tooltip on the button, so keyboard focus shows it as hover does */}
			<button
				type="button"
				className="rlb"
				data-k={`run-${run.runId}`}
				data-tip={`${st.label} · ${run.runId}`}
				onClick={() => onOpen(run.runId)}
			>
				<span aria-hidden="true">
					<Glyph status={st.glyph} size={16} animate={st.active} />
				</span>
				<span className="nm">
					<span className="sr-only">{st.label}: </span>
					{title ?? run.taskId}
					{run.variant ? (
						<>
							{" "}
							<span className="tag">{run.variant}</span>
						</>
					) : null}
				</span>
				<span className="tm">{agentName(run.model)}</span>
				<span className="tm">{when.format(run.startedAt)}</span>
			</button>
		</li>
	);
}
