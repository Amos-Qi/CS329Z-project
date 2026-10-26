import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function env(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

const defaultPythonBin = join(repoRoot, "tasks", ".venv", "bin");

export const config = {
	repoRoot,
	port: Number(env("VCM_PORT") ?? 8787),
	provider: env("VCM_PROVIDER") ?? "openrouter",
	model: env("VCM_MODEL") ?? "anthropic/claude-sonnet-5.5",
	thinkingLevel: (env("VCM_THINKING") ?? "medium") as "off" | "minimal" | "low" | "medium" | "high",
	runsDir: resolve(env("VCM_RUNS_DIR") ?? join(repoRoot, "runs")),
	tasksDir: resolve(env("VCM_TASKS_DIR") ?? join(repoRoot, "tasks")),
	/** Prepended to PATH so the agent's bash tool finds python/pytest for the task repos. */
	pythonBin: env("VCM_PYTHON_BIN") ?? (existsSync(defaultPythonBin) ? defaultPythonBin : undefined),
};

export type Config = typeof config;
