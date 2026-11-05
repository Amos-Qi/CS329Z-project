/**
 * buildPanel(): the panel's view model. It turns one RunState (plus the trace it came from) into
 * plain data shaped like the mockup's `DATA`/`mod()`/`events()` (design/mockups/panel.html), so the
 * components port 1:1 and never re-derive anything. Pure: same input, same output; no React, no DOM.
 *
 * Every status, flag and boundary comes from the shared derivations in @vcm/protocol (derive.ts),
 * which keeps the modular view and the log view equivalent (docs/design.md §6.3).
 */

import {
	type Action,
	type Attempt,
	type AttemptStatus,
	actionPath,
	actionsOf,
	attemptCriteria,
	attemptEvidence,
	attemptsOf,
	type BoundaryKind,
	type CriterionStatus,
	computeFlags,
	criteria,
	currentAction,
	currentAttempt,
	type Decision,
	type DisplayStatus,
	decision,
	diffStats,
	displayStatus,
	type Flag,
	fileStats,
	isLive,
	isTest,
	lastEnded,
	type ModuleId,
	type ModuleVersion,
	nextModule,
	normalizePath,
	pauseSlot,
	planModules,
	queuedNotes,
	type RunControlState,
	type RunState,
	type RunStatus,
	type Slot,
	shortLabel,
	stoppedByYou,
	type TraceEvent,
} from "@vcm/protocol";
import type { IconName } from "../ui/icons.tsx";
import {
	type CodeLine,
	capLines,
	clock,
	commandName,
	firstLine,
	joinAnd,
	lineCount,
	newFileLines,
	oneLine,
	outputLines,
	parsePatch,
	plural,
	textLines,
} from "./format.ts";

// ---- ids, statuses and labels ----------------------------------------------------------------

/** Id of the "before plan" station (actions outside any module). Never a real module id. */
export const PRE = "pre";

/** A selectable station: `PRE` or a module id. */
export type SelId = ModuleId;

/** A station's status: a module's display status, or `pre` for the before-plan station. */
export type StationStatus = DisplayStatus | "pre";

/** Every shape `<Glyph>` can draw: station statuses plus `waiting` (held diamond) and `end` (run terminus). */
export type GlyphStatus = StationStatus | "waiting" | "end";

/** Screen-reader / tooltip names of each status shape (the mockup's STATUS_LABEL, plus `end`). */
export const STATUS_LABEL: Record<GlyphStatus, string> = {
	verified: "Done, verified by tests",
	unverified: "Done, unverified (no passing test after last edit)",
	working: "Working",
	waiting: "Waiting for you",
	pending: "Not started",
	failed: "Failed",
	replaced: "Replaced by redo",
	stopped: "Stopped",
	pre: "Before plan",
	end: "Finished",
};

/** A station a redo panel would replace (the preview's `replaced`; STATUS_LABEL.replaced is a redo that happened). */
export const REDO_PREVIEW_LABEL = "Will be replaced by redo";

/** STATUS_LABEL for a shown status: the preview wording when only an open redo panel makes it `replaced`. */
export function shownLabel(real: StationStatus, shown: StationStatus): string {
	return shown === "replaced" && real !== "replaced" ? REDO_PREVIEW_LABEL : STATUS_LABEL[shown];
}

/** Short phrase for "what happened" on the decision card: `M3` + `done, no passing test`. */
export const STATUS_PHRASE: Record<StationStatus, string> = {
	verified: "done, tests pass",
	unverified: "done, no passing test",
	working: "working",
	pending: "not started",
	failed: "failed",
	replaced: "replaced",
	stopped: "stopped",
	pre: "before plan",
};

/** Longer twin of STATUS_PHRASE for aria labels: `M3 done, no passing test after its last edit`. */
const STATUS_SENTENCE: Record<StationStatus, string> = {
	...STATUS_PHRASE,
	verified: "done, verified by tests",
	unverified: "done, no passing test after its last edit",
};

/** What kind of step an action is, for icons, activity ticks and log filters. grep/find/ls count as `bash`. */
export type ActType = "read" | "write" | "edit" | "bash" | "test";

/** Step icon per action type (the mockup's STEP_IC), plus `fold` for folded reads. */
export const ACT_ICON: Record<ActType | "fold", IconName> = {
	read: "eye",
	write: "fileplus",
	edit: "edit",
	bash: "term",
	test: "flask",
	fold: "layers",
};

// ---- view types ------------------------------------------------------------------------------

/** One tool call, ready to draw as a step, a log row, an activity tick or a Now-bar action. */
export interface ActView {
	/** pi toolCallId (the trace's actionId). */
	id: string;
	/** Trace position of its `action_started`. */
	seq: number;
	/** `m:ss` since the run started. */
	t: string;
	/** Wall-clock start (ms). */
	at: number;
	moduleId: ModuleId | null;
	attemptId: string | null;
	/** The raw tool name (`read`, `bash`, `grep`, …). */
	tool: string;
	type: ActType;
	/** What it acted on: a path for read/write/edit, `pytest` for tests, the command for bash, `grep pattern`. */
	target: string;
	/** The full command (bash, tests, grep/find/ls). */
	cmd?: string;
	/** Normalized path for read/write/edit. */
	path?: string;
	/** Lines read (read only, from the result preview). */
	lines?: number;
	/** Diff size (write/edit). */
	add: number;
	del: number;
	/** Diff lines (write/edit): parsed patch, or the written content as a new file. */
	diff: CodeLine[];
	/** Output lines: `$ cmd` + output for commands/tests (with a running/stopped note), the excerpt for reads. */
	out: CodeLine[];
	/** Test counts (tests only; fail = failed + errors). */
	pass: number;
	fail: number;
	/** No result yet and the run is live (still running). */
	live: boolean;
	/** No result and the run is no longer live (cut off by a stop or an error). */
	stopped: boolean;
	/** A non-test command (or read/edit) that returned an error. */
	exit: boolean;
	/** The call as text for detail headers: `read(path="x")`, `bash("pytest -q")`. */
	call: string;
	/** Unassigned actions after the plan: where they happened (`after M2`, `after plan`). */
	where?: string;
	/** Flags anchored on this action (tests failing, stuck, edit outside modules). */
	flags: Flag[];
}

/** One row of a module's Steps tab: an action, folded reads, agent narration, or something you sent. */
export type StepView =
	| { kind: "act"; key: string; seq: number; t: string; act: ActView }
	| { kind: "fold"; key: string; seq: number; t: string; items: ActView[] }
	| {
			kind: "say";
			key: string;
			seq: number;
			t: string;
			text: string;
			/** Unassigned narration after the plan (pre station): where it happened (`after M2`). */
			where?: string;
	  }
	| {
			kind: "you";
			key: string;
			seq: number;
			t: string;
			/** note = note to agent; correct = correction for this module. */
			what: "note" | "correct";
			text: string;
			/** Not delivered to the agent yet. */
			queued: boolean;
			interventionId: string;
			/** Sent to an earlier attempt of this module that a redo replaced: its number. */
			attemptN?: number;
	  };

/** One instruction version of a module (the Versions tab and the vchip). */
export interface VersionView {
	v: number;
	by: "agent" | "you";
	/** `m:ss` since run start when it was created. */
	t: string;
	text: string;
	/** The user's note or the agent's re-plan reason, if any. */
	note?: string;
}

/** A changed file with its diff stats (fileStats of an attempt) and parsed diff. */
export interface FileView {
	path: string;
	add: number;
	del: number;
	patch?: string;
	diff: CodeLine[];
}

/** The latest test run of an attempt. */
export interface TestsView {
	pass: number;
	fail: number;
	/** Still running. */
	live: boolean;
	/** Cut off before it finished. */
	stopped: boolean;
	act: ActView;
}

/** An attempt chip (replaced attempts stay visible as slashed chips). */
export interface AttemptChip {
	attemptId: string;
	n: number;
	status: AttemptStatus;
	/** Invalidated by a redo. */
	replaced: boolean;
	/** The attempt the card shows. */
	current: boolean;
}

