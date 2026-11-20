/**
 * Talking to the server: REST for tasks/runs/info and starting runs, one WebSocket per open run
 * for its trace and control state (packages/server/src/main.ts).
 */

import type {
	ClientMessage,
	RunControlState,
	RunSummary,
	ServerInfo,
	ServerMessage,
	StartRunRequest,
	TaskSummary,
	TraceEvent,
} from "@vcm/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

export type { ServerInfo, StartRunRequest };

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const body = await res.json();
	if (!res.ok) throw new Error(body?.error ?? res.statusText);
	return body as T;
}

export const api = {
	/** GET /api/info: the configured model, whether an API key is set, the pauseAfterPlan default. */
	info: () => getJson<ServerInfo>("/api/info"),
	/** GET /api/tasks */
	tasks: () => getJson<TaskSummary[]>("/api/tasks"),
	/** GET /api/runs: live and recorded runs. */
	runs: () => getJson<RunSummary[]>("/api/runs"),
	/** POST /api/runs: starts a live run; rejects with the server's error message. */
	startRun: (request: StartRunRequest) =>
		getJson<RunSummary>("/api/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		}),
};

/** One open run: its trace so far, the server's control state, and a way to send control messages. */
export interface RunConnection {
	/** Events indexed by seq (may briefly have holes while a batch arrives; filter(Boolean) before reducing). */
	events: TraceEvent[];
	/** Live control state; undefined for recorded runs the server no longer holds. */
	control: RunControlState | undefined;
	/** The latest server error message (cleared when you send a message). */
	error: string | undefined;
	/** Increments with every server error, so the same message twice still toasts twice. */
	errorId: number;
	connected: boolean;
	/** Sends a control message; false (and an error) when not connected. */
	send: (message: ClientMessage) => boolean;
}

/** Reconnect delays after the socket drops (the server restarts under `node --watch`), ms. */
const RECONNECT_MS = [500, 1000, 2000, 4000, 8000];

/**
 * Subscribes to one run over the WebSocket: full trace first, then live events and control state.
 * When the socket drops, the control state is cleared (no controls, no ticking clock: nothing can be
 * sent) and it reconnects with backoff; the server then sends the full trace and control state again.
 */
export function useRun(runId: string | undefined): RunConnection {
	const [events, setEvents] = useState<TraceEvent[]>([]);
	const [control, setControl] = useState<RunControlState>();
	const [error, setError] = useState<string>();
	const [errorId, setErrorId] = useState(0);
	const [connected, setConnected] = useState(false);
	const socketRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		setEvents([]);
		setControl(undefined);
		setError(undefined);
		if (!runId) return;
		const protocol = location.protocol === "https:" ? "wss" : "ws";
		let closed = false;
		let attempt = 0;
		let timer = 0;
		const connect = () => {
			const socket = new WebSocket(`${protocol}://${location.host}/ws`);
			socketRef.current = socket;
			socket.onopen = () => {
				attempt = 0;
				setConnected(true);
				socket.send(JSON.stringify({ type: "subscribe", runId } satisfies ClientMessage));
			};
			socket.onclose = () => {
				if (socketRef.current === socket) socketRef.current = null;
				setConnected(false);
				// the server may hold the run no longer (or anything else may have changed): nothing is live until it says so
				setControl(undefined);
				if (closed) return;
				timer = window.setTimeout(connect, RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)]);
			};
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
					setErrorId((n) => n + 1);
				}
			};
		};
		connect();
		return () => {
			closed = true;
			clearTimeout(timer);
			socketRef.current?.close();
		};
	}, [runId]);

	const send = useCallback((message: ClientMessage): boolean => {
		setError(undefined);
		const socket = socketRef.current;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			setError("Not connected to the server");
			setErrorId((n) => n + 1);
			return false;
		}
		socket.send(JSON.stringify(message));
		return true;
	}, []);

	return { events, control, error, errorId, connected, send };
}
