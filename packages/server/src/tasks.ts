/** Task specs (tasks/<id>/task.yaml) and workspace preparation. See tasks/README.md. */

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { TaskSummary } from "@vcm/protocol";
import { parse } from "yaml";

const exec = promisify(execFile);

export interface ReadRewrite {
	/** Only rewrite results of this tool. Default: read. */
	tool?: string;
	/** Regex matched against the tool's `path` argument. */
	path: string;
	find: string;
	replace: string;
}

export interface Variant {
	id: string;
	kind: "prompt_override" | "file_overlay" | "read_rewrite";
	description: string;
	/** Replaces the task prompt (prompt_override). */
	prompt?: string;
	/** Files written into the workspace before the run (file_overlay). */
	files?: { path: string; content: string }[];
	/** Tool-result rewrites (read_rewrite). */
	rewrites?: ReadRewrite[];
	/** Annotation for analysis: where the error originates and what it should affect. */
	origin?: string;
	expectedAffected?: string[];
}

export interface TaskSpec {
	id: string;
	title: string;
	split: "pilot" | "eval" | "dev";
	source: { type: "local"; path: string } | { type: "git"; url: string; commit: string };
	prompt: string;
	testCommand: string;
	hiddenTests?: string;
	setup?: string[];
	notes?: string;
	variants: Variant[];
	/** Directory containing task.yaml. */
	dir: string;
}

const SKIP = new Set([".venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules"]);

export function loadTasks(tasksDir: string): TaskSpec[] {
	if (!existsSync(tasksDir)) return [];
	return readdirSync(tasksDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(tasksDir, d.name, "task.yaml")))
		.map((d) => loadTask(join(tasksDir, d.name)));
}

export function loadTask(dir: string): TaskSpec {
	const raw = parse(readFileSync(join(dir, "task.yaml"), "utf8")) as Record<string, any>;
	const source = raw.source?.git
		? { type: "git" as const, url: String(raw.source.git), commit: String(raw.source.commit) }
		: { type: "local" as const, path: resolve(dir, String(raw.source?.path ?? "repo")) };
	return {
		id: String(raw.id ?? basename(dir)),
		title: String(raw.title ?? raw.id),
		split: raw.split ?? "dev",
		source,
		prompt: String(raw.prompt).trim(),
		testCommand: String(raw.test_command ?? "python -m pytest -q"),
		hiddenTests: raw.hidden_tests ? resolve(dir, raw.hidden_tests) : undefined,
		setup: raw.setup,
		notes: raw.notes,
		variants: (raw.variants ?? []).map((v: Record<string, any>) => ({
			id: String(v.id),
			kind: v.kind,
			description: String(v.description ?? ""),
			prompt: v.prompt,
			files: v.files,
			rewrites: v.rewrites,
			origin: v.origin,
			expectedAffected: v.expected_affected,
		})),
		dir,
	};
}

export function summarizeTask(task: TaskSpec): TaskSummary {
	return { id: task.id, title: task.title, split: task.split, variants: task.variants.map((v) => v.id) };
}

/** Copies or clones the task repo into `workspace` and applies a variant's file overlays. */
export async function prepareWorkspace(task: TaskSpec, variant: Variant | undefined, workspace: string): Promise<void> {
	mkdirSync(dirname(workspace), { recursive: true });
	if (task.source.type === "local") {
		cpSync(task.source.path, workspace, {
			recursive: true,
			filter: (src) => !SKIP.has(basename(src)),
		});
	} else {
		await exec("git", ["clone", "--quiet", task.source.url, workspace]);
		await exec("git", ["-C", workspace, "checkout", "--quiet", task.source.commit]);
	}
	for (const file of variant?.files ?? []) {
		const target = join(workspace, file.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, file.content);
	}
	for (const command of task.setup ?? []) {
		await exec("sh", ["-c", command], { cwd: workspace });
	}
}

// TODO: read_rewrite variants — a ModulesHost.rewriteToolResult built from variant.rewrites.