/** One station / module card: the mockup's `mod(id)`. The `pre` station uses the same shape (`isPre`). */
export interface ModView {
	/** Module id, or `PRE`. */
	id: SelId;
	isPre: boolean;
	/** Full title (pre: "Before plan" or "Outside modules"). */
	title: string;
	/** One or two words for the station label (shortLabel; empty for pre). */
	short: string;
	/** Declared prerequisites that are on the current plan. */
	deps: ModuleId[];
	/** Plan modules that declare this one as a prerequisite. */
	dependents: ModuleId[];
	/** Purpose (pre: the task). */
	goal: string;
	/** Current instructions text (pre: empty). */
	instr: string;
	status: StationStatus;
	/** Any flag points at this module (pre: edits outside modules, run-level command changes). */
	flag: boolean;
	flags: Flag[];
	/** `m:ss` from run start of the shown attempt's start / end; dur ticks while working. */
	start?: string;
	end?: string;
	dur?: string;
	/** Done-when criteria with their source status. */
	criteria: { text: string; st: CriterionStatus }[];
	/** Files the shown attempt changed (fileStats). */
	files: FileView[];
	/** The shown attempt's latest test run, or null if it ran none. */
	tests: TestsView | null;
	/** Distinct paths it read, in first-read order. */
	looked: string[];
	/** The shown attempt's actions in trace order. */
	actions: ActView[];
	/** Steps tab rows (actions with folded reads, narration, your notes/corrections), trace order. */
	steps: StepView[];
	/** Instruction versions, oldest first. */
	versions: VersionView[];
	/** The latest version (pre: a placeholder v0 holding the task, never shown). */
	cur: VersionView;
	/** All attempts of the module, oldest first. */
	attempts: AttemptChip[];
	/** The attempt the card shows: the current one, else the latest replaced one. */
	attemptId?: string;
	attemptN?: number;
	/** Trace position where the shown attempt started (orders redo consequences). */
	startSeq?: number;
	/** On the current plan (dropped modules are not stations). */
	inPlan: boolean;
	/** "Change Mk…" is possible now (not started, agent live). */
	canChange: boolean;
	/** "Correct Mk…" is possible now (running, agent live). */
	canCorrect: boolean;
	/** "Redo from Mk…" is possible now (has an attempt to rewind to, server holds the session). */
	canRedo: boolean;
	/** The card's one primary button, or null when none applies now (replay, ended run without a session). */
	primary: "change" | "correct" | "redo" | null;
	/** Plain-text twin of the station's evidence graphic (`+5 −3 lines · tests 11 passed, 1 failed`). */
	evidenceText: string;
	/** `needs M2 · needed by M4`. */
	depsText: string;
	/** Station description for aria-describedby: evidence + deps (pre: `Read 3 files, ran 1 command`). */
	desc: string;
	/** Station tooltip with the module's real status (Metro swaps in `replaced` during a redo preview). */
	tip: string;
	/** pre only: the clock range it covers, e.g. `0:00–0:20` (before plan). */
	span?: string;
}

/** The action the Now bar shows (icon + object). */
export interface NowAction {
	id: string;
	type: ActType;
	icon: IconName;
	/** `pytest`, `shop/cart.py`, or the first word of a command. */
	object: string;
	/** `Current action: running pytest`. */
	label: string;
}

/** A note or correction you sent that has not reached the agent yet. */
export interface QueuedNote {
	interventionId: string;
	kind: "note" | "correct";
	/** The module a correction is for. */
	moduleId?: ModuleId;
	text: string;
	/** `m:ss` since run start when you sent it. */
	t: string;
}

/** "What happened" on the decision card: a glyph or icon, an optional module id, a short phrase. */
export interface WhatHappened {
	glyph?: GlyphStatus;
	icon?: IconName;
	/** Drawn in mono before the phrase. */
	mod?: ModuleId;
	/** `done, no passing test` / `Plan v1 · 4 modules` / `About to start M4`. */
	text: string;
	/** Full sentence for aria-label. */
	label: string;
	/** Tooltip: the held module's first flag text, else the label. */
	tip: string;
}

/** The decision card's content while the agent waits at a boundary. */
export interface DecisionView extends Decision {
	nextMod?: ModView;
	redoMod?: ModView;
	what: WhatHappened;
}

/**
 * Level 0, shared by both views.
 * - starting: running, no module active (before the plan, between modules) or no events yet;
 * - working: a module attempt is running; waiting: held at a boundary; stopped: aborted by you;
 * - finished: completed; error: the run ended with an error.
 */
export type NowKind = "starting" | "working" | "waiting" | "stopped" | "finished" | "error";

export interface NowView {
	kind: NowKind;
	/** working: the active module; waiting: the held boundary's module; stopped: the module stopped in/before. */
	module?: ModView;
	/** stopped: whether the agent was stopped inside `module` or before it started. */
	stoppedWhere?: "in" | "before";
	/** The current action (only while the run is live). */
	action?: NowAction;
	/** ms the agent has waited at the boundary (0 unless waiting). */
	wait: number;
	waitClock: string;
	/** ms since run start (ticks while live; frozen at the end or at the replay position). */
	runTime: number;
	runClock: string;
	/** working: the next module after the active one ("next Mk"). */
	next?: ModView;
	/** Segmented progress: plan modules and their statuses (modular view only). */
	progress: { id: ModuleId; status: StationStatus }[];
	flags: Flag[];
	/** Pause at the next boundary is armed (live only). */
	armed: boolean;
	/**
	 * Where an armed pause would hold the agent (pauseSlot; while held, the first boundary after
	 * Continue). The Metro shows exactly this marker; absent when the agent cannot act.
	 */
	slot?: Slot;
	/** Chip text for the slot: `after M3` / `after plan` / `before M4`. */
	slotLabel?: string;
	/** Present while held (waiting). */
	decision?: DecisionView;
	/** Notes and corrections not delivered yet (dot on the note button, popover list). */
	queued: QueuedNote[];
	/** The note popover's "when" line: `Reaches the agent after its current step (pytest)`. */
	when: string;
	/** For toasts: `after pytest` / `when it continues` / `after its current step`. */
	reaches: string;
	/** error: the run's error message. */
	error?: string;
}

/** Log event types: the mockup's types plus `say` (agent narration). */
export type LogType = "run" | "plan" | "module" | "read" | "edit" | "bash" | "test" | "user" | "say";

/** One planned module as proposed in a plan_version (the log's plan-row detail; no live status). */
export interface PlanItem {
	id: ModuleId;
	title: string;
	deps: ModuleId[];
	goal: string;
	criteria: string[];
	text: string;
}

/** What a log row expands into. */
export type LogDetail =
	| { kind: "act"; act: ActView }
	| { kind: "plan"; version: number; rationale?: string; modules: PlanItem[] }
	| { kind: "start"; moduleId: ModuleId; version: VersionView }
	| {
			kind: "finish";
			moduleId: ModuleId;
			attemptId: string;
			criteria: { text: string; st: CriterionStatus }[];
			summary?: string;
	  }
	| { kind: "versions"; moduleId: ModuleId }
	| { kind: "text"; icon?: IconName; glyph?: GlyphStatus; head: string; text: string }
	| { kind: "flags"; flags: Flag[] }
	| { kind: "none" };

/** One row of the log view (the mockup's `events()` entries), built from the trace in seq order. */
export interface LogEvent {
	/** Stable row id: `run0`, `a:<actionId>`, `plan:<v>`, `s:<attemptId>`, `f:<attemptId>`, `h:<boundaryId>`, … */
	id: string;
	seq: number;
	/** `m:ss` since run start. */
	t: string;
	/** Module tag: a module id, `pre`, `plan` or `run`. */
	mod: string;
	type: LogType;
	/** Leading icon, or a status glyph instead. */
	icon?: IconName;
	glyph?: GlyphStatus;
	/** One-line summary. */
	text: string;
	detail: LogDetail;
	/** Flags anchored on this row. */
	flags: Flag[];
	flag: boolean;
	/** The action of an action row. */
	act?: ActView;
	/** plan: a plan row (carries Change Mk); start/finish: an attempt's start or finish row (carries Redo). */
	kind?: "plan" | "start" | "finish";
	moduleId?: ModuleId;
	attemptId?: string;
	/** plan rows: this is the latest plan; start/finish rows: the module's shown attempt (not replaced). */
	current?: boolean;
	/** user notes/corrections: not delivered yet. */
	queued?: boolean;
}

/** The run summary (finished, nothing selected). */
export interface SummaryView {
	status: RunStatus;
	runClock: string;
	flags: Flag[];
	/** Whole-run files: live attempts' fileStats summed per path, with the modules that changed them. */
	files: { path: string; add: number; del: number; by: SelId[] }[];
	total: { files: number; add: number; del: number };
	audit?: {
		missing: number;
		assigned: number;
		unassigned: number;
		unattributed: { attemptId: string | null; path: string }[];
	};
}

