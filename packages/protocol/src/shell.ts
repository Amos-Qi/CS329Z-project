/**
 * Small shell-command heuristics shared by the extension (which commands are test runs, which get the
 * "change files with edit/write" reminder) and the derivations (a command that may have changed files
 * after the last test). They look at command words only: quoted strings and heredoc bodies are data.
 */

/** Removes heredoc bodies and the contents of quoted strings, keeping the operators around them. */
export function shellWords(command: string): string {
	const lines = command.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		kept.push(line);
		// `<<EOF`, `<<-'EOF'`, `<< "EOF"` (not the here-string `<<<`)
		const heredoc = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
		if (!heredoc) continue;
		const end = heredoc[2] as string;
		while (i + 1 < lines.length && (lines[i + 1] as string).trim() !== end) i++;
		i++;
	}
	return kept
		.join("\n")
		.replace(/'[^']*'/g, "''")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** The simple commands of a command line (split on `&&`, `||`, `;`, `|` and newlines), quotes and heredocs removed. */
export function commandSegments(command: string): string[] {
	return shellWords(command)
		.split(/&&|\|\||[;|\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** pytest as a command (also `python -m pytest`, env assignments, paths), not `--version`, `--help` or collection only. */
export const PYTEST_COMMAND =
	/^(?:\S+=\S*\s+)*(?:timeout\s+\S+\s+)?(?:\S*\/)?(?:(?:python[\d.]*|uv\s+run|poetry\s+run)\s+(?:-m\s+)?)?(?:\S*\/)?py\.?test\b(?!.*\s--?(?:version|help|h|collect-only|co)\b)/;

/**
 * Node's test runner (`node --test`, flags allowed before it), a test file run directly
 * (`node test/game.test.js`), or a package's test script (`npm test`, `npm -s run test`, `npm t`, pnpm,
 * yarn), not `test:watch`.
 */
export const NODE_TEST_COMMAND =
	/^(?:\S+=\S*\s+)*(?:timeout\s+\S+\s+)?(?:(?:\S*\/)?node\s+(?:(?:-\S+\s+)*?--test(?=\s|$)|(?:-\S+\s+)*\S*\.test\.[cm]?js(?=\s|$))|(?:npm|pnpm|yarn)(?:\s+-{1,2}[a-z][\w-]*)*\s+(?:run\s+)?(?:test|t)(?=\s|$))(?!.*\s--?(?:version|help|h)\b)/;

/** The test runners the tasks use: pytest (Python tasks) and Node's test runner or package test scripts. */
export const TEST_COMMAND = new RegExp(`${PYTEST_COMMAND.source}|${NODE_TEST_COMMAND.source}`);

/** Whether one segment of `command` runs the tests (`pattern` is matched against each simple command). */
export function isTestCommand(command: string, pattern: RegExp = TEST_COMMAND): boolean {
	return commandSegments(command).some((segment) => pattern.test(segment));
}

const REDIRECT = /(?:^|[^<>&\d])(?:\d|&)?>>?(?!&)\s*(?!\/dev\/(?:null|stdout|stderr)\b)[^\s>]/;
const WRITING_SEGMENT = [
	/\btee\b/,
	/\bsed\b.*\s(?:-[a-zA-Z]*i|--in-place)\b/,
	/\bperl\b.*\s-[a-zA-Z]*i/,
	/\b(?:mv|rm|rmdir|cp|touch|mkdir|truncate|patch|ln|unzip|tar\s+-?x)\s/,
	/\bgit\s+(?:apply|checkout|restore|stash(?!\s+(?:list|show)\b)|reset|revert|cherry-pick|merge|pull|am|rm|mv|clean|switch)\b/,
	/\b(?:black|isort|autopep8)\b(?!.*\s--(?:check|diff)\b)/,
	/\b(?:ruff|eslint|biome)\b.*\s--(?:fix|write)\b/,
	/\bprettier\b.*\s--write\b/,
	/\b(?:npm|pnpm|yarn)\s+(?:init|install|i|add|remove|uninstall|update|pkg\s+set)\b/,
];

const NODE_EVAL_WRITE =
	/\bnode\s+(?:-e|--eval|-p|--print)\b[\s\S]*\b(?:writeFile|appendFile|rm|unlink|rename|mkdir)(?:Sync)?\(/;

/**
 * Bash commands that probably change files: redirection to a file (not /dev/null), heredocs, in-place
 * edits, moves and deletes, git commands that rewrite the work tree, formatters, package managers,
 * `python -c "open(.., 'w')"`, `node -e "fs.writeFileSync(..)"`.
 */
export function writesFiles(command: string): boolean {
	if (/\bpython[\d.]*\s+-c\b[\s\S]*\bopen\([^)]*['"][wax]\+?b?['"]/.test(command)) return true;
	if (NODE_EVAL_WRITE.test(command)) return true;
	const words = shellWords(command);
	if (/(?<!<)<<(?!<)/.test(words)) return true;
	return commandSegments(command).some(
		(segment) =>
			!/\s--help\b/.test(segment) && (REDIRECT.test(segment) || WRITING_SEGMENT.some((re) => re.test(segment))),
	);
}
