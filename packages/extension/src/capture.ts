import type { FileChange, TestRun } from "@vcm/protocol";

const PREVIEW_CHARS = 4000;
const ARG_CHARS = 20_000;

type Content = { type: string; text?: string };

/** Terminal colour and cursor codes (e.g. pytest under FORCE_COLOR) are noise in the trace. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

export function contentText(content: readonly Content[]): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** Keeps the head and the tail of long results: pytest and most tools put the summary at the end. */
export function preview(text: string, max = PREVIEW_CHARS): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.4);
	const tail = max - head;
	return `${text.slice(0, head)}\n… (${text.length - max} characters omitted)\n${text.slice(-tail)}`;
}

/** Copies tool arguments for the trace, truncating very large strings (e.g. whole-file writes). */
export function captureArgs(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(input).map(([key, value]) =>
			typeof value === "string" && value.length > ARG_CHARS
				? [key, `${value.slice(0, ARG_CHARS)}\n… (${value.length - ARG_CHARS} more characters)`]
				: [key, value],
		),
	);
}

export function fileChangesFor(toolName: string, input: Record<string, unknown>, details: unknown): FileChange[] {
	const path = typeof input.path === "string" ? input.path : undefined;
	if (!path) return [];
	if (toolName === "edit") {
		const patch = (details as { patch?: unknown } | undefined)?.patch;
		return [{ path, kind: "edit", patch: typeof patch === "string" ? patch : undefined }];
	}
	if (toolName === "write") return [{ path, kind: "write" }];
	return [];
}

/**
 * Failing tests named in Node's output. Node lists each one after its summary as `test at <file>` then
 * `✖ <name>`, so a failing run piped through `tail` (which also hides the exit code) can keep only these;
 * without that list, top-level `✖ <name>` (which may be a suite) or TAP's `not ok N - <name>`.
 */
function nodeFailures(output: string): number | undefined {
	const lines = output.split("\n");
	const listed = lines.filter((line, i) => line.startsWith("✖ ") && lines[i - 1]?.startsWith("test at "));
	const named = listed.length ? listed : lines.filter((line) => /^(?:✖ (?!failing tests:)|not ok \d+ - )/.test(line));
	const names = new Set(
		named.map((line) => line.replace(/^(?:✖ |not ok \d+ - )/, "").replace(/\s*\([\d.]+m?s\)\s*$/, "")),
	);
	return names.size || undefined;
}

/** A failed assertion (Node's assert, or a Python traceback cut off before pytest's summary). */
const ASSERTION = /\b(?:AssertionError|ERR_ASSERTION)\b/;

/**
 * Parses a pytest summary line such as "3 failed, 12 passed, 1 error in 0.52s", or the summary of Node's
 * test runner ("ℹ pass 3" / "ℹ fail 1" / "ℹ cancelled 0", "#" instead of "ℹ" with the TAP reporter).
 * Undefined when a command that succeeded printed no test counts at all: it was not a test run (e.g.
 * `pytest --fixtures`).
 */
export function parseTestRun(command: string, output: string, isError: boolean): TestRun | undefined {
	const last = (pattern: RegExp) => {
		const match = [...output.matchAll(pattern)].at(-1);
		return match ? Number(match[1]) : undefined;
	};
	const count = (word: string) => last(new RegExp(`(\\d+) ${word}`, "g"));
	// Node's summary lines are anchored, so they win over "3 passed" in a test name or a log line
	const node = (word: string) => last(new RegExp(`^(?:ℹ|#) ${word} (\\d+)\\s*$`, "gm"));
	const passed = node("pass") ?? count("passed");
	const failed = node("fail") ?? count("failed") ?? nodeFailures(output);
	const errors = node("cancelled") ?? count("errors?");
	const exit = /exit code[:\s]+(\d+)/i.exec(output);
	if (
		!isError &&
		passed === undefined &&
		failed === undefined &&
		errors === undefined &&
		!/no tests ran/.test(output) &&
		!ASSERTION.test(output)
	) {
		return undefined;
	}
	return {
		command,
		passed,
		failed,
		errors,
		exitCode: exit ? Number(exit[1]) : undefined,
		ok: !isError && (failed ?? 0) === 0 && (errors ?? 0) === 0 && (passed ?? 0) > 0,
	};
}