/** Inputs besides the state: the trace it was reduced from, the clock, and the server's control state. */
export interface PanelContext {
	/** The events `state` was reduced from, in seq order (for the log and for ordering). */
	events: readonly TraceEvent[];
	/** Wall-clock ms used for ticking clocks (Date.now() while live; the scrub position's event time in replay). */
	now: number;
	/** The server's control state for this run (absent for recorded runs). */
	control?: RunControlState;
	/** Rendering a scrubbed-back replay position: every control is hidden as in a finished run. */
	replaying: boolean;
}

/** The whole view model. */
export interface Panel {
	runId?: string;
	taskId?: string;
	variant?: string;
	model?: string;
	/** First line of the task prompt (the pre station's goal, the summary text). */
	task: string;
	prompt: string;
	status: RunStatus;
	/** The agent can act on controls now: isLive(state) && control.live && !replaying. */
	live: boolean;
	/** The server still holds the session (redo works even after the run ended): control.live && !replaying. */
	serverHeld: boolean;
	replaying: boolean;
	/** The server is setting up a redo (control.busy): another redo is refused until it is done. */
	busy: boolean;
	/** The agent is working right now (not held at a boundary), so a redo stops it first ("Stop & redo"). */
	running: boolean;
	/** Wall-clock ms the run started (first event), if any. */
	startedAt?: number;
	/** The before-plan / outside-modules station. */
	pre: ModView;
	/** Plan modules in plan order. */
	modules: ModView[];
	/** Plan module ids in order. */
	ids: ModuleId[];
	/** Every station by id, including `PRE` and dropped modules. */
	byId: Record<SelId, ModView>;
	/** Declared dependency edges between plan modules: [from (prerequisite), to]. */
	edges: [ModuleId, ModuleId][];
	/** All flags (computeFlags). */
	flags: Flag[];
	now: NowView;
	/** Log rows, oldest first. */
	events: LogEvent[];
	/** Present once the run has ended (also for a recorded run whose trace never ended). */
	summary?: SummaryView;
	/** The selection when you have not picked one: the active/held module; null after the run ends. */
	defaultSel: SelId | null;
	/** Latest plan version and module count, if a plan exists. */
	plan?: { version: number; count: number };
}

// ---- helpers ---------------------------------------------------------------------------------

/** `after M3` / `after plan` / `before M4` for a slot (the armed chip, the pause tooltip). */
export function slotLabel(slot: Pick<Slot, "after" | "boundary" | "moduleId">): string {
	if (slot.boundary === "before_start" && slot.moduleId) return `before ${slot.moduleId}`;
	return slot.after ? `after ${slot.after}` : "after plan";
}

/** What a redo from a module would do (the redo panel's consequence preview and the Metro's cut). */
export interface RedoPreview {
	moduleId: ModuleId;
	/** The attempt the server rewinds to (revise.attemptId). */
	attemptId: string;
	/** Plan modules before it whose work stays. */
	kept: ModuleId[];
	/** Attempts the redo replaces: the target's and every one that started after it. */
	affected: { id: ModuleId; n: number; attemptId: string }[];
	/** Files of the affected attempts that are restored. */
	files: string[];
	/** The agent is working now, so the redo stops it first ("Stop & redo"). */
	running: boolean;
	/** Log row where the cut is drawn (the target attempt's start row). */
	cutRow: string;
	/** Log rows kept before the cut, and all rows (for the rewind strip's label). */
	keepEvents: number;
	totalEvents: number;
}

/** The consequences of "Redo from `moduleId`", or undefined if it has no attempt to rewind to. */
export function redoPreview(panel: Panel, moduleId: ModuleId): RedoPreview | undefined {
	const target = panel.byId[moduleId];
	if (!target || target.isPre || !target.attemptId || target.startSeq === undefined) return undefined;
	const from = target.startSeq;
	const affected = [...panel.modules, ...Object.values(panel.byId).filter((m) => !m.inPlan && !m.isPre)]
		.filter((m) => m.status !== "replaced" && m.startSeq !== undefined && m.startSeq >= from && m.attemptId)
		.sort((a, b) => (a.startSeq ?? 0) - (b.startSeq ?? 0))
		.map((m) => ({ id: m.id, n: m.attemptN ?? 1, attemptId: m.attemptId as string }));
	if (!affected.some((a) => a.id === moduleId)) {
		affected.unshift({ id: moduleId, n: target.attemptN ?? 1, attemptId: target.attemptId });
	}
	const hit = new Set(affected.map((a) => a.id));
	const index = panel.ids.indexOf(moduleId);
	const kept = panel.ids.slice(0, Math.max(0, index)).filter((id) => !hit.has(id));
	const files: string[] = [];
	for (const a of affected) {
		for (const f of panel.byId[a.id]?.files ?? []) if (!files.includes(f.path)) files.push(f.path);
	}
	const cutRow = `s:${target.attemptId}`;
	const at = panel.events.findIndex((e) => e.id === cutRow);
	return {
		moduleId,
		attemptId: target.attemptId,
		kept,
		affected,
		files,
		running: panel.running,
		cutRow,
		keepEvents: Math.max(1, at),
		totalEvents: panel.events.length,
	};
}

/**
 * The status a station shows: its real status, or `replaced` while a redo panel for `redoTarget`
 * is open and the redo would replace it (the mockup's `shownStatus`).
 */
export function shownStatus(panel: Panel, redoTarget: ModuleId | null | undefined, id: SelId): StationStatus {
	const m = panel.byId[id];
	if (!m) return "pending";
	if (!redoTarget || m.isPre || m.status === "pending") return m.status;
	const preview = redoPreview(panel, redoTarget);
	return preview?.affected.some((a) => a.id === id) ? "replaced" : m.status;
}

// ---- buildPanel ------------------------------------------------------------------------------

/** Builds the panel view model for one run state. Pure. */
export function buildPanel(state: RunState, ctx: PanelContext): Panel {
	// a recorded run whose trace never ended (the server restarted mid-run) is not running any more:
	// show it as stopped, not as working
	const incomplete = !ctx.replaying && !!ctx.control && !ctx.control.live && isLive(state);
	const shown: RunState = incomplete ? { ...state, status: "aborted", pendingBoundary: undefined } : state;
	const b = new Builder(shown, ctx);
	return b.build();
}

const VERB: Record<ActType, string> = { read: "Read", write: "Write", edit: "Edit", bash: "Run", test: "Run" };
const NOW_VERB: Record<ActType, string> = {
	read: "reading",
	write: "writing",
	edit: "editing",
	bash: "running",
	test: "running",
};

class Builder {
	private readonly start: number;
	private readonly liveRun: boolean;
	private readonly flags: Flag[];
	private readonly stoppedByYou: boolean;
	private readonly acts = new Map<string, ActView>();
	/** Per intervention id: the module (and attempt) a note or correction reached or will reach. */
	private readonly noteTarget = new Map<string, { moduleId?: ModuleId; attemptId?: string }>();
	private readonly interventionSeq = new Map<string, number>();
	private readonly endTime: number;
	private readonly state: RunState;
	private readonly ctx: PanelContext;

	constructor(state: RunState, ctx: PanelContext) {
		this.state = state;
		this.ctx = ctx;
		this.start = state.startedAt ?? ctx.events[0]?.t ?? ctx.now;
		this.liveRun = isLive(state);
		this.flags = computeFlags(state);
		this.stoppedByYou = stoppedByYou(state);
		this.endTime = this.liveRun ? ctx.now : (state.endedAt ?? ctx.events.at(-1)?.t ?? ctx.now);
		this.walkInterventions();
	}

	private rel(t: number | undefined): string {
		return clock((t ?? this.start) - this.start);
	}

