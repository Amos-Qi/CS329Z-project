/**
 * Derivations both views share (docs/design.md §6, §6.3): each module's display status, the five
 * flags, where the agent is held or will hold, and what the Now bar shows. They read only RunState,
 * so the modular view and the log view can differ in organization but never in what they know.
 */

import type { Action, Attempt, BoundaryKind, FileChange, ModuleId, ModuleVersion } from "./model.ts";
import { normalizePath, type RunState, UNASSIGNED } from "./reduce.ts";
import { writesFiles } from "./shell.ts";

/** Status shapes of docs/design.md §6 ("waiting" is a marker on the line, not a station status). */
export type DisplayStatus = "verified" | "unverified" | "working" | "pending" | "failed" | "replaced" | "stopped";

/** Flag 5 ("stuck"): this many consecutive actions without progress in the running module. */
export const STUCK_AFTER = 10;

const EDIT_TOOLS = new Set(["edit", "write"]);

export const isLive = (state: RunState): boolean => state.status === "running" || state.status === "paused";

/** Modules on the current plan, in plan order (dropped modules are left out). */
export function planModules(state: RunState): ModuleId[] {
	return state.moduleOrder.filter((id) => state.modules[id]?.inPlan);
}

/** One or two words for a station: the agent's label, or the first meaningful word of the title. */
export function shortLabel(version: Pick<ModuleVersion, "title" | "label">): string {
	const label = version.label?.trim();
	if (label) return label;
	const stop = new Set(["a", "an", "the", "and", "of", "to", "for", "in", "on", "with", "add", "make"]);
	const words = version.title.split(/\s+/).filter(Boolean);
	const word = words.find((w) => !stop.has(w.toLowerCase())) ?? words[0] ?? version.title;
	return word.length > 12 ? `${word.slice(0, 11)}…` : word;
}

export function attemptsOf(state: RunState, moduleId: ModuleId): Attempt[] {
	return (state.modules[moduleId]?.attemptIds ?? []).flatMap((id) => state.attempts[id] ?? []);
}

/** The module's latest attempt that a redo has not replaced. */
export function currentAttempt(state: RunState, moduleId: ModuleId): Attempt | undefined {
	return attemptsOf(state, moduleId)
		.filter((a) => a.status !== "invalidated")
		.at(-1);
}

export function actionsOf(state: RunState, attemptId: string | null): Action[] {
	return (state.actionsByAttempt[attemptId ?? UNASSIGNED] ?? []).flatMap((id) => state.actions[id] ?? []);
}

export const isEdit = (a: Action): boolean => EDIT_TOOLS.has(a.tool) && a.endedAt !== undefined && !a.isError;
export const isTest = (a: Action): boolean => a.isTest === true || a.test !== undefined;

export function actionPath(state: RunState, action: Action): string | undefined {
	const path = action.args.path ?? action.args.file_path;
	return typeof path === "string" ? normalizePath(state, path) : undefined;
}

export interface AttemptEvidence {
	attempt: Attempt;
	actions: Action[];
	/**
	 * Index in `actions` of the last successful edit or write, or of a command that may have changed
	 * files when the checkpoint diff shows changes no edit/write accounts for; -1 if none.
	 */
	lastEditIndex: number;
	/** The attempt's latest test run (it may still be running). */
	latestTest?: Action;
	/** The latest finished test run after the last edit. */
	testAfterEdit?: Action;
	/** Edited, wrote, or changed files some other way (checkpoint diff). */
	changedFiles: boolean;
	/** A passing test after the last edit, or no file changed and no test failed. */
	verified: boolean;
	/** Files the checkpoint diff shows changed but no edit/write accounts for (bash, flag 3). */
	changedByCommand: string[];
}

