/**
 * Small, pure formatting helpers shared by the view model (model/panel.ts) and the components.
 * Nothing here knows about React or the DOM.
 */

/**
 * One line of a code block, as the mockup draws it: `[kind, text]`.
 * - `h` hunk header / note (muted), `c` context or plain output, `a` added, `d` deleted,
 * - `o` passing test output (green), `f` failure line (red), `hi` highlighted line.
 */
export type LineKind = "h" | "c" | "a" | "d" | "o" | "f" | "hi";
export type CodeLine = [LineKind, string];

/** `m:ss` for a duration in milliseconds (negative and non-finite values count as 0). Minutes are not capped. */
export function clock(ms: number): string {
	const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Parses `m:ss` back into seconds (the inverse of `clock`, for sorting and tests). */
export function seconds(text: string): number {
	const [m = "0", s = "0"] = text.split(":");
	return Number(m) * 60 + Number(s);
}

/** The last path segment: `shop/cart.py` → `cart.py`. */
export function basename(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts.at(-1) ?? path;
}

/** Collapses whitespace to one line and clips it to `max` characters with an ellipsis. */
export function oneLine(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The first line of a (possibly multi-line) text, trimmed. */
export function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.find((l) => l.trim())
			?.trim() ?? ""
	);
}

/** Number of lines in a text (a trailing newline does not count as an extra line). */
export function lineCount(text: string | undefined): number {
	if (!text) return 0;
	const lines = text.split("\n");
	return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/**
 * The program a shell command runs, for the Now bar and step targets:
 * `python -m pytest -q` → `pytest`, `FOO=1 npm test` → `npm`, `cd x && make` → `cd`.
 */
export function commandName(command: string): string {
	const words = command.trim().split(/\s+/);
	let i = 0;
	while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
	const first = words[i] ?? "";
	if (/^python[0-9.]*$/.test(first) && words[i + 1] === "-m" && words[i + 2]) return words[i + 2] as string;
	if ((first === "npx" || first === "uv" || first === "poetry") && words[i + 1]) {
		const next = words[i + 1] === "run" ? words[i + 2] : words[i + 1];
		if (next) return next;
	}
	return basename(first) || command.trim();
}

/** Joins ids for a sentence: `["M2"]` → `M2`, `["M2","M3"]` → `M2 and M3`, three → `M1, M2 and M3`. */
export function joinAnd(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** `1 flag` / `2 flags`. */
export function plural(n: number, word: string, many = `${word}s`): string {
	return `${n} ${n === 1 ? word : many}`;
}

/**
 * A unified diff as code lines. File headers (`---`/`+++`, `diff --git`, `index`) are dropped;
 * `@@` hunks become `h`, `+` → `a`, `-` → `d`, everything else is context `c`.
 */
export function parsePatch(patch: string | undefined): CodeLine[] {
	if (!patch) return [];
	const out: CodeLine[] = [];
	for (const line of patch.replace(/\n$/, "").split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file mode")) continue;
		if (line.startsWith("@@")) out.push(["h", line]);
		else if (line.startsWith("+")) out.push(["a", line]);
		else if (line.startsWith("-")) out.push(["d", line]);
		else if (line.startsWith("\\")) out.push(["h", line]);
		else out.push(["c", line]);
	}
	return out;
}

/** A newly written file (no patch available) as an all-added diff, like the mockup's `new file` hunk. */
export function newFileLines(content: string): CodeLine[] {
	const lines = content.replace(/\n$/, "").split("\n");
	return [["h", `@@ -0,0 +1,${lines.length} @@ new file`], ...lines.map((l): CodeLine => ["a", `+${l}`])];
}

/** Keeps at most `max` lines; the rest becomes one muted `  … N more lines` row (the mockup's truncation). */
export function capLines(lines: CodeLine[], max = 400): CodeLine[] {
	if (lines.length <= max) return lines;
	const rest = lines.length - max;
	return [...lines.slice(0, max), ["h", `  … ${rest} more ${rest === 1 ? "line" : "lines"}`]];
}

const SUMMARY = /^=*\s*(\d+ (passed|failed|error|errors|skipped|deselected|xfailed|xpassed|warnings?)\b.*?)\s*=*$/;
const PROGRESS = /^[.FEsxX]+\s*(\[\s*\d+%\])?$/;
const FAILURE = /^(FAILED|ERROR)\b|^E\s|^>\s|Error\b|Traceback \(most recent call last\)|exited with code [1-9]/;

/**
 * Command or test output as code lines: `$ command` first (when given), then each output line.
 * Failure lines are `f` (pytest `FAILED …`, `E …`, `> …`, tracebacks, a failing summary);
 * a passing pytest summary and an all-dots progress line are `o`; the rest is `c`.
 */
export function outputLines(text: string | undefined, command?: string): CodeLine[] {
	const out: CodeLine[] = command ? [["c", `$ ${command}`]] : [];
	if (!text) return out;
	for (const raw of text.replace(/\n+$/, "").split("\n")) {
		const line = raw.trimEnd();
		const trimmed = line.trim();
		if (SUMMARY.test(trimmed)) out.push([/\b(failed|error|errors)\b/.test(trimmed) ? "f" : "o", line]);
		else if (PROGRESS.test(trimmed) && trimmed.length > 0) out.push([/[FE]/.test(trimmed) ? "c" : "o", line]);
		else if (FAILURE.test(trimmed)) out.push(["f", line]);
		else out.push(["c", line]);
	}
	return out;
}

/** Plain text as context lines (file excerpts, notes). */
export function textLines(text: string | undefined): CodeLine[] {
	if (!text) return [];
	return text
		.replace(/\n+$/, "")
		.split("\n")
		.map((l): CodeLine => ["c", l]);
}

/** A run of consecutive reads folded into one step (the mockup's "explored N files"). */
export interface Fold<T> {
	type: "fold";
	items: T[];
}

/**
 * Folds runs of two or more consecutive `read` items into one `fold` item (the mockup's `foldSteps`).
 * Everything else, including single reads, passes through unchanged and in order.
 */
export function foldSteps<T extends { type: string }>(items: readonly T[]): (T | Fold<T>)[] {
	const out: (T | Fold<T>)[] = [];
	let i = 0;
	while (i < items.length) {
		if (items[i]?.type === "read") {
			let j = i;
			while (j < items.length && items[j]?.type === "read") j++;
			if (j - i >= 2) {
				out.push({ type: "fold", items: items.slice(i, j) });
				i = j;
				continue;
			}
		}
		out.push(items[i] as T);
		i++;
	}
	return out;
}

/** Escapes a `data-k` focus key for use inside `[data-k="…"]`. */
export function cssKey(key: string): string {
	return key.replace(/["\\]/g, "\\$&");
}
