import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { TraceEvent, TraceEventBody } from "@vcm/protocol";

/** Append-only trace, persisted as JSONL and broadcast to subscribers. */
export class TraceStore {
	readonly events: TraceEvent[] = [];
	private listeners = new Set<(event: TraceEvent) => void>();
	private readonly file: string | undefined;

	constructor(file?: string) {
		this.file = file;
	}

	append(body: TraceEventBody): TraceEvent {
		const event = { ...body, seq: this.events.length, t: Date.now() } as TraceEvent;
		this.events.push(event);
		if (this.file) appendFileSync(this.file, `${JSON.stringify(event)}\n`);
		for (const listener of this.listeners) listener(event);
		return event;
	}

	subscribe(listener: (event: TraceEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export function readTrace(file: string): TraceEvent[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as TraceEvent);
}