export function attemptEvidence(state: RunState, attempt: Attempt): AttemptEvidence {
	const actions = actionsOf(state, attempt.attemptId);
	const edited = new Set(actions.filter(isEdit).flatMap((a) => actionPath(state, a) ?? []));
	const changedByCommand = (attempt.fileChanges ?? [])
		.map((c) => normalizePath(state, c.path))
		.filter((p) => !edited.has(p));
	let lastEditIndex = actions.findLastIndex(isEdit);
	if (changedByCommand.length > 0) {
		// a command changed files: a test only verifies them if it ran after that command (the last
		// command that looks like it writes, else the last command at all)
		const commands = actions
			.map((a, i) => ({ a, i }))
			.filter(({ a }) => a.tool === "bash" && !isTest(a) && a.endedAt !== undefined);
		const writing = commands.filter(({ a }) => writesFiles(String(a.args.command ?? "")));
		lastEditIndex = Math.max(lastEditIndex, (writing.length ? writing : commands).at(-1)?.i ?? -1);
	}
	const tests = actions.map((a, i) => ({ a, i })).filter(({ a }) => isTest(a));
	const testAfterEdit = tests.filter(({ a, i }) => i > lastEditIndex && a.endedAt !== undefined).at(-1)?.a;
	const changedFiles = lastEditIndex >= 0 || (attempt.fileChanges?.length ?? 0) > 0;
	return {
		attempt,
		actions,
		lastEditIndex,
		latestTest: tests.at(-1)?.a,
		testAfterEdit,
		changedFiles,
		// with nothing changed there is nothing to verify, unless its latest test failed
		verified: changedFiles || testAfterEdit ? testAfterEdit?.test?.ok === true : true,
		changedByCommand,
	};
}

export function displayStatus(state: RunState, moduleId: ModuleId): DisplayStatus {
	const attempt = currentAttempt(state, moduleId);
	if (!attempt) return attemptsOf(state, moduleId).length ? "replaced" : "pending";
	switch (attempt.status) {
		case "running":
			if (isLive(state)) return "working";
			if (state.status === "aborted" || stoppedByYou(state)) return "stopped";
			if (state.status === "error") return "failed";
			// the run completed while the module was still open: the agent never called finish_module
			return "unverified";
		case "completed":
			return attemptEvidence(state, attempt).verified ? "verified" : "unverified";
		case "failed":
			return "failed";
		default:
			return "stopped";
	}
}

export const stoppedByYou = (state: RunState): boolean => state.interventions.some((i) => i.kind === "stop");

/**
 * Per-criterion result for the module card: what the agent claims, and whether tests back it.
 * `unreported`: the attempt ended but the agent reported no result for this criterion.
 */
export type CriterionStatus = "pending" | "verified" | "agent" | "failed" | "unreported";

export function criteria(state: RunState, moduleId: ModuleId): { text: string; status: CriterionStatus }[] {
	return attemptCriteria(state, moduleId, currentAttempt(state, moduleId));
}

/** Done-when results for one attempt of a module (criteria() for its current attempt; the same rule for older ones). */
export function attemptCriteria(
	state: RunState,
	moduleId: ModuleId,
	attempt: Attempt | undefined,
): { text: string; status: CriterionStatus }[] {
	const module = state.modules[moduleId];
	if (!module) return [];
	const version = (attempt && module.versions.find((v) => v.version === attempt.moduleVersion)) ?? module.latest;
	const key = (s: string) => s.trim().toLowerCase();
	const texts = version.validation;
	const results = attempt?.validation ?? [];
	const ended = !!attempt && attempt.status !== "running" && state.attemptSeq[attempt.attemptId]?.end !== undefined;
	return texts.map((text, i) => {
		if (!attempt || !ended) return { text, status: "pending" };
		// the agent's result for this criterion: same text, else the same position when it reported one per
		// criterion and that result does not name another criterion
		const atIndex = results.length === texts.length ? results[i] : undefined;
		const result =
			results.find((r) => key(r.criterion) === key(text)) ??
			(atIndex && !texts.some((other) => key(other) === key(atIndex.criterion)) ? atIndex : undefined);
		if (attempt.status === "failed" || result?.met === false) return { text, status: "failed" };
		if (!result || result.met === null) return { text, status: "unreported" };
		return { text, status: attemptEvidence(state, attempt).verified ? "verified" : "agent" };
	});
}

// ---- flags (docs/design.md §6: five fixed rules, the same in both conditions) ---------------