	/** Works out where each note/correction landed: the attempt active when it was delivered (or sent). */
	private walkInterventions(): void {
		let active: string | null = null;
		const pending = new Map<string, number>(); // intervention id → index of its target event
		const activeAt: (string | null)[] = [];
		const starts: { seq: number; attemptId: string }[] = [];
		// the boundary the agent was held at, per trace position (where a note sent while held belongs)
		let held: { moduleId?: ModuleId; seq: number } | undefined;
		const heldAt: ({ moduleId?: ModuleId; seq: number } | undefined)[] = [];
		for (const event of this.ctx.events) {
			if (event.type === "attempt_started") {
				active = event.attempt.attemptId;
				starts.push({ seq: event.seq, attemptId: active });
			} else if (event.type === "attempt_ended" && active === event.attemptId) active = null;
			else if (event.type === "attempts_invalidated" && active && event.attemptIds.includes(active)) active = null;
			else if (event.type === "boundary_paused") held = { moduleId: event.moduleId, seq: event.seq };
			else if (event.type === "boundary_resumed" || event.type === "run_ended") held = undefined;
			activeAt[event.seq] = active;
			heldAt[event.seq] = held;
			if (event.type === "intervention") {
				this.interventionSeq.set(event.intervention.interventionId, event.seq);
				pending.set(event.intervention.interventionId, event.seq);
			} else if (event.type === "intervention_delivered") pending.set(event.interventionId, event.seq);
		}
		for (const intervention of this.state.interventions) {
			if (intervention.kind !== "note" && intervention.kind !== "correct") continue;
			const seq = pending.get(intervention.interventionId);
			if (seq === undefined) continue;
			const attemptId = activeAt[seq] ?? starts.find((s) => s.seq > seq)?.attemptId ?? undefined;
			const attemptModule = attemptId ? this.state.attempts[attemptId]?.moduleId : undefined;
			if (intervention.kind === "correct" && intervention.moduleId) {
				this.noteTarget.set(intervention.interventionId, {
					moduleId: intervention.moduleId,
					attemptId: attemptModule === intervention.moduleId ? attemptId : undefined,
				});
			} else if (attemptModule) {
				this.noteTarget.set(intervention.interventionId, { moduleId: attemptModule, attemptId });
			} else {
				// no attempt took it (yet): while still held, the module it continues to; else the module of the
				// boundary it was sent at; else the before-plan / outside-modules station
				const sentAt = this.interventionSeq.get(intervention.interventionId) ?? seq;
				const boundary = heldAt[sentAt];
				const pending = decision(this.state);
				const stillHeld = !!boundary && !!pending && boundary.seq === this.boundaryPausedSeq(pending.boundaryId);
				const moduleId = (stillHeld ? pending?.next : undefined) ?? boundary?.moduleId ?? PRE;
				this.noteTarget.set(intervention.interventionId, { moduleId });
			}
		}
	}

	private boundaryPausedSeq(boundaryId: string): number | undefined {
		return this.ctx.events.findLast((e) => e.type === "boundary_paused" && e.boundaryId === boundaryId)?.seq;
	}

	// ---- actions --------------------------------------------------------------------------------

