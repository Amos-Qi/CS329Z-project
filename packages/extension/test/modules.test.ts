import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { reduceTrace, type TraceEvent, type TraceEventBody } from "@vcm/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryDecision, type BoundaryRequest, createModulesExtension } from "../src/index.ts";
import { createFauxSession, type FauxSession } from "../src/testing.ts";

function call(name: string, args: object) {
	return fauxAssistantMessage(fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]), {
		stopReason: "toolUse",
	});
}

const PLAN = {
	rationale: "Explore first, then implement.",
	modules: [
		{
			title: "Explore",
			purpose: "Find where greetings live",
			instructions: "Read greet.txt",
			validation: ["Know the current greeting"],
		},
		{
			title: "Implement",
			purpose: "Write the new greeting",
			instructions: "Write hello.txt",
			dependsOn: ["Explore"],
			validation: ["hello.txt exists"],
		},
	],
};

describe("modules extension", () => {
	let ctx: FauxSession | undefined;
	afterEach(() => ctx?.cleanup());

	it("records plan, attempts and attributed actions, and applies user edits at a boundary", async () => {
		const events: TraceEvent[] = [];
		const boundaries: BoundaryRequest[] = [];
		const { factory } = createModulesExtension({
			emit: (body: TraceEventBody) => events.push({ ...body, seq: events.length, t: Date.now() } as TraceEvent),
			async boundary(request): Promise<BoundaryDecision> {
				boundaries.push(request);
				if (request.boundary === "before_start" && request.moduleId === "M2") {
					return {
						action: "continue",
						edits: [{ moduleId: "M2", changes: { instructions: "Write hello.txt containing exactly 'hi'" } }],
						note: "keep it short",
					};
				}
				return { action: "continue" };
			},
		});

		ctx = await createFauxSession(factory, [
			call("plan_modules", PLAN),
			call("start_module", { id: "M1" }),
			call("read", { path: "greet.txt" }),
			call("finish_module", {
				id: "M1",
				status: "completed",
				summary: "Greeting is 'hello'.",
				validation: [{ criterion: "Know the current greeting", met: true }],
			}),
			call("start_module", { id: "M2" }),
			call("write", { path: "hello.txt", content: "hi" }),
			call("finish_module", { id: "M2", status: "completed", summary: "Wrote hello.txt." }),
			fauxAssistantMessage(fauxText("All done.")),
		]);
		writeFileSync(join(ctx.dir, "greet.txt"), "hello\n");

		await ctx.session.prompt("Change the greeting.");

		expect(readFileSync(join(ctx.dir, "hello.txt"), "utf8")).toBe("hi");
		expect(boundaries.map((b) => `${b.boundary}:${b.moduleId ?? ""}`)).toEqual([
			"after_plan:",
			"before_start:M1",
			"after_finish:M1",
			"before_start:M2",
			"after_finish:M2",
		]);

		const state = reduceTrace(events);
		expect(state.moduleOrder).toEqual(["M1", "M2"]);
		expect(state.modules.M2?.latest.dependsOn).toEqual(["M1"]);
		expect(state.modules.M2?.latest.author).toBe("user");
		expect(state.modules.M2?.versions).toHaveLength(2);
		expect(state.attemptOrder).toEqual(["M1.1", "M2.1"]);
		expect(state.attempts["M2.1"]?.moduleVersion).toBe(2);
		expect(state.modules.M1?.status).toBe("completed");
		expect(state.modules.M2?.status).toBe("completed");

		const [readAction, writeAction] = state.actionOrder.map((id) => state.actions[id]);
		expect(readAction?.tool).toBe("read");
		expect(readAction?.attemptId).toBe("M1.1");
		expect(writeAction?.tool).toBe("write");
		expect(writeAction?.attemptId).toBe("M2.1");
		expect(writeAction?.fileChanges).toEqual([{ path: "hello.txt", kind: "write" }]);
		expect(state.actionsByAttempt.unassigned).toEqual([]);
		expect(state.narration.at(-1)?.text).toBe("All done.");

		// The edited instructions and the note reached the agent through start_module's result.
		const startResult = ctx.session.messages.find(
			(m) => m.role === "toolResult" && m.toolName === "start_module" && JSON.stringify(m.content).includes("M2.1"),
		);
		expect(JSON.stringify(startResult)).toContain("exactly 'hi'");
		expect(JSON.stringify(startResult)).toContain("keep it short");
	});

	it("records actions outside a module as unassigned and reminds the agent", async () => {
		const events: TraceEvent[] = [];
		const { factory } = createModulesExtension({
			emit: (body) => events.push({ ...body, seq: events.length, t: Date.now() } as TraceEvent),
			boundary: async () => ({ action: "continue" }),
		});
		ctx = await createFauxSession(factory, [
			call("plan_modules", PLAN),
			call("write", { path: "stray.txt", content: "x" }),
			fauxAssistantMessage(fauxText("Oops.")),
		]);

		await ctx.session.prompt("Go.");

		const state = reduceTrace(events);
		expect(state.actionsByAttempt.unassigned).toHaveLength(1);
		const result = ctx.session.messages.find((m) => m.role === "toolResult" && m.toolName === "write");
		expect(JSON.stringify(result)).toContain("recorded as unassigned");
	});

	it("rejects starting a second module while one is active", async () => {
		const events: TraceEvent[] = [];
		const { factory } = createModulesExtension({
			emit: (body) => events.push({ ...body, seq: events.length, t: Date.now() } as TraceEvent),
			boundary: async () => ({ action: "continue" }),
		});
		ctx = await createFauxSession(factory, [
			call("plan_modules", PLAN),
			call("start_module", { id: "M1" }),
			call("start_module", { id: "M2" }),
			fauxAssistantMessage(fauxText("Stopping.")),
		]);

		await ctx.session.prompt("Go.");

		const results = ctx.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "start_module");
		expect(results).toHaveLength(2);
		expect(results[1] && "isError" in results[1] && results[1].isError).toBe(true);
		expect(JSON.stringify(results[1])).toContain("M1 is still active");
		expect(reduceTrace(events).attemptOrder).toEqual(["M1.1"]);
	});
	it("reminds about changes before the plan and made with shell commands", async () => {
		const events: TraceEvent[] = [];
		const { factory } = createModulesExtension({
			emit: (body) => events.push({ ...body, seq: events.length, t: Date.now() } as TraceEvent),
			boundary: async () => ({ action: "continue" }),
		});
		ctx = await createFauxSession(factory, [
			call("bash", { command: "ls" }),
			call("write", { path: "early.txt", content: "x" }),
			call("plan_modules", PLAN),
			call("start_module", { id: "M1" }),
			call("bash", { command: "cat > a.txt <<'E'\nhi\nE" }),
			call("bash", { command: "python -m pytest -q" }),
			fauxAssistantMessage(fauxText("Stop.")),
		]);
		await ctx.session.prompt("Go.");

		const results = ctx.session.messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify(m));
		expect(results[0]).not.toContain("[modules]");
		expect(results[1]).toContain("there is no module plan yet");
		expect(results[4]).toContain("not with shell commands");
		expect(results[5]).not.toContain("[modules]");
		const state = reduceTrace(events);
		expect(state.actions[state.actionOrder[3] ?? ""]?.isTest).toBe(true);
	});

	it("blocks edits outside a module when the gate is on", async () => {
		const events: TraceEvent[] = [];
		const { factory } = createModulesExtension(
			{
				emit: (body) => events.push({ ...body, seq: events.length, t: Date.now() } as TraceEvent),
				boundary: async () => ({ action: "continue" }),
			},
			{ gateEdits: true },
		);
		ctx = await createFauxSession(factory, [
			call("write", { path: "early.txt", content: "x" }),
			fauxAssistantMessage(fauxText("Stop.")),
		]);
		await ctx.session.prompt("Go.");

		const result = ctx.session.messages.find((m) => m.role === "toolResult");
		expect(result && "isError" in result && result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("Blocked: no module is active");
		expect(existsSync(join(ctx.dir, "early.txt"))).toBe(false);
	});

	describe("a boundary that stops the run", () => {
		// what the model would do next if the run went on after the stop
		const AFTER = call("write", { path: "after.txt", content: "x" });

		function batch(...calls: ReturnType<typeof fauxToolCall>[]) {
			return fauxAssistantMessage(calls, { stopReason: "toolUse" });
		}

		/** A host that does not abort the session itself on stop (the stock CLI, or one embedded in the TUI). */
		function stoppingHost(stopAt: (request: BoundaryRequest) => boolean, onHold?: () => Promise<void>) {
			const events: TraceEvent[] = [];
			const boundaries: BoundaryRequest[] = [];
			const { factory } = createModulesExtension({
				emit: (body) => events.push({ ...body, seq: events.length, t: Date.now() } as TraceEvent),
				async boundary(request) {
					boundaries.push(request);
					if (!stopAt(request)) return { action: "continue" };
					await onHold?.();
					return { action: "stop" };
				},
			});
			return { factory, events, boundaries };
		}

		/** Text or tool calls from the model after its first `n` messages. */
		function actedAfter(session: FauxSession["session"], n: number) {
			return session.messages
				.filter((m) => m.role === "assistant")
				.slice(n)
				.flatMap((m) => (m as { content?: { type: string }[] }).content ?? [])
				.filter((block) => block.type === "text" || block.type === "toolCall");
		}

		it("blocks the rest of the batch and asks the model nothing more", async () => {
			const host = stoppingHost((r) => r.boundary === "before_start");
			ctx = await createFauxSession(host.factory, [
				call("plan_modules", PLAN),
				batch(fauxToolCall("start_module", { id: "M1" }), fauxToolCall("write", { path: "late.txt", content: "x" })),
				AFTER,
			]);
			await ctx.session.prompt("Go.");

			expect(existsSync(join(ctx.dir, "late.txt"))).toBe(false);
			expect(existsSync(join(ctx.dir, "after.txt"))).toBe(false);
			expect(actedAfter(ctx.session, 2)).toEqual([]);
			expect(reduceTrace(host.events).actionOrder).toHaveLength(0);
		});

		it("ends the run when a call before the boundary already ran", async () => {
			const host = stoppingHost((r) => r.boundary === "after_finish");
			ctx = await createFauxSession(host.factory, [
				call("plan_modules", PLAN),
				call("start_module", { id: "M1" }),
				batch(
					fauxToolCall("write", { path: "early.txt", content: "x" }),
					fauxToolCall("finish_module", { id: "M1", status: "completed", summary: "x" }),
				),
				AFTER,
			]);
			await ctx.session.prompt("Go.");

			expect(existsSync(join(ctx.dir, "early.txt"))).toBe(true);
			expect(existsSync(join(ctx.dir, "after.txt"))).toBe(false);
			expect(actedAfter(ctx.session, 3)).toEqual([]);
		});

		it("ends the run when pi rejects a call in the batch", async () => {
			const host = stoppingHost((r) => r.boundary === "before_start");
			ctx = await createFauxSession(host.factory, [
				call("plan_modules", PLAN),
				batch(fauxToolCall("start_module", { id: "M1" }), fauxToolCall("write", { path: "no-content.txt" })),
				AFTER,
			]);
			await ctx.session.prompt("Go.");

			expect(existsSync(join(ctx.dir, "after.txt"))).toBe(false);
			expect(actedAfter(ctx.session, 2)).toEqual([]);
		});

		it("does not start the next module in the same batch", async () => {
			const host = stoppingHost((r) => r.boundary === "after_finish");
			ctx = await createFauxSession(host.factory, [
				call("plan_modules", PLAN),
				call("start_module", { id: "M1" }),
				batch(
					fauxToolCall("finish_module", { id: "M1", status: "completed", summary: "x" }),
					fauxToolCall("start_module", { id: "M2" }),
				),
				AFTER,
			]);
			await ctx.session.prompt("Go.");

			expect(host.boundaries.map((b) => `${b.boundary}:${b.moduleId ?? ""}`)).toEqual([
				"after_plan:",
				"before_start:M1",
				"after_finish:M1",
			]);
			expect(reduceTrace(host.events).attemptOrder).toEqual(["M1.1"]);
		});

		it("ends the run when a message was queued while the boundary was held", async () => {
			const host = stoppingHost(
				(r) => r.boundary === "before_start",
				async () => {
					await ctx?.session.steer("[Overseer] Note: also check the docs");
				},
			);
			ctx = await createFauxSession(host.factory, [
				call("plan_modules", PLAN),
				call("start_module", { id: "M1" }),
				AFTER,
			]);
			await ctx.session.prompt("Go.");

			expect(existsSync(join(ctx.dir, "after.txt"))).toBe(false);
			expect(actedAfter(ctx.session, 2)).toEqual([]);
		});

		it("runs again normally after the stop", async () => {
			let stops = 1;
			const host = stoppingHost((r) => r.boundary === "before_start" && stops-- > 0);
			ctx = await createFauxSession(host.factory, [
				call("plan_modules", PLAN),
				batch(fauxToolCall("start_module", { id: "M1" }), fauxToolCall("write", { path: "late.txt", content: "x" })),
				call("start_module", { id: "M1" }),
				call("write", { path: "again.txt", content: "y" }),
				fauxAssistantMessage(fauxText("Done.")),
			]);
			await ctx.session.prompt("Go.");
			await ctx.session.prompt("Continue.");

			expect(existsSync(join(ctx.dir, "late.txt"))).toBe(false);
			expect(readFileSync(join(ctx.dir, "again.txt"), "utf8")).toBe("y");
		});
	});
});