export type FlagRule = "tests_failing" | "unverified" | "command_change" | "unassigned_edit" | "stuck";

export interface Flag {
	id: string;
	rule: FlagRule;
	text: string;
	moduleId?: ModuleId;
	attemptId?: string;
	/** The trace item the flag points at: an action, or the end of an attempt. */
	actionId?: string;
	path?: string;
}

export function computeFlags(state: RunState): Flag[] {
	const flags: Flag[] = [];
	// every module with a current attempt, also one a re-plan dropped after it ran (its changes stay)
	for (const moduleId of state.moduleOrder) {
		const attempt = currentAttempt(state, moduleId);
		if (!attempt) continue;
		const ev = attemptEvidence(state, attempt);
		const base = { moduleId, attemptId: attempt.attemptId };
		const unfinished = attempt.status === "running" && state.status === "completed" && !stoppedByYou(state);
		if ((attempt.status === "completed" && !ev.verified) || unfinished) {
			flags.push({
				...base,
				id: `unverified:${attempt.attemptId}`,
				rule: "unverified",
				text: unfinished
					? `${moduleId} was never finished (no finish_module)`
					: `${moduleId} claimed done without a passing test`,
			});
		} else if (ev.testAfterEdit && !ev.testAfterEdit.test?.ok) {
			flags.push({
				...base,
				id: `tests_failing:${attempt.attemptId}`,
				rule: "tests_failing",
				text: `${moduleId}: tests failing after its last edit`,
				actionId: ev.testAfterEdit.actionId,
			});
		}
		for (const path of ev.changedByCommand) {
			flags.push({
				...base,
				id: `command_change:${attempt.attemptId}:${path}`,
				rule: "command_change",
				text: `${path} changed by a command in ${moduleId}`,
				path,
			});
		}
		const stuck = attempt.status === "running" && isLive(state) ? stuckCount(state, ev.actions) : 0;
		if (stuck >= STUCK_AFTER) {
			flags.push({
				...base,
				id: `stuck:${attempt.attemptId}`,
				rule: "stuck",
				text: `${moduleId} may be stuck: ${stuck} steps without progress`,
				actionId: ev.actions.at(-1)?.actionId,
			});
		}
	}
	for (const action of actionsOf(state, null)) {
		if (!isEdit(action) || discarded(state, state.actionSeq[action.actionId])) continue;
		const path = actionPath(state, action) ?? action.tool;
		flags.push({
			id: `unassigned_edit:${action.actionId}`,
			rule: "unassigned_edit",
			text: `Edit outside any module: ${path}`,
			actionId: action.actionId,
			path,
		});
	}
	const known = new Set(flags.filter((f) => f.rule === "command_change").map((f) => f.path));
	for (const change of state.audit?.unattributedChanges ?? []) {
		if (change.attemptId !== null || known.has(change.path)) continue;
		flags.push({
			id: `command_change:run:${change.path}`,
			rule: "command_change",
			text: `${change.path} changed outside any module`,
			path: change.path,
		});
	}
	return flags;
}

/** Whether a redo discarded the work at trace position `seq` (it lies in a span a revise rewound). */
export function discarded(state: RunState, seq: number | undefined): boolean {
	return seq !== undefined && state.discarded.some((span) => seq >= span.from && seq <= span.to);
}

/** Trailing actions with no progress: no new file read, edit, new command, or better test result. */
function stuckCount(state: RunState, actions: Action[]): number {
	const reads = new Set<string>();
	const commands = new Set<string>();
	let best: { passed: number; bad: number } | undefined;
	let since = 0;
	for (const action of actions) {
		if (action.endedAt === undefined) continue;
		let progress = false;
		if (isEdit(action)) progress = true;
		else if (isTest(action) && action.test) {
			const { passed = 0, failed = 0, errors = 0 } = action.test;
			const bad = failed + errors;
			const better = !best || passed > best.passed || bad < best.bad;
			progress = better;
			if (better) best = { passed, bad };
		} else if (!action.isError) {
			const key =
				action.tool === "bash"
					? `bash:${String(action.args.command ?? "")}`
					: `${action.tool}:${actionPath(state, action) ?? JSON.stringify(action.args)}`;
			const seen = action.tool === "bash" ? commands : reads;
			progress = !seen.has(key);
			seen.add(key);
		}
		since = progress ? 0 : since + 1;
	}
	return since;
}

