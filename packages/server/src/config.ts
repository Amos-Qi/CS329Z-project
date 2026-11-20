import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function env(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

/** A path from the environment; relative paths are relative to the repo root (not to the cwd of npm -w). */
function envPath(name: string): string | undefined {
	const value = env(name);
	return value ? resolve(repoRoot, value) : undefined;
}

const defaultPythonBin = join(repoRoot, "tasks", ".venv", "bin");

export const config = {
	repoRoot,
	port: Number(env("VCM_PORT") ?? 8787),
	provider: env("VCM_PROVIDER") ?? "openrouter",
	model: env("VCM_MODEL") ?? "anthropic/claude-sonnet-5.5",
	thinkingLevel: (env("VCM_THINKING") ?? "medium") as "off" | "minimal" | "low" | "medium" | "high",
	runsDir: envPath("VCM_RUNS_DIR") ?? join(repoRoot, "runs"),
	tasksDir: envPath("VCM_TASKS_DIR") ?? join(repoRoot, "tasks"),
	/** Prepended to PATH so the agent's bash tool finds python/pytest for the task repos. */
	pythonBin: envPath("VCM_PYTHON_BIN") ?? (existsSync(defaultPythonBin) ? defaultPythonBin : undefined),
	/** Pause automatically after the agent's first plan, so the overseer can review it. */
	pauseAfterPlan: env("VCM_PAUSE_AFTER_PLAN") === "1",
	/** Block edit/write calls outside a module instead of only reminding the agent (docs/design.md §10). */
	gateEdits: env("VCM_GATE_EDITS") === "1",
};

export type Config = typeof config;

/**
 * The agent's commands inherit this process's environment: put the task's python/pytest on PATH and
 * turn off terminal colours (dev tools such as concurrently set FORCE_COLOR), so tool output stays plain.
 */
export function prepareAgentEnvironment(): void {
	if (config.pythonBin) process.env.PATH = `${config.pythonBin}${delimiter}${process.env.PATH ?? ""}`;
	delete process.env.FORCE_COLOR;
	process.env.NO_COLOR = "1";
	process.env.PY_COLORS = "0";
}
