/**
 * HTTP + WebSocket server for the inspection UI.
 *
 *   GET  /api/info                configured model, and whether an API key is set
 *   GET  /api/tasks               task list
 *   GET  /api/runs                live and recorded runs
 *   POST /api/runs                StartRunRequest { taskId, variant?, agent?, pauseAfterPlan? } → start a live run
 *   GET  /api/runs/:id/trace      full trace (for replay)
 *   WS   /ws                      ClientMessage in, ServerMessage out
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ClientMessage, ServerInfo, ServerMessage } from "@vcm/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { config, prepareAgentEnvironment } from "./config.ts";
import { demoSessionFactory } from "./demo-agent.ts";
import { RunManager } from "./manager.ts";
import { piSessionFactory } from "./session.ts";

prepareAgentEnvironment();
if (config.provider === "openrouter" && !process.env.OPENROUTER_API_KEY) {
	console.warn(
		"[vcm] OPENROUTER_API_KEY is not set: only the scripted demo agent will work. Copy .env.example to .env.",
	);
}

// Each run picks its agent: the configured model, or the scripted demo agent (paced to be watchable).
const manager = new RunManager(config, { model: piSessionFactory(config), scripted: demoSessionFactory(120, 2500) });

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	try {
		if (req.method === "GET" && url.pathname === "/api/info") {
			const info: ServerInfo = {
				model: `${config.provider}/${config.model}`,
				hasApiKey: config.provider !== "openrouter" || !!process.env.OPENROUTER_API_KEY,
				pauseAfterPlan: config.pauseAfterPlan,
			};
			return json(res, 200, info);
		}
		if (req.method === "GET" && url.pathname === "/api/tasks") return json(res, 200, manager.listTasks());
		if (req.method === "GET" && url.pathname === "/api/runs") return json(res, 200, manager.listRuns());
		if (req.method === "POST" && url.pathname === "/api/runs") {
			const body = await readBody(req);
			const run = await manager.startRun({
				taskId: String(body.taskId),
				variant: body.variant ? String(body.variant) : undefined,
				agent: body.agent === "scripted" ? "scripted" : "model",
				pauseAfterPlan: typeof body.pauseAfterPlan === "boolean" ? body.pauseAfterPlan : undefined,
			});
			return json(res, 201, run.summary());
		}
		const trace = /^\/api\/runs\/([^/]+)\/trace$/.exec(url.pathname);
		if (req.method === "GET" && trace?.[1]) return json(res, 200, manager.trace(decodeURIComponent(trace[1])));
		json(res, 404, { error: "not found" });
	} catch (error) {
		json(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket: WebSocket) => {
	const send = (message: ServerMessage) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(message));
	let unsubscribe: (() => void)[] = [];

	socket.on("message", async (data) => {
		let message: ClientMessage;
		try {
			message = JSON.parse(String(data)) as ClientMessage;
		} catch {
			return send({ type: "error", message: "Malformed message" });
		}
		const run = manager.live(message.runId);
		if (message.type === "subscribe") {
			for (const off of unsubscribe) off();
			unsubscribe = [];
			send({ type: "events", runId: message.runId, events: manager.trace(message.runId) });
			if (run) {
				unsubscribe.push(run.trace.subscribe((event) => send({ type: "events", runId: run.runId, events: [event] })));
				unsubscribe.push(run.onControl((state) => send({ type: "control", state })));
				send({ type: "control", state: run.controlState() });
			} else {
				send({ type: "control", state: { runId: message.runId, live: false, pauseAtBoundary: false, busy: false } });
			}
			return;
		}
		if (!run) return send({ type: "error", message: `Run ${message.runId} is not live` });
		try {
			await run.handle(message);
		} catch (error) {
			send({ type: "error", message: error instanceof Error ? error.message : String(error) });
		}
	});

	socket.on("close", () => {
		for (const off of unsubscribe) off();
	});
});

server.listen(config.port, () => {
	console.log(`[vcm] server on http://localhost:${config.port}  model=${config.provider}/${config.model}`);
	console.log(`[vcm] tasks from ${config.tasksDir}; runs in ${config.runsDir}`);
});