// ---- boundaries: where the agent is held, and where an armed pause would hold it -----------

/** A gap on the line: after the "before plan" station (null) or after a module station. */
export interface Slot {
	after: ModuleId | null;
	boundary: BoundaryKind;
	/** The module the boundary belongs to (before_start / after_finish). */
	moduleId?: ModuleId;
}

function stationBefore(state: RunState, moduleId: ModuleId): ModuleId | null {
	const order = planModules(state);
	const i = order.indexOf(moduleId);
	return i > 0 ? (order[i - 1] ?? null) : null;
}

/** First module in plan order that is neither running nor done, preferring ones after `after`. */
export function nextModule(state: RunState, after?: ModuleId | null): ModuleId | undefined {
	const order = planModules(state);
	const open = order.filter((id) => {
		const status = currentAttempt(state, id)?.status;
		return status !== "completed" && status !== "running";
	});
	const from = after ? order.indexOf(after) : -1;
	return open.find((id) => order.indexOf(id) > from) ?? open[0];
}

/** Where an armed "pause at next boundary" would hold the agent (only while it is running). */
export function pauseSlot(state: RunState): Slot | undefined {
	if (state.status !== "running") return undefined;
	if (state.plans.length === 0) return { after: null, boundary: "after_plan" };
	const active = state.activeAttemptId ? state.attempts[state.activeAttemptId] : undefined;
	if (active) return { after: active.moduleId, boundary: "after_finish", moduleId: active.moduleId };
	const next = nextModule(state, lastEnded(state)?.moduleId);
	if (next) return { after: stationBefore(state, next), boundary: "before_start", moduleId: next };
	// every planned module is done: the next boundary is a re-plan (plan_modules always passes after_plan)
	return { after: lastDoneStation(state), boundary: "after_plan" };
}

/** The attempt that ended most recently (completed or failed, not replaced). */
export function lastEnded(state: RunState): Attempt | undefined {
	return state.attemptOrder
		.flatMap((id) => state.attempts[id] ?? [])
		.filter((a) => a.status === "completed" || a.status === "failed")
		.sort((a, b) => (state.attemptSeq[a.attemptId]?.end ?? 0) - (state.attemptSeq[b.attemptId]?.end ?? 0))
		.at(-1);
}

/** The last plan station whose current attempt ended (where the agent is between modules), null if none. */
function lastDoneStation(state: RunState): ModuleId | null {
	const done = planModules(state).filter((id) => {
		const status = currentAttempt(state, id)?.status;
		return status === "completed" || status === "failed";
	});
	return done.at(-1) ?? null;
}

export interface Decision extends Slot {
	boundaryId: string;
	since: number;
	/** "Continue to Mk" / "Change Mk first". */
	next?: ModuleId;
	/** "Redo Mj": the module and attempt a redo would rewind to. */
	redo?: { moduleId: ModuleId; attemptId: string };
}

/** The decision card's content while the agent waits at a boundary. */
export function decision(state: RunState): Decision | undefined {
	const pending = state.pendingBoundary;
	if (!pending) return undefined;
	const base = {
		boundaryId: pending.boundaryId,
		since: pending.since,
		boundary: pending.boundary,
		moduleId: pending.moduleId,
	};
	const ended = lastEnded(state);
	const redo = ended ? { moduleId: ended.moduleId, attemptId: ended.attemptId } : undefined;
	if (pending.boundary === "after_plan") {
		// the first plan: nothing ran yet; a re-plan: the agent is after the last module it finished
		const after = state.plans.length > 1 ? lastDoneStation(state) : null;
		return { ...base, after, next: nextModule(state, after), redo: state.plans.length > 1 ? redo : undefined };
	}
	if (pending.boundary === "before_start" && pending.moduleId) {
		return {
			...base,
			after: stationBefore(state, pending.moduleId),
			next: pending.moduleId,
			redo,
		};
	}
	const held = pending.moduleId ?? null;
	const attempt = held ? currentAttempt(state, held) : undefined;
	return {
		...base,
		after: held,
		next: nextModule(state, held),
		redo: held && attempt ? { moduleId: held, attemptId: attempt.attemptId } : undefined,
	};
}

