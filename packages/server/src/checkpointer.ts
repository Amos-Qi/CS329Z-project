/**
 * Workspace snapshots in a shadow git repository (runs/<id>/snapshots.git), so the task repo's own
 * .git is never touched and the agent cannot see or change the snapshots. See docs/design.md §5, §7.
 *
 * Suggested approach: run git with GIT_DIR=<gitDir> and GIT_WORK_TREE=<workTree>, exclude .venv and
 * caches via <gitDir>/info/exclude, `add --all` + `commit --allow-empty` per snapshot, and keep a ref
 * per checkpoint so restores never lose history.
 */

import type { FileChange } from "@vcm/protocol";

export class Checkpointer {
	readonly gitDir: string;
	readonly workTree: string;

	constructor(gitDir: string, workTree: string) {
		this.gitDir = gitDir;
		this.workTree = workTree;
	}

	/** Creates the shadow repo and returns the baseline commit. */
	async init(): Promise<string> {
		throw new Error("TODO: Checkpointer.init");
	}

	/** Snapshots the workspace and returns the commit id. */
	async snapshot(_label: string): Promise<string> {
		throw new Error("TODO: Checkpointer.snapshot");
	}

	/** Files changed between two snapshots, with patches. */
	async diff(_from: string, _to: string): Promise<FileChange[]> {
		throw new Error("TODO: Checkpointer.diff");
	}

	/** Restores the workspace to a snapshot exactly (ignored paths such as .venv are kept). */
	async restore(_commit: string): Promise<void> {
		throw new Error("TODO: Checkpointer.restore");
	}
}