	private act(action: Action): ActView {
		const cached = this.acts.get(action.actionId);
		if (cached) return cached;
		const state = this.state;
		const moduleId = action.attemptId ? (state.attempts[action.attemptId]?.moduleId ?? null) : null;
		const test = isTest(action);
		const done = action.endedAt !== undefined;
		// a redo that stopped its attempt cut it off too (it never gets a result)
		const cut = !!action.attemptId && state.attempts[action.attemptId]?.status === "invalidated";
		const live = !done && this.liveRun && !cut;
		const stopped = !done && (!this.liveRun || cut);
		const path = actionPath(state, action);
		const args = action.args;
		const command = typeof args.command === "string" ? args.command : undefined;
		const str = (v: unknown) => (typeof v === "string" ? v : "");
		// pi rejected a call with invalid arguments (the host recorded it with none): never invent a path
		const named =
			path ??
			(action.source === "host"
				? /"(?:path|file_path)"\s*:\s*"([^"]+)"/.exec(action.resultPreview ?? "")?.[1]
				: undefined);
		const noPath = "(invalid arguments)";
		const pathCall = (tool: string) =>
			named ? `${tool}(path="${named}")` : `${tool}(${oneLine(JSON.stringify(args), 160)})`;
		let type: ActType;
		let target: string;
		let cmd: string | undefined;
		let call: string;
		switch (action.tool) {
			case "read":
				type = "read";
				target = named ?? noPath;
				call = pathCall("read");
				break;
			case "write":
			case "edit":
				type = action.tool === "write" ? "write" : "edit";
				target = named ?? noPath;
				call = pathCall(action.tool);
				break;
			case "grep":
			case "find":
				type = "bash";
				cmd = `${action.tool} ${str(args.pattern)}`.trim();
				target = cmd;
				call = `${action.tool}(pattern="${str(args.pattern)}"${args.path ? `, path="${str(args.path)}"` : ""})`;
				break;
			case "ls":
				type = "bash";
				cmd = `ls ${str(args.path)}`.trim();
				target = cmd;
				call = `ls(${args.path ? `path="${str(args.path)}"` : ""})`;
				break;
			default:
				if (command !== undefined || action.tool === "bash") {
					type = test ? "test" : "bash";
					cmd = command ?? "";
					target = test ? commandName(cmd) : oneLine(cmd, 120);
					call = `bash("${oneLine(cmd, 200)}")`;
				} else {
					type = "bash";
					target = action.tool;
					call = `${action.tool}(${oneLine(JSON.stringify(args), 160)})`;
				}
		}
		if (test) type = "test";

		let add = 0;
		let del = 0;
		let diff: CodeLine[] = [];
		if ((type === "write" || type === "edit") && done && !action.isError) {
			for (const change of action.fileChanges ?? []) {
				if (change.patch) {
					const s = diffStats(change.patch);
					add += s.add;
					del += s.del;
					diff = diff.concat(parsePatch(change.patch));
				} else if (typeof args.content === "string") {
					const lines = newFileLines(args.content);
					add += lines.length - 1;
					diff = diff.concat(lines);
				}
			}
			if (!action.fileChanges?.length && typeof args.content === "string") {
				diff = newFileLines(args.content);
				add = diff.length - 1;
			}
		}

		let out: CodeLine[];
		if (type === "read") out = textLines(action.resultPreview);
		else if (type === "write" || type === "edit") out = action.isError ? textLines(action.resultPreview) : [];
		else out = outputLines(action.resultPreview, cmd ?? target);
		if (live && type !== "read") out = [...out, ["h", "  running …"]];
		if (stopped) {
			out = [...out, ["h", `  stopped${this.stoppedByYou ? " by you" : ""} before ${target} finished`]];
		}

		const view: ActView = {
			id: action.actionId,
			seq: state.actionSeq[action.actionId] ?? -1,
			t: this.rel(action.startedAt),
			at: action.startedAt,
			moduleId,
			attemptId: action.attemptId,
			tool: action.tool,
			type,
			target,
			cmd,
			path,
			lines: type === "read" && done ? lineCount(action.resultPreview) : undefined,
			add,
			del,
			diff: capLines(diff),
			out: capLines(out),
			pass: action.test?.passed ?? 0,
			fail: (action.test?.failed ?? 0) + (action.test?.errors ?? 0),
			live,
			stopped,
			exit: !test && done && action.isError === true,
			call,
			flags: this.flags.filter((f) => f.actionId === action.actionId && f.rule !== "unverified"),
		};
		this.acts.set(action.actionId, view);
		return view;
	}

	// ---- modules --------------------------------------------------------------------------------

	private version(v: ModuleVersion): VersionView {
		return {
			v: v.version,
			by: v.author === "user" ? "you" : "agent",
			t: this.rel(v.createdAt),
			text: v.instructions,
			note: v.reason,
		};
	}

	private tests(actions: ActView[]): TestsView | null {
		const latest = actions.filter((a) => a.type === "test").at(-1);
		if (!latest) return null;
		return { pass: latest.pass, fail: latest.fail, live: latest.live, stopped: latest.stopped, act: latest };
	}

	private files(attempt: Attempt | null): FileView[] {
		return fileStats(this.state, attempt).map((f) => ({ ...f, diff: capLines(parsePatch(f.patch)) }));
	}

	private steps(
		owner: SelId,
		actions: ActView[],
		narration: { seq: number; t: number; text: string; where?: string }[],
	): StepView[] {
		type Raw =
			| { kind: "act"; seq: number; act: ActView }
			| { kind: "say"; seq: number; t: number; text: string; where?: string }
			| {
					kind: "you";
					seq: number;
					t: number;
					what: "note" | "correct";
					text: string;
					queued: boolean;
					id: string;
					attemptN?: number;
			  };
		const raw: Raw[] = [
			...actions.map((act): Raw => ({ kind: "act", seq: act.seq, act })),
			...narration.map((n): Raw => ({ kind: "say", seq: n.seq, t: n.t, text: n.text, where: n.where })),
		];
		const shown = this.state.modules[owner] ? this.shownAttempt(owner)?.attemptId : undefined;
		for (const i of this.state.interventions) {
			if (i.kind !== "note" && i.kind !== "correct") continue;
			const target = this.noteTarget.get(i.interventionId);
			if (!target || target.moduleId !== owner) continue;
			// what reached an attempt a redo replaced stays reviewable here, marked with that attempt
			const replaced = target.attemptId && shown && target.attemptId !== shown ? target.attemptId : undefined;
			raw.push({
				kind: "you",
				seq: this.interventionSeq.get(i.interventionId) ?? 0,
				t: i.at,
				what: i.kind,
				text: i.note ?? "",
				queued: i.deliveredAt === undefined,
				id: i.interventionId,
				attemptN: replaced ? this.state.attempts[replaced]?.n : undefined,
			});
		}
		raw.sort((a, b) => a.seq - b.seq);
		const out: StepView[] = [];
		for (let i = 0; i < raw.length; i++) {
			const r = raw[i] as Raw;
			// runs of 2+ finished, successful reads fold; a failed, running or cut-off read stays its own row
			const foldable = (x: Raw) =>
				x.kind === "act" && x.act.type === "read" && !x.act.exit && !x.act.live && !x.act.stopped;
			if (foldable(r)) {
				let j = i;
				const items: ActView[] = [];
				for (; j < raw.length; j++) {
					const next = raw[j] as Raw;
					if (next.kind !== "act" || !foldable(next)) break;
					items.push(next.act);
				}
				if (items.length >= 2) {
					const first = items[0] as ActView;
					out.push({ kind: "fold", key: `${owner}:fold:${first.id}`, seq: first.seq, t: first.t, items });
					i = j - 1;
					continue;
				}
			}
			if (r.kind === "act") out.push({ kind: "act", key: `${owner}:${r.act.id}`, seq: r.seq, t: r.act.t, act: r.act });
			else if (r.kind === "say")
				out.push({
					kind: "say",
					key: `${owner}:say:${r.seq}`,
					seq: r.seq,
					t: this.rel(r.t),
					text: r.text,
					...(r.where ? { where: r.where } : {}),
				});
			else
				out.push({
					kind: "you",
					key: `${owner}:you:${r.id}`,
					seq: r.seq,
					t: this.rel(r.t),
					what: r.what,
					text: r.text,
					queued: r.queued,
					interventionId: r.id,
					...(r.attemptN ? { attemptN: r.attemptN } : {}),
				});
		}
		return out;
	}

	private shownAttempt(id: ModuleId): Attempt | undefined {
		return currentAttempt(this.state, id) ?? attemptsOf(this.state, id).at(-1);
	}

	private module(id: ModuleId, plan: ModuleId[], live: boolean, serverHeld: boolean): ModView {
		const state = this.state;
		const module = state.modules[id];
		if (!module) throw new Error(`unknown module ${id}`);
		const latest = module.latest;
		const attempt = this.shownAttempt(id);
		const status = displayStatus(state, id);
		// a finished module shows the definition its attempt ran (a later re-plan may restate it); one that
		// has not started (or was replaced) shows the latest, which its next attempt will use
		const ended = !!attempt && attempt.status !== "running" && status !== "pending" && status !== "replaced";
		const ran = (ended && module.versions.find((v) => v.version === attempt?.moduleVersion)) || latest;
		const actions = attempt ? actionsOf(state, attempt.attemptId).map((a) => this.act(a)) : [];
		const narration = attempt ? state.narration.filter((n) => n.attemptId === attempt.attemptId) : [];
		const flags = this.flags.filter((f) => f.moduleId === id);
		const deps = latest.dependsOn.filter((d) => plan.includes(d) && d !== id);
		const dependents = plan.filter((other) => state.modules[other]?.latest.dependsOn.includes(id) && other !== id);
		const versions = module.versions.map((v) => this.version(v));
		const tests = this.tests(actions);
		const files = attempt ? this.files(attempt) : [];
		const looked: string[] = [];
		for (const a of actions) if (a.type === "read" && a.path && !looked.includes(a.path)) looked.push(a.path);
		const crit = criteria(state, id).map((c) => ({ text: c.text, st: c.status }));
		const end = attempt?.endedAt;
		const durEnd = end ?? (attempt ? this.endTime : undefined);
		const rewindable = !!attempt && !!attempt.startEntryId && !!attempt.startCheckpoint;
		const canChange = live && (status === "pending" || status === "replaced");
		const canCorrect = live && status === "working";
		const canRedo = serverHeld && rewindable && status !== "pending" && status !== "replaced";
		const primary =
			status === "pending" || status === "replaced"
				? canChange
					? "change"
					: null
				: status === "working"
					? canCorrect
						? "correct"
						: canRedo
							? "redo"
							: null
					: canRedo
						? "redo"
						: null;
		const view: ModView = {
			id,
			isPre: false,
			title: latest.title,
			short: shortLabel(latest),
			deps,
			dependents,
			goal: ran.purpose,
			instr: ran.instructions,
			status,
			flag: flags.length > 0,
			flags,
			start: attempt ? this.rel(attempt.startedAt) : undefined,
			end: end !== undefined ? this.rel(end) : undefined,
			dur: attempt && durEnd !== undefined ? clock(durEnd - attempt.startedAt) : undefined,
			criteria: crit,
			files,
			tests,
			looked,
			actions,
			steps: this.steps(id, actions, narration),
			versions,
			cur: this.version(ran),
			attempts: attemptsOf(state, id).map((a) => ({
				attemptId: a.attemptId,
				n: a.n,
				status: a.status,
				replaced: a.status === "invalidated",
				current: a.attemptId === attempt?.attemptId,
			})),
			attemptId: attempt?.attemptId,
			attemptN: attempt?.n,
			startSeq: attempt ? state.attemptSeq[attempt.attemptId]?.start : undefined,
			inPlan: module.inPlan,
			canChange,
			canCorrect,
			canRedo,
			primary,
			evidenceText: "",
			depsText: "",
			desc: "",
			tip: "",
		};
		view.evidenceText = evidenceText(view);
		view.depsText = depsText(view);
		// after a redo the shown evidence is the replaced attempt's, not current work
		const evidence =
			status === "replaced" && view.evidenceText ? `replaced attempt: ${view.evidenceText}` : view.evidenceText;
		view.desc = [evidence, view.depsText].filter(Boolean).join(" · ");
		view.tip = `${id} · ${view.title} — ${STATUS_LABEL[status]}${view.desc ? ` · ${view.desc}` : ""}`;
		return view;
	}

	private pre(): ModView {
		const state = this.state;
		const firstPlanSeq = state.firstPlanSeq ?? Number.POSITIVE_INFINITY;
		const actions = actionsOf(state, null).map((a) => this.act(a));
		const outside = actions.some((a) => a.seq > firstPlanSeq);
		if (outside) for (const a of actions) a.where = a.seq < firstPlanSeq ? "before plan" : this.whereAt(a.seq);
		// unassigned narration after the plan (between modules, the final report, acknowledgments) belongs
		// here too, tagged with where it happened as unassigned actions are
		const narration = state.narration
			.filter((n) => n.attemptId === null)
			.map((n) => (n.seq > firstPlanSeq ? { ...n, where: this.whereAt(n.seq) } : n));
		const flags = this.flags.filter((f) => !f.moduleId);
		const reads = actions.filter((a) => a.type === "read");
		const looked: string[] = [];
		for (const a of reads) if (a.path && !looked.includes(a.path)) looked.push(a.path);
		const commands = actions.filter((a) => a.type === "bash" || a.type === "test");
		const planAt = state.firstPlanSeq !== undefined ? this.ctx.events[state.firstPlanSeq]?.t : undefined;
		const tipParts = [
			looked.length ? `read ${looked.join(", ")}` : "",
			commands.length ? `ran ${[...new Set(commands.map((c) => c.target))].join(", ")}` : "",
		].filter(Boolean);
		const descParts = [
			reads.length ? `Read ${plural(looked.length, "file")}` : "",
			commands.length ? `ran ${plural(commands.length, "command")}` : "",
		].filter(Boolean);
		const title = outside ? "Outside modules" : "Before plan";
		const files = this.files(null);
		const desc = descParts.join(", ");
		return {
			id: PRE,
			isPre: true,
			title,
			short: "",
			deps: [],
			dependents: [],
			goal: this.task(),
			instr: "",
			status: "pre",
			flag: flags.length > 0,
			flags,
			criteria: [],
			files,
			tests: this.tests(actions),
			looked,
			actions,
			steps: this.steps(PRE, actions, narration),
			versions: [],
			cur: { v: 0, by: "agent", t: "0:00", text: this.task() },
			attempts: [],
			inPlan: true,
			canChange: false,
			canCorrect: false,
			canRedo: false,
			primary: null,
			evidenceText: desc,
			depsText: "",
			desc: desc.charAt(0).toUpperCase() + desc.slice(1),
			tip: tipParts.length ? `${title}: ${tipParts.join(" · ")}` : title,
			span: outside ? undefined : `0:00–${planAt !== undefined ? this.rel(planAt) : this.rel(this.endTime)}`,
		};
	}

	/** For an unassigned action after the plan: `after Mk` (the latest attempt that ended before it) or `after plan`. */
	private whereAt(seq: number): string {
		let last: string | undefined;
		for (const id of this.state.attemptOrder) {
			const end = this.state.attemptSeq[id]?.end;
			if (end !== undefined && end < seq) last = this.state.attempts[id]?.moduleId;
		}
		return last ? `after ${last}` : "after plan";
	}

	private task(): string {
		return firstLine(this.state.prompt ?? "") || this.state.run?.taskId || "";
	}

	// ---- build ----------------------------------------------------------------------------------

	build(): Panel {
		const { state, ctx } = this;
		const live = this.liveRun && !!ctx.control?.live && !ctx.replaying;
		const serverHeld = !!ctx.control?.live && !ctx.replaying;
		const ids = planModules(state);
		const byId: Record<SelId, ModView> = {};
		const pre = this.pre();
		byId[PRE] = pre;
		for (const id of state.moduleOrder) byId[id] = this.module(id, ids, live, serverHeld);
		const modules = ids.flatMap((id) => byId[id] ?? []);
		const edges: [ModuleId, ModuleId][] = [];
		for (const m of modules) for (const d of m.deps) edges.push([d, m.id]);
		// the agent is streaming (in a module, re-planning, or writing its report), not held at a boundary
		const running = live && state.status === "running";
		const panelBase = {
			runId: state.run?.runId,
			taskId: state.run?.taskId,
			variant: state.run?.variant,
			model: state.run?.model,
			task: this.task(),
			prompt: state.prompt ?? "",
			status: state.status,
			live,
			serverHeld,
			replaying: ctx.replaying,
			busy: !!ctx.control?.busy,
			running,
			startedAt: state.startedAt,
			pre,
			modules,
			ids,
			byId,
			edges,
			flags: this.flags,
			plan: state.plans.length
				? { version: state.plans.at(-1)?.version ?? 1, count: state.plans.at(-1)?.moduleOrder.length ?? 0 }
				: undefined,
		};
		const now = this.now(byId, modules, live);
		const events = this.events(byId);
		const panel: Panel = {
			...panelBase,
			now,
			events,
			summary: this.liveRun || state.status === "idle" ? undefined : this.summary(byId, now.runClock),
			defaultSel: this.defaultSel(now),
		};
		return panel;
	}

	private defaultSel(now: NowView): SelId | null {
		const state = this.state;
		if (!this.liveRun) return state.status === "idle" ? PRE : null;
		if (now.kind === "working" || now.kind === "waiting") {
			const d = now.decision;
			if (d) return (d.boundary === "before_start" ? d.moduleId : d.after) ?? d.moduleId ?? d.next ?? PRE;
			return now.module?.id ?? PRE;
		}
		const last = state.attemptOrder.at(-1);
		const lastModule = last ? state.attempts[last]?.moduleId : undefined;
		return lastModule && planModules(state).includes(lastModule) ? lastModule : PRE;
	}

	private now(byId: Record<SelId, ModView>, modules: ModView[], live: boolean): NowView {
		const state = this.state;
		const ctx = this.ctx;
		const runTime = Math.max(0, this.endTime - this.start);
		const active = state.activeAttemptId ? state.attempts[state.activeAttemptId] : undefined;
		const pending = state.pendingBoundary;
		const raw = decision(state);
		let kind: NowKind;
		if (pending && raw) kind = "waiting";
		else if (state.status === "running" && active) kind = "working";
		else if (state.status === "running" || state.status === "paused" || state.status === "idle") kind = "starting";
		else if (state.status === "aborted") kind = "stopped";
		else if (state.status === "error") kind = "error";
		else kind = "finished";

		let module: ModView | undefined;
		let stoppedWhere: "in" | "before" | undefined;
		if (kind === "working" && active) module = byId[active.moduleId];
		else if (kind === "waiting" && raw) {
			const id = raw.boundary === "before_start" ? raw.moduleId : (raw.after ?? undefined);
			module = id ? byId[id] : undefined;
		} else if (kind === "stopped" || kind === "error") {
			// the module whose attempt was still running when the run ended; else the one it would start next;
			// a module the agent itself finished as failed only when neither applies
			const open = state.attemptOrder.flatMap((id) => state.attempts[id] ?? []).findLast((a) => a.status === "running");
			const next = open ? undefined : nextModule(state, lastEnded(state)?.moduleId);
			const failed = kind === "error" ? modules.findLast((m) => m.status === "failed") : undefined;
			if (open) {
				module = byId[open.moduleId];
				stoppedWhere = module ? "in" : undefined;
			} else if (next) {
				module = byId[next];
				stoppedWhere = module ? "before" : undefined;
			} else if (failed) {
				module = failed;
				stoppedWhere = "in";
			}
		}

		const current = currentAction(state);
		const actView = current ? this.act(current) : undefined;
		const action: NowAction | undefined =
			actView && this.liveRun
				? {
						id: actView.id,
						type: actView.type,
						icon: actView.type === "test" ? "term" : ACT_ICON[actView.type],
						object: actView.type === "bash" ? commandName(actView.cmd ?? actView.target) : actView.target,
						label: "",
					}
				: undefined;
		if (action) action.label = `Current action: ${NOW_VERB[actView?.type ?? "bash"]} ${action.object}`;

		let decisionView: DecisionView | undefined;
		if (kind === "waiting" && raw) decisionView = { ...raw, ...this.decisionExtras(raw, byId) };

		const slot = live ? (pauseSlot(state) ?? (raw ? this.slotAfterContinue(raw) : undefined)) : undefined;
		const next = kind === "working" && active ? nextModule(state, active.moduleId) : undefined;
		const queued: QueuedNote[] = queuedNotes(state).map((i) => ({
			interventionId: i.interventionId,
			kind: i.kind === "correct" ? "correct" : "note",
			moduleId: i.moduleId,
			text: i.note ?? "",
			t: this.rel(i.at),
		}));
		const held = kind === "waiting";
		const continuesTo = decisionView?.next ? ` to ${decisionView.next}` : "";
		const when = held
			? `Reaches the agent when it continues${continuesTo}`
			: action
				? `Reaches the agent after its current step (${action.object})`
				: "Reaches the agent after its current step";
		const reaches = held ? "when it continues" : action ? `after ${action.object}` : "after its current step";
		return {
			kind,
			module,
			stoppedWhere,
			action,
			wait: held && pending ? Math.max(0, ctx.now - pending.since) : 0,
			waitClock: clock(held && pending ? ctx.now - pending.since : 0),
			runTime,
			runClock: clock(runTime),
			next: next ? byId[next] : undefined,
			progress: modules.map((m) => ({ id: m.id, status: m.status })),
			flags: this.flags,
			// the automatic pause after the first plan holds the agent just as an armed one does
			armed: live && (!!ctx.control?.pauseAtBoundary || (!!ctx.control?.pauseAfterPlan && state.plans.length === 0)),
			slot,
			slotLabel: slot ? slotLabel(slot) : undefined,
			decision: decisionView,
			queued,
			when,
			reaches,
			error: kind === "error" ? state.error : undefined,
		};
	}

	/**
	 * While the agent is held, the boundary an armed pause would hold it at after Continue: after Mk
	 * when held before Mk starts; before the next module when held after the plan or after a module.
	 */
	private slotAfterContinue(d: Decision): Slot | undefined {
		if (d.boundary === "before_start" && d.moduleId) {
			return { after: d.moduleId, boundary: "after_finish", moduleId: d.moduleId };
		}
		if (!d.next) return undefined;
		const order = planModules(this.state);
		const i = order.indexOf(d.next);
		return { after: i > 0 ? (order[i - 1] ?? null) : null, boundary: "before_start", moduleId: d.next };
	}

	private decisionExtras(raw: Decision, byId: Record<SelId, ModView>): Omit<DecisionView, keyof Decision> {
		const nextMod = raw.next ? byId[raw.next] : undefined;
		const redoMod = raw.redo ? byId[raw.redo.moduleId] : undefined;
		let what: WhatHappened;
		if (raw.boundary === "after_plan") {
			const count = this.state.plans.at(-1)?.moduleOrder.length ?? 0;
			const text = `Plan v${this.state.plans.at(-1)?.version ?? 1} · ${plural(count, "module")}`;
			what = { icon: "plan", text, label: text, tip: text };
		} else if (raw.boundary === "before_start") {
			const text = `About to start ${raw.moduleId ?? ""}`.trim();
			what = { glyph: "pending", text, label: text, tip: text };
		} else {
			const held = raw.after ? byId[raw.after] : undefined;
			const status = held?.status ?? "pending";
			const label = `${raw.after ?? ""} ${STATUS_SENTENCE[status]}`.trim();
			what = {
				glyph: status,
				mod: raw.after ?? undefined,
				text: STATUS_PHRASE[status],
				label,
				tip: held?.flags[0]?.text ?? label,
			};
		}
		return { nextMod, redoMod, what };
	}

	// ---- log ------------------------------------------------------------------------------------

	private events(byId: Record<SelId, ModView>): LogEvent[] {
		const state = this.state;
		const rows: LogEvent[] = [];
		const latestPlan = state.plans.at(-1)?.version;
		let active: string | null = null;
		let planned = false;
		const startSeqs = this.ctx.events.filter((e) => e.type === "attempt_started");
		// a redo after the run ended appends a second audit and run end: later repeats get their seq as a suffix
		const used = new Set<string>();
		const row = (r: Omit<LogEvent, "flags" | "flag">) => {
			const id = used.has(r.id) ? `${r.id}:${r.seq}` : r.id;
			used.add(id);
			rows.push({ ...r, id, flags: [], flag: false });
		};
		for (const event of this.ctx.events) {
			const t = this.rel(event.t);
			const seq = event.seq;
			switch (event.type) {
				case "run_started":
					row({
						id: "run0",
						seq,
						t,
						mod: "run",
						type: "run",
						icon: "playc",
						text: "Run started",
						detail: { kind: "text", icon: "playc", head: "task", text: event.prompt },
					});
					break;
				case "plan_version": {
					planned = true;
					const n = event.plan.moduleOrder.length;
					const items = event.plan.moduleOrder.map((id): PlanItem => {
						const v =
							event.modules.find((m) => m.moduleId === id) ??
							state.modules[id]?.versions.filter((x) => x.createdAt <= event.t).at(-1) ??
							state.modules[id]?.latest;
						return {
							id,
							title: v?.title ?? id,
							deps: (v?.dependsOn ?? []).filter((d) => event.plan.moduleOrder.includes(d)),
							goal: v?.purpose ?? "",
							criteria: v?.validation ?? [],
							text: v?.instructions ?? "",
						};
					});
					row({
						id: `plan:${event.plan.version}`,
						seq,
						t,
						mod: "plan",
						type: "plan",
						icon: "plan",
						text: `Plan v${event.plan.version} · ${plural(n, "module")}`,
						detail: { kind: "plan", version: event.plan.version, rationale: event.plan.rationale, modules: items },
						kind: "plan",
						current: event.plan.version === latestPlan,
					});
					break;
				}
				case "module_version": {
					const m = event.module;
					const you = m.author === "user";
					row({
						id: `v:${m.moduleId}:${m.version}`,
						seq,
						t,
						mod: m.moduleId,
						type: "plan",
						icon: you ? "user" : "bot",
						text: `${m.moduleId} instructions v${m.version} · by ${you ? "you" : "agent"}`,
						detail: { kind: "versions", moduleId: m.moduleId },
						moduleId: m.moduleId,
					});
					break;
				}
				case "attempt_started": {
					const a = event.attempt;
					active = a.attemptId;
					const m = state.modules[a.moduleId];
					const v = m?.versions.find((x) => x.version === a.moduleVersion) ?? m?.latest;
					row({
						id: `s:${a.attemptId}`,
						seq,
						t,
						mod: a.moduleId,
						type: "module",
						icon: "playc",
						text: `Start ${a.moduleId} · ${v?.title ?? a.moduleId}${a.n > 1 ? ` #${a.n}` : ""}`,
						detail: v ? { kind: "start", moduleId: a.moduleId, version: this.version(v) } : { kind: "none" },
						kind: "start",
						moduleId: a.moduleId,
						attemptId: a.attemptId,
						current:
							byId[a.moduleId]?.attemptId === a.attemptId && state.attempts[a.attemptId]?.status !== "invalidated",
					});
					break;
				}
				case "attempt_ended": {
					if (active === event.attemptId) active = null;
					const a = state.attempts[event.attemptId];
					if (!a) break;
					const status = this.endStatus(a, event.status);
					row({
						id: `f:${a.attemptId}`,
						seq,
						t,
						mod: a.moduleId,
						type: "module",
						glyph: status,
						text: `Finish ${a.moduleId} · ${status}`,
						detail: {
							kind: "finish",
							moduleId: a.moduleId,
							attemptId: a.attemptId,
							criteria: this.attemptCriteria(a),
							summary: event.summary,
						},
						kind: "finish",
						moduleId: a.moduleId,
						attemptId: a.attemptId,
						current: byId[a.moduleId]?.attemptId === a.attemptId && a.status !== "invalidated",
					});
					break;
				}
				case "attempts_invalidated": {
					if (active && event.attemptIds.includes(active)) active = null;
					const names = event.attemptIds.map((id) => {
						const a = state.attempts[id];
						return a ? `${a.moduleId} #${a.n}` : id;
					});
					row({
						id: `x:${seq}`,
						seq,
						t,
						mod: "run",
						type: "run",
						glyph: "replaced",
						text: `Replaced ${names.join(", ")}`,
						detail: { kind: "text", glyph: "replaced", head: names.join(", "), text: event.reason },
					});
					break;
				}
				case "action_started": {
					const action = state.actions[event.action.actionId];
					if (!action) break;
					const act = this.act(action);
					row({
						id: `a:${act.id}`,
						seq,
						t,
						mod: act.moduleId ?? PRE,
						type: act.type === "write" ? "edit" : act.type,
						icon: ACT_ICON[act.type],
						text: `${VERB[act.type]} ${act.target}${act.live ? " · running" : act.stopped ? " · stopped" : ""}`,
						detail: { kind: "act", act },
						act,
						moduleId: act.moduleId ?? undefined,
						attemptId: act.attemptId ?? undefined,
					});
					break;
				}
				case "assistant_text": {
					const moduleId = event.attemptId ? state.attempts[event.attemptId]?.moduleId : undefined;
					row({
						id: `n:${seq}`,
						seq,
						t,
						mod: moduleId ?? (planned ? "run" : PRE),
						type: "say",
						icon: "say",
						text: oneLine(event.text),
						detail: { kind: "text", icon: "say", head: "agent", text: event.text },
						moduleId,
						attemptId: event.attemptId ?? undefined,
					});
					break;
				}
				case "boundary_paused": {
					const where =
						event.boundary === "after_plan"
							? "after plan"
							: event.boundary === "before_start"
								? `before ${event.moduleId ?? ""}`.trim()
								: `after ${event.moduleId ?? ""}`.trim();
					const waiting = state.pendingBoundary?.boundaryId === event.boundaryId;
					const flags = this.flags.filter((f) => event.moduleId && f.moduleId === event.moduleId);
					row({
						id: `h:${event.boundaryId}`,
						seq,
						t,
						mod: "run",
						type: "run",
						glyph: "waiting",
						text: `Held ${where}${waiting ? " · waiting for you" : ""}`,
						detail: flags.length ? { kind: "flags", flags } : { kind: "none" },
						moduleId: event.moduleId,
					});
					break;
				}
				case "boundary_resumed":
					if (event.decision === "continue" || event.decision === "edit") {
						row({
							id: `c:${event.boundaryId}`,
							seq,
							t,
							mod: "run",
							type: "user",
							icon: "user",
							text: "Continued by you",
							detail: { kind: "none" },
						});
					}
					break;
				case "intervention": {
					const i =
						state.interventions.find((x) => x.interventionId === event.intervention.interventionId) ??
						event.intervention;
					const id = `u:${i.interventionId}`;
					const base = { id, seq, t, detail: { kind: "none" } as LogDetail };
					if (i.kind === "pause") {
						const where = active
							? `after ${state.attempts[active]?.moduleId ?? ""}`
							: !planned
								? "after plan"
								: this.beforeNext(startSeqs, seq);
						row({ ...base, mod: "run", type: "user", icon: "pausestop", text: `Pause armed ${where}`.trim() });
					} else if (i.kind === "resume") {
						row({ ...base, mod: "run", type: "user", icon: "pausestop", text: "Pause removed" });
					} else if (i.kind === "note" || i.kind === "correct") {
						const correct = i.kind === "correct" && !!i.moduleId;
						row({
							...base,
							mod: correct ? (i.moduleId as string) : "run",
							type: "user",
							icon: "note",
							text: correct ? `Correction for ${i.moduleId} · by you` : "Note to agent · by you",
							detail: { kind: "text", icon: "user", head: "by you", text: i.note ?? "" },
							moduleId: i.moduleId,
							queued: i.deliveredAt === undefined,
						});
					} else if (i.kind === "revise") {
						row({
							...base,
							mod: i.moduleId ?? "run",
							type: "user",
							icon: "undo",
							text: i.moduleId ? `Redo from ${i.moduleId} · by you` : "Redo · by you",
							detail: i.note ? { kind: "text", icon: "user", head: "by you", text: i.note } : { kind: "none" },
							moduleId: i.moduleId,
							attemptId: i.attemptId,
						});
					} else if (i.kind === "stop") {
						row({ ...base, mod: "run", type: "user", glyph: "stopped", text: "Stopped by you" });
					}
					break;
				}
				case "audit": {
					const r = event.report;
					// the same count the Modules view's summary shows: exploring before the plan is expected
					const outside = this.outsideAfterPlan();
					const beforePlan = r.unassignedActions - outside;
					const parts = [
						outside ? `${outside} outside modules` : "",
						r.unattributedChanges.length ? `${plural(r.unattributedChanges.length, "unattributed change")}` : "",
						r.missingActions.length ? `${r.missingActions.length} missing` : "",
					].filter(Boolean);
					const lines = [
						`${r.assignedActions} actions in modules, ${outside} outside modules${beforePlan > 0 ? `, ${beforePlan} before plan` : ""}`,
						...r.unattributedChanges.map(
							(c) => `changed by a command: ${c.path}${c.attemptId ? ` (${c.attemptId})` : ""}`,
						),
						...r.missingActions.map((m) => `missing from the trace: ${m}`),
					];
					row({
						id: "audit",
						seq,
						t,
						mod: "run",
						type: "run",
						icon: "list",
						text: ["Audit", ...parts].join(" · "),
						detail: { kind: "text", icon: "list", head: "audit", text: lines.join("\n") },
					});
					break;
				}
				case "run_ended": {
					const n = planModules(state).length;
					const flags = this.flags.length;
					const facts = [plural(n, "module"), flags ? plural(flags, "flag") : ""].filter(Boolean);
					const head = [...facts, this.rel(event.t)].join(" · ");
					if (event.status === "completed") {
						row({
							id: "run1",
							seq,
							t,
							mod: "run",
							type: "run",
							glyph: "end",
							text: ["Run finished", ...facts].join(" · "),
							detail: { kind: "text", glyph: "end", head, text: this.task() },
						});
					} else if (event.status === "aborted") {
						row({
							id: "run1",
							seq,
							t,
							mod: "run",
							type: "run",
							glyph: "stopped",
							text: "Run stopped",
							detail: { kind: "text", glyph: "stopped", head, text: this.task() },
						});
					} else {
						row({
							id: "run1",
							seq,
							t,
							mod: "run",
							type: "run",
							glyph: "failed",
							text: `Run error${event.error ? ` · ${oneLine(event.error, 100)}` : ""}`,
							detail: { kind: "text", glyph: "failed", head, text: event.error ?? "" },
						});
					}
					break;
				}
				default:
					break;
			}
		}
		this.anchorFlags(rows);
		return rows;
	}

	/** Unassigned actions after the first plan (none when there is no plan: all of it is before the plan). */
	private outsideAfterPlan(): number {
		const first = this.state.firstPlanSeq;
		if (first === undefined) return 0;
		return actionsOf(this.state, null).filter((a) => (this.state.actionSeq[a.actionId] ?? -1) > first).length;
	}

	private beforeNext(starts: TraceEvent[], seq: number): string {
		const next = starts.find((e) => e.seq > seq);
		return next?.type === "attempt_started" ? `before ${next.attempt.moduleId}` : "";
	}

	/** Puts each flag on its row: an action's row, else the attempt's finish row, else the audit row. */
	private anchorFlags(rows: LogEvent[]): void {
		const byId = new Map(rows.map((r) => [r.id, r]));
		const audit = rows.findLast((r) => r.id === "audit" || r.id.startsWith("audit:"));
		for (const flag of this.flags) {
			const target =
				(flag.actionId && flag.rule !== "unverified" ? byId.get(`a:${flag.actionId}`) : undefined) ??
				(flag.attemptId ? byId.get(`f:${flag.attemptId}`) : undefined) ??
				(flag.rule === "command_change" && !flag.attemptId ? audit : undefined);
			if (!target) continue;
			target.flags.push(flag);
			target.flag = true;
		}
	}

	/** The status a finished attempt ended with (independent of later redos). */
	private endStatus(attempt: Attempt, ended: AttemptStatus): "verified" | "unverified" | "failed" | "stopped" {
		if (ended === "failed") return "failed";
		if (ended !== "completed" && ended !== "invalidated") return "stopped";
		return attemptEvidence(this.state, attempt).verified ? "verified" : "unverified";
	}

	/** Done-when results for one attempt: criteria() for the module's current attempt, the same rule for older ones. */
	private attemptCriteria(attempt: Attempt): { text: string; st: CriterionStatus }[] {
		return attemptCriteria(this.state, attempt.moduleId, attempt).map((c) => ({ text: c.text, st: c.status }));
	}

	// ---- summary --------------------------------------------------------------------------------

	private summary(byId: Record<SelId, ModView>, runClock: string): SummaryView {
		const state = this.state;
		const files = new Map<string, { path: string; add: number; del: number; by: SelId[] }>();
		const addFiles = (owner: SelId, list: FileView[]) => {
			for (const f of list) {
				const entry = files.get(f.path) ?? { path: f.path, add: 0, del: 0, by: [] };
				entry.add += f.add;
				entry.del += f.del;
				if (!entry.by.includes(owner)) entry.by.push(owner);
				files.set(f.path, entry);
			}
		};
		addFiles(PRE, this.files(null));
		// every module whose work stays, also one a re-plan dropped after it ran
		for (const m of Object.values(byId)) if (!m.isPre && m.status !== "replaced") addFiles(m.id, m.files);
		const audit = state.audit;
		// files commands changed outside any module (the audit's final diff)
		for (const c of audit?.unattributedChanges ?? []) {
			const path = normalizePath(state, c.path);
			if (c.attemptId !== null || files.has(path)) continue;
			addFiles(PRE, [{ path, ...diffStats(c.patch), patch: c.patch, diff: [] }]);
		}
		const list = [...files.values()];
		return {
			status: state.status,
			runClock,
			flags: this.flags,
			files: list,
			total: {
				files: list.length,
				add: list.reduce((n, f) => n + f.add, 0),
				del: list.reduce((n, f) => n + f.del, 0),
			},
			audit: audit
				? {
						missing: audit.missingActions.length,
						assigned: audit.assignedActions,
						unassigned: audit.unassignedActions,
						unattributed: audit.unattributedChanges.map((c) => ({
							attemptId: c.attemptId,
							path: normalizePath(state, c.path),
						})),
					}
				: undefined,
		};
	}
}