/**
 * The action the Now bar shows: the latest one still running; else, while the run is live, the latest
 * one of the active attempt (none before it takes one), or with no attempt active an unassigned one
 * since the last boundary (attempt start or end, plan, redo). Never one of an earlier module or attempt.
 */
export function currentAction(state: RunState): Action | undefined {
	for (let i = state.actionOrder.length - 1; i >= 0; i--) {
		const action = state.actions[state.actionOrder[i] as string];
		if (!action || action.endedAt !== undefined) continue;
		if (action.attemptId && state.attempts[action.attemptId]?.status === "invalidated") continue;
		return action;
	}
	if (!isLive(state)) return undefined;
	if (state.activeAttemptId) return actionsOf(state, state.activeAttemptId).at(-1);
	const since = state.boundarySeq ?? -1;
	return actionsOf(state, null)
		.filter((a) => (state.actionSeq[a.actionId] ?? -1) > since)
		.at(-1);
}

/** Notes and corrections sent while live that have not reached the agent yet. */
export function queuedNotes(state: RunState) {
	return state.interventions.filter((i) => (i.kind === "note" || i.kind === "correct") && i.deliveredAt === undefined);
}

// ---- file changes ---------------------------------------------------------------------------

export interface FileStat {
	path: string;
	add: number;
	del: number;
	patch?: string;
}

/**
 * Added and removed lines of a unified diff. Inside a hunk (by its `@@ -a,b +c,d @@` counts) every
 * `+`/`-` line counts, also `--- x` (a removed `-- x`); `---`/`+++` are skipped only as file headers.
 */
export function diffStats(patch: string | undefined): { add: number; del: number } {
	let add = 0;
	let del = 0;
	let oldLeft = 0;
	let newLeft = 0;
	for (const line of (patch ?? "").split("\n")) {
		const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
		if (hunk) {
			oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
			newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			continue;
		}
		if (oldLeft > 0 || newLeft > 0) {
			if (line.startsWith("+")) {
				add++;
				newLeft--;
			} else if (line.startsWith("-")) {
				del++;
				oldLeft--;
			} else if (!line.startsWith("\\")) {
				oldLeft--;
				newLeft--;
			}
			continue;
		}
		// outside a counted hunk (headers, or a patch whose hunks carry no counts)
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) add++;
		else if (line.startsWith("-")) del++;
	}
	return { add, del };
}

/**
 * Files an attempt changed. Once it ended, the checkpoint diff is exact (it includes bash changes);
 * while it runs, edits are counted from their patches and writes as all-added lines.
 */
export function fileStats(state: RunState, attempt: Attempt | null): FileStat[] {
	const byPath = new Map<string, FileStat>();
	const add = (path: string, change: { add: number; del: number }, patch?: string) => {
		const stat = byPath.get(path) ?? { path, add: 0, del: 0 };
		stat.add += change.add;
		stat.del += change.del;
		if (patch) stat.patch = stat.patch ? `${stat.patch}\n${patch}` : patch;
		byPath.set(path, stat);
	};
	if (attempt?.fileChanges && attempt.endCheckpoint) {
		for (const change of attempt.fileChanges)
			add(normalizePath(state, change.path), diffStats(change.patch), change.patch);
		return [...byPath.values()];
	}
	for (const action of actionsOf(state, attempt?.attemptId ?? null)) {
		if (!isEdit(action)) continue;
		for (const change of action.fileChanges ?? [])
			add(normalizePath(state, change.path), changeStats(action, change), change.patch);
	}
	return [...byPath.values()];
}

function changeStats(action: Action, change: FileChange): { add: number; del: number } {
	if (change.patch) return diffStats(change.patch);
	const content = action.args.content;
	return {
		add: typeof content === "string" ? content.split("\n").filter((l, i, all) => l || i < all.length - 1).length : 0,
		del: 0,
	};
}
