import type { ClientMessage, RunControlState, RunSummary, ServerMessage, TaskSummary, TraceEvent } from "@vcm/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const body = await res.json();
	if (!res.ok) throw new Error(body?.error ?? res.statusText);
	return body as T;
}

export const api = {
	tasks: () => getJson<TaskSummary[]>("/api/tasks"),
	runs: () => getJson<RunSummary[]>("/api/runs"),
	startRun: (taskId: string, variant?: string) =>
		getJson<RunSummary>("/api/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ taskId, variant }),
		}),
};

export interface RunConnection {
	events: TraceEvent[];
	control: RunControlState | undefined;
	error: string | undefined;
	connected: boolean;
	send: (message: ClientMessage) => void;
}

/** Subscribes to one run over the WebSocket: full trace first, then live events and control state. */
export function useRun(runId: string | undefined): RunConnection {
	const [events, setEvents] = useState<TraceEvent[]>([]);
	const [control, setControl] = useState<RunControlState>();
	const [error, setError] = useState<string>();
	const [connected, setConnected] = useState(false);
	const socketRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		setEvents([]);
		setControl(undefined);
		setError(undefined);
		if (!runId) return;
		const protocol = location.protocol === "https:" ? "wss" : "ws";
		const socket = new WebSocket(`${protocol}://${location.host}/ws`);
		socketRef.current = socket;
		socket.onopen = () => {
			setConnected(true);
			socket.send(JSON.stringify({ type: "subscribe", runId } satisfies ClientMessage));
		};
		socket.onclose = () => setConnected(false);
		socket.onmessage = (raw) => {
			const message = JSON.parse(String(raw.data)) as ServerMessage;
			if (message.type === "events" && message.runId === runId) {
				setEvents((prev) => {
					const next = prev.slice();
					for (const event of message.events) next[event.seq] = event;
					return next;
				});
			} else if (message.type === "control" && message.state.runId === runId) {
				setControl(message.state);
			} else if (message.type === "error") {
				setError(message.message);
			}
		};
		return () => socket.close();
	}, [runId]);

	const send = useCallback((message: ClientMessage) => {
		setError(undefined);
		socketRef.current?.send(JSON.stringify(message));
	}, []);

	return { events, control, error, connected, send };
}

// TODO: intervention controls (pause, resume, edit, revise, stop) shared by both views; see docs/design.md §6.3.