/** Plain-text twin of a station's one evidence graphic (the mockup's `evidenceText`). */
export function evidenceText(m: Pick<ModView, "tests" | "files" | "status" | "actions" | "dur">): string {
	if (!m.tests) return "";
	const t = `tests ${m.tests.pass} passed, ${m.tests.fail} failed`;
	const add = m.files.reduce((n, f) => n + f.add, 0);
	const del = m.files.reduce((n, f) => n + f.del, 0);
	const d = `+${add} −${del} lines`;
	if (m.status === "working") {
		const read = m.actions.filter((a) => a.type === "read").length;
		const edit = m.actions.filter((a) => a.type === "edit" || a.type === "write").length;
		return `running ${m.dur ?? "0:00"} · ${read} read, ${edit} edit, ${d} · ${t} so far, still running`;
	}
	return `${d} · ${t}`;
}

/** `needs M1 and M2 · needed by M4` (the mockup's `depsText`). */
export function depsText(m: Pick<ModView, "deps" | "dependents">): string {
	const parts: string[] = [];
	if (m.deps.length) parts.push(`needs ${joinAnd(m.deps)}`);
	if (m.dependents.length) parts.push(`needed by ${joinAnd(m.dependents)}`);
	return parts.join(" · ");
}

/** Re-exported for components: the boundary kinds a slot or decision can have. */
export type { BoundaryKind, Decision, Flag, Slot };
