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
 * Parses a pytest summary line such as "3 failed, 12 passed, 1 error in 0.52s". Undefined when a
 * command that succeeded printed no test counts at all: it was not a test run (e.g. `pytest --fixtures`).
 */
export function parseTestRun(command: string, output: string, isError: boolean): TestRun | undefined {
	const count = (word: string) => {
		const matches = [...output.matchAll(new RegExp(`(\\d+) ${word}`, "g"))];
		const last = matches.at(-1);
		return last ? Number(last[1]) : undefined;
	};
	const passed = count("passed");
	const failed = count("failed");
	const errors = count("errors?");
	const exit = /exit code[:\s]+(\d+)/i.exec(output);
	if (
		!isError &&
		passed === undefined &&
		failed === undefined &&
		errors === undefined &&
		!/no tests ran/.test(output)
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
