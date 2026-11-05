/**
 * Workspace snapshots in a shadow git repository (runs/<id>/snapshots.git). The task repo's own
 * .git, if any, is never touched, and the agent cannot see or change the snapshots.
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FileChange } from "@vcm/protocol";

const exec = promisify(execFile);

const EXCLUDES = [".venv/", "__pycache__/", ".pytest_cache/", "*.pyc", ".mypy_cache/", ".ruff_cache/", "node_modules/"];

export class Checkpointer {
	private readonly env: NodeJS.ProcessEnv;
	private readonly gitDir: string;

	constructor(gitDir: string, workTree: string) {
		this.gitDir = gitDir;
		this.env = {
			...process.env,
			GIT_DIR: gitDir,
			GIT_WORK_TREE: workTree,
			GIT_AUTHOR_NAME: "vcm",
			GIT_AUTHOR_EMAIL: "vcm@localhost",
			GIT_COMMITTER_NAME: "vcm",
			GIT_COMMITTER_EMAIL: "vcm@localhost",
		};
	}

	private async git(...args: string[]): Promise<string> {
		const { stdout } = await exec("git", args, { env: this.env, maxBuffer: 64 * 1024 * 1024 });
		return stdout;
	}

	/** Creates the shadow repo and returns the baseline commit. */
	async init(): Promise<string> {
		mkdirSync(this.gitDir, { recursive: true });
		await this.git("init", "--quiet");
		mkdirSync(join(this.gitDir, "info"), { recursive: true });
		writeFileSync(join(this.gitDir, "info", "exclude"), `${EXCLUDES.join("\n")}\n`);
		return this.snapshot("baseline");
	}

	async snapshot(label: string): Promise<string> {
		await this.git("add", "--all");
		await this.git("commit", "--quiet", "--allow-empty", "--no-verify", "-m", label);
		const commit = (await this.git("rev-parse", "HEAD")).trim();
		await this.git("update-ref", `refs/vcm/${label.replace(/[^\w.-]+/g, "_")}`, commit);
		return commit;
	}

	/**
	 * Files changed between two commits. No rename detection (a move is a deletion plus an addition, so
	 * both paths are listed) and no path quoting (non-ASCII names come back as they are).
	 */
	async diff(from: string, to: string): Promise<FileChange[]> {
		const plain = ["-c", "core.quotePath=false", "diff", "--no-renames"];
		const names = (await this.git(...plain, "--name-only", "-z", from, to)).split("\0").filter(Boolean);
		return Promise.all(
			names.map(async (path) => ({
				path,
				kind: "diff" as const,
				patch: await this.git(...plain, from, to, "--", path),
			})),
		);
	}

	/** Restores the workspace to `commit` exactly (ignored paths such as .venv are kept). */
	async restore(commit: string): Promise<void> {
		await this.git("reset", "--quiet", "--hard", commit);
		await this.git("clean", "--quiet", "-fd");
	}
}
