import { type RunSummary, reduceTrace, type TaskSummary, type TraceEvent } from "@vcm/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, useRun } from "./api.ts";

type View = "modular" | "log";

/** URL parameters: ?run=<id>&view=modular|log */
function useUrlState() {
	const params = new URLSearchParams(location.search);
	const [runId, setRunIdState] = useState(params.get("run") ?? undefined);
	const [view, setViewState] = useState<View>(params.get("view") === "log" ? "log" : "modular");
	const update = (key: string, value: string | undefined) => {
		const next = new URLSearchParams(location.search);
		if (value) next.set(key, value);
		else next.delete(key);
		history.replaceState(null, "", `?${next}`);
	};
	return {
		runId,
		setRunId: (id: string | undefined) => {
			setRunIdState(id);
			update("run", id);
		},
		view,
		setView: (v: View) => {
			setViewState(v);
			update("view", v);
		},
	};
}

/** Treatment condition. TODO: Metro line + module card + evidence (docs/design.md §6.1, design/mockups/panel.html). */
function ModularView() {
	return <div className="empty">TODO: modular view (Metro line, module card, evidence). See docs/design.md §6.1.</div>;
}

/** Baseline condition. TODO: searchable, filterable log with the same controls (docs/design.md §6.2). */
function LogView({ events }: { events: TraceEvent[] }) {
	return (
		<table className="log">
			<tbody>
				{events.map((event) => (
					<tr key={event.seq}>
						<td className="mono muted">{event.seq}</td>
						<td className="mono">{event.type}</td>
						<td className="mono small">{JSON.stringify(event).slice(0, 200)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

export function App() {
	const url = useUrlState();
	const [tasks, setTasks] = useState<TaskSummary[]>([]);
	const [runs, setRuns] = useState<RunSummary[]>([]);
	const [taskId, setTaskId] = useState("");
	const [startError, setStartError] = useState<string>();

	const refresh = useCallback(() => {
		api
			.tasks()
			.then(setTasks)
			.catch(() => {});
		api
			.runs()
			.then(setRuns)
			.catch(() => {});
	}, []);
	useEffect(() => refresh(), [refresh]);

	const connection = useRun(url.runId);
	const events = useMemo(() => connection.events.filter(Boolean), [connection.events]);
	const state = useMemo(() => reduceTrace(events), [events]);

	const startRun = async () => {
		setStartError(undefined);
		try {
			const run = await api.startRun(taskId);
			url.setRunId(run.runId);
			refresh();
		} catch (error) {
			setStartError(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<div className="app">
			<header className="topbar">
				<strong>Module Oversight</strong>
				<select value={url.runId ?? ""} onChange={(e) => url.setRunId(e.target.value || undefined)} onFocus={refresh}>
					<option value="">Select a run…</option>
					{runs.map((r) => (
						<option key={r.runId} value={r.runId}>
							{r.runId} {r.live ? "● live" : ""} {r.status ? `(${r.status})` : ""}
						</option>
					))}
				</select>
				<select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
					<option value="">Task…</option>
					{tasks.map((t) => (
						<option key={t.id} value={t.id}>
							{t.id} [{t.split}]
						</option>
					))}
				</select>
				<button type="button" disabled={!taskId} onClick={startRun}>
					Start run
				</button>
				<span className="spacer" />
				<button type="button" className={url.view === "modular" ? "on" : ""} onClick={() => url.setView("modular")}>
					Modules
				</button>
				<button type="button" className={url.view === "log" ? "on" : ""} onClick={() => url.setView("log")}>
					Log
				</button>
			</header>
			{(startError || connection.error) && <div className="error">{startError ?? connection.error}</div>}
			{url.runId ? (
				<>
					<div className="statusline">
						Task: {state.run?.taskId ?? "…"} · Run: {state.status} · {events.length} events
						{/* TODO: the shared Now bar (state, active module, flags, pause, note, stop; decision card when waiting) and replay scrubber (docs/design.md §6) */}
					</div>
					<main>{url.view === "modular" ? <ModularView /> : <LogView events={events} />}</main>
				</>
			) : (
				<div className="empty">Select a recorded run or start a new one.</div>
			)}
		</div>
	);
}
