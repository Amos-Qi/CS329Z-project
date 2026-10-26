import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { TraceEvent, TraceEventBody } from "@vcm/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createModulesExtension } from "../src/index.ts";
import { createFauxSession, type FauxSession } from "../src/testing.ts";

function call(name: string, args: object) {
	return fauxAssistantMessage(fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]), {
		stopReason: "toolUse",
	});
}

describe("modules extension (starter)", () => {
	let ctx: FauxSession | undefined;
	afterEach(() => ctx?.cleanup());

	it("loads into a pi session and exposes the module tools to a scripted agent", async () => {
		const events: TraceEvent[] = [];
		const { factory } = createModulesExtension({
			emit: (body: TraceEventBody) => events.push({ ...body, seq: events.length, t: Date.now() } as TraceEvent),
			boundary: async () => ({ action: "continue" }),
		});
		let firstRequest = "";
		ctx = await createFauxSession(factory, [
			(context) => {
				firstRequest = JSON.stringify(context);
				return call("plan_modules", {
					rationale: "One step.",
					modules: [{ title: "Explore", purpose: "Look around", instructions: "Read files" }],
				});
			},
			call("start_module", { id: "M1" }),
			call("finish_module", { id: "M1", status: "completed", summary: "Looked around." }),
			fauxAssistantMessage(fauxText("Done.")),
		]);

		await ctx.session.prompt("Go.");

		const results = ctx.session.messages.filter((m) => m.role === "toolResult");
		expect(results.map((m) => m.role === "toolResult" && m.toolName)).toEqual([
			"plan_modules",
			"start_module",
			"finish_module",
		]);
		expect(results.every((m) => m.role === "toolResult" && !m.isError)).toBe(true);
		expect(firstRequest).toContain("module_protocol"); // the protocol section reached the model

		// TODO: once the store and hooks are implemented, assert on the trace with reduceTrace(events).
	});
});
