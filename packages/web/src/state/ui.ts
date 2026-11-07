/**
 * The panel's UI state: the mockup's `S` object and its transition functions (selectMod,
 * openEditor, closeEditor, saveEditor, togglePause, stopAgent, continueRun, escapeLevel, move,
 * openLevel, openEv, …) as a small external store used through `useUi()`.
 *
 * Live data and controls come in from outside (the Panel and Controls passed to useUi), so nothing
 * here knows about particular modules. Transitions read the current state synchronously, update it,
 * then do their side effects (send a control, toast) — never inside a React updater.
 *
 * Focus: transitions put `data-k` keys in `focus`; after the next render a layout effect focuses
 * the first key that exists (else a fallback: the selected station / the card title / the log
 * list), then ensureVisible(). This keeps the mockup's focus-return rules. DOM contract the
 * components keep: stations are `.st` with `data-k="st-<id>"`, log rows are `.lr` holding a
 * `.lrb` with `data-k="lr-<rowId>"`, the card title is `#cardT`, the log list `#logList`, the
 * evidence column `#evCol`, editors `.ed`/`.redo`, popovers `.pop` inside `#now`.
 */

import type { ModuleId } from "@vcm/protocol";
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Controls } from "../controls.ts";
import { cssKey } from "../model/format.ts";
import {
	type Flag,
	type LogEvent,
	type LogType,
	type Panel,
	type PlanOverview,
	PRE,
	redoPreview,
	type SelId,
} from "../model/panel.ts";
import { toast } from "../ui/announce.tsx";
import { reducedMotion } from "../ui/motion.ts";
import { ensureVisible, focusTipShown, focusVisible, hideTip, setBarVars, showTip, syncTip } from "../ui/tooltip.ts";

// ---- types -----------------------------------------------------------------------------------

/** Modules = treatment, Log = baseline, Raw = researchers' event table (L4). */
export type View = "modules" | "log" | "raw";
export type Theme = "dark" | "light";
/** Evidence tabs (pre has only `steps`). */
export type EvTab = "steps" | "diff" | "tests" | "versions";
export type PopKind = "note" | "stop" | "flags";
/** change = instructions for a module not started; correct = correction for the running one; redo = rewind. */
export type EditorKind = "change" | "correct" | "redo";

/** An open editor (one at a time). `row` is the log row it is anchored to. */
export interface EditorState {
	kind: EditorKind;
	id: ModuleId;
	text: string;
	/** Redo only: "what went wrong". */
	note: string;
	row: string;
}

/** What opened an editor, for focus return: the trigger's data-k, and the selection to restore (decision card). */
export interface Opener {
	k?: string;
	sel?: SelId | null;
}

/** Log type filter chips (the mockup's TYPES). */
export type LogTypeFilter = "all" | "plan" | "module" | "read" | "edit" | "cmd" | "agent";

export interface LogFilter {
	/** `all`, `pre`, or a module id. */
	mod: string;
	type: LogTypeFilter;
	/** Only flagged rows. */
	flag: boolean;
	q: string;
}

/** The mockup's S, minus the scenario fakes. `sel` in `Ui.s` is already resolved (see `pinned`). */
export interface UiState {
	view: View;
	theme: Theme;
	/** Selected station, or null for the run summary (only meaningful when `pinned`). */
	sel: SelId | null;
	/** You picked `sel`; otherwise the selection follows Panel.defaultSel (active/held module, summary at the end). */
	pinned: boolean;
	evOpen: boolean;
	evTab: EvTab;
	/** Expanded step key (StepView.key). */
	exp: string | null;
	pop: PopKind | null;
	editor: EditorState | null;
	/** Text kept from editors closed with Esc or by moving the selection, by `kind:id`. */
	drafts: Record<string, { text: string; note: string }>;
	noteDraft: string;
	lf: LogFilter;
	/** Expanded log row id. */
	lexp: string | null;
	/** Current log row id (j/k, Enter). */
	lcur: string | null;
	/** data-k of what opened the evidence column (focus returns there on Esc). */
	evOpener: string | null;
	edOpener: Opener | null;
	/** Pending focus request: the first key that exists after the next render wins. */
	focus: string[] | null;
	/** Scroll the open editor into view after the next render. */
	scrollEd: boolean;
	/** Scroll to the end of the page after the next render (the log opens at its live end). */
	tail: boolean;
	/**
	 * Your choice for the plan overview (true = open), over its default (PlanOverview.expand). Continue
	 * folds it; it holds while modules run, and goes when the overview opens by default again (a plan to
	 * look at, a re-plan hold), so a new plan is never hidden by an old fold.
	 */
	ovFold: boolean | null;
}

/** Log type chips: key, icon, short text, tooltip (the mockup's TYPES, plus Agent for the agent's narration). */
export const LOG_TYPES: {
	k: LogTypeFilter;
	icon?: "plan" | "playc" | "eye" | "edit" | "term" | "say";
	short: string;
	lbl: string;
}[] = [
	{ k: "all", short: "All", lbl: "All event types" },
	{ k: "plan", icon: "plan", short: "Plan", lbl: "Plan events and your interventions" },
	{ k: "module", icon: "playc", short: "Module", lbl: "Module start and finish" },
	{ k: "read", icon: "eye", short: "Read", lbl: "File reads" },
	{ k: "edit", icon: "edit", short: "Edit", lbl: "File edits" },
	{ k: "cmd", icon: "term", short: "Run", lbl: "Commands and tests" },
	{ k: "agent", icon: "say", short: "Agent", lbl: "Agent messages" },
];

/** Which LogEvent types each chip shows (the mockup's TYPE_GROUP; `say` under All and Agent). */
export const LOG_TYPE_GROUP: Record<Exclude<LogTypeFilter, "all">, LogType[]> = {
	plan: ["plan", "user"],
	module: ["module", "run"],
	read: ["read"],
	edit: ["edit"],
	cmd: ["bash", "test"],
	agent: ["say"],
};

/** Popover → its trigger's data-k (focus returns there). */
export const POP_KEY: Record<PopKind, string> = { note: "notebtn", stop: "stopbtn", flags: "flagbtn" };

/** The module whose redo panel is open, if any. */
export function redoTarget(s: Pick<UiState, "editor">): ModuleId | null {
	return s.editor?.kind === "redo" ? s.editor.id : null;
}

/**
 * Whether the open editor is `kind` for `id` and on screen (the Raw view renders none): the
 * aria-expanded of a trigger outside the card (the decision card, the plan overview).
 */
export function editorOn(s: Pick<UiState, "editor" | "view">, kind: EditorKind, id: ModuleId | undefined): boolean {
	const ed = s.editor;
	return !!ed && !!id && ed.kind === kind && ed.id === id && s.view !== "raw";
}

/** Whether the plan overview shows its rows: your choice if you made one, else its default. */
export function overviewOpen(s: Pick<UiState, "ovFold">, ov: Pick<PlanOverview, "expand"> | undefined): boolean {
	if (!ov) return false;
	return s.ovFold ?? ov.expand;
}

/** A trigger outside the card (the decision card `dc-…`, the plan overview `ov-…`): focus returns to it after a save. */
function outsideCard(k: string | undefined): string | null {
	return k?.startsWith("dc-") || k?.startsWith("ov-") ? k : null;
}

/** The redo panel holds the evidence column of the selected card: evidence triggers are inert (aria-disabled). */
export function redoHoldsColumn(s: Pick<UiState, "editor" | "view" | "sel">): boolean {
	const k = redoTarget(s);
	return s.view === "modules" && !!k && k === s.sel;
}

/** Draft key of an editor: `kind:id`. */
export const draftKey = (ed: Pick<EditorState, "kind" | "id">): string => `${ed.kind}:${ed.id}`;

/**
 * Log rows after the filters (the mockup's visibleEvents): the row an open editor is anchored to
 * always stays visible; the latest plan row belongs to every module filter except `pre`.
 */
export function visibleEvents(panel: Panel, s: Pick<UiState, "lf" | "editor">): LogEvent[] {
	const f = s.lf;
	const q = f.q.trim().toLowerCase();
	return panel.events.filter((e) => {
		if (s.editor && e.id === s.editor.row) return true;
		if (f.mod !== "all" && e.mod !== f.mod && !(e.kind === "plan" && f.mod !== PRE)) return false;
		if (f.type !== "all" && !LOG_TYPE_GROUP[f.type].includes(e.type)) return false;
		if (f.flag && !e.flag) return false;
		if (q && `${e.text} ${e.mod} ${e.type}`.toLowerCase().indexOf(q) < 0) return false;
		return true;
	});
}

/** The log row an editor of `kind` for `id` anchors to by default (the mockup's defaultRow). */
export function defaultRow(panel: Panel, kind: EditorKind, id: ModuleId): string {
	if (kind === "change") return panel.events.findLast((e) => e.kind === "plan" && e.current)?.id ?? `s:${id}`;
	const m = panel.byId[id];
	if (kind === "correct") {
		const rows = panel.events.filter((e) => e.mod === id);
		return rows.at(-1)?.id ?? `s:${m?.attemptId ?? id}`;
	}
	return redoPreview(panel, id)?.cutRow ?? `s:${m?.attemptId ?? id}`;
}

/** localStorage key of the remembered theme. */
export const THEME_KEY = "vcm-theme";

/** The remembered theme (default dark; storage may be unavailable). */
export function storedTheme(): Theme {
	try {
		return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
	} catch {
		return "dark";
	}
}

/** A fresh UI state. `init` overrides (e.g. the view from the URL). */
export function initialUi(init: Partial<UiState> = {}): UiState {
	return {
		view: "modules",
		theme: storedTheme(),
		sel: null,
		pinned: false,
		evOpen: false,
		evTab: "steps",
		exp: null,
		pop: null,
		editor: null,
		drafts: {},
		noteDraft: "",
		lf: { mod: "all", type: "all", flag: false, q: "" },
		lexp: null,
		lcur: null,
		evOpener: null,
		edOpener: null,
		focus: null,
		scrollEd: false,
		tail: false,
		ovFold: null,
		...init,
	};
}

// ---- the store -------------------------------------------------------------------------------

/** Options for openEditor. */
export interface OpenEditorOptions {
	/** Log row to anchor to (default: defaultRow). */
	row?: string;
	/** data-k of the trigger, for focus return. */
	opener?: string;
	/** Opened from the Now bar's decision card: closing restores the selection that was current. */
	fromNow?: boolean;
}

/** Every UI transition. Bound methods with stable identity; pass them straight to event handlers. */
export interface UiActions {
	/** Requests focus on the first of these data-k keys that exists after the next render. */
	focus(...keys: (string | null | undefined)[]): void;
	setView(view: View, focusKey?: string): void;
	toggleTheme(): void;
	/**
	 * Selects a station; selecting the selected one opens its evidence (focus to the tab). `from` is the
	 * trigger's data-k when it is not the station (a plan overview row): focus stays there.
	 */
	selectMod(id: SelId, from?: string): void;
	/** Shows the run summary (finished runs): nothing selected. */
	clearSel(): void;
	openEditor(kind: EditorKind, id: ModuleId, opts?: OpenEditorOptions): void;
	/** Updates the open editor's text (`text`) or redo note (`note`). */
	setEditorField(field: "text" | "note", value: string): void;
	/** Esc keeps the typed text as a draft (keep = true); Cancel discards it. Focus returns to the opener. */
	closeEditor(keep: boolean): void;
	/** Save: change → `edit`; correct → `note {moduleId}`; redo → same as redoGo(). */
	saveEditor(): void;
	/** Confirms the open redo panel (`revise`). */
	redoGo(): void;
	/** Arms or disarms the pause at the next boundary; `focusKey` is the trigger (pausebtn / bnd-<id>). */
	togglePause(on: boolean, focusKey: string): void;
	/** Opens/toggles a Now-bar popover and moves focus into it. */
	openPop(pop: PopKind): void;
	/** Closes the popover and returns focus to its trigger. */
	closePop(): void;
	/** Closes the popover without moving focus (click outside, focus left a non-modal popover). */
	dismissPop(): void;
	/** Closes the popover and the editor (kept as a draft) without moving focus: a replay was scrubbed back. */
	suspend(): void;
	setNoteDraft(text: string): void;
	/** Sends the note draft (`note {text}`); empty → focus stays in the field. */
	sendNote(): void;
	/** Stop now (from the Stop confirmation). */
	stopAgent(): void;
	/** Continue from the decision card (`resume`); the plan overview folds (the work it previewed goes on). */
	continueRun(): void;
	/** Opens or folds the plan overview's rows (its header toggle; focus stays there). */
	toggleOverview(): void;
	/** A flag in the flags popover: Modules selects its station; Log turns on the Flagged filter. */
	flagGo(flag: Flag): void;
	/** The card's show/hide evidence toggle. */
	toggleEv(): void;
	/** Opens the evidence column on `tab` (focus to the tab). `opener` = trigger's data-k when outside the column. */
	openEv(tab: EvTab, opener?: string): void;
	/** Opens Steps with the step that read `path` expanded (a "looked at" chip). */
	goRead(path: string, opener?: string): void;
	/** Expands/collapses a step. */
	toggleStep(key: string): void;
	lfMod(mod: string): void;
	lfType(type: LogTypeFilter): void;
	lfFlag(): void;
	/** Search text (focus stays in the search field). */
	lfQuery(q: string): void;
	/** Expands/collapses a log row and makes it current. */
	toggleRow(id: string): void;
	/** Esc: goes up one level from `target`; returns true if it handled the key. */
	escapeLevel(target: Element | null): boolean;
	/** j/k: moves along the line (Modules) or the rows (Log) from the focused item. */
	move(dir: 1 | -1, target: Element | null): void;
	/** Enter on the card title or the log list: opens the next level down. */
	openLevel(): void;
	/**
	 * The mockup's document keydown handling (stop-dialog focus trap, Esc, tab and radio arrows,
	 * scoped j/k/Enter). Harness keys (view, theme, replay) are not handled here.
	 */
	keydown(e: KeyboardEvent): void;
	/** Back to a fresh state (keeps view and theme). */
	reset(): void;
	/**
	 * After the panel changed: an editor whose module can no longer take it (a Change for a module that
	 * started, a Correct for one that stopped running, a Redo that is no longer possible) closes, its text
	 * kept as a draft, and says so. When the plan overview opens by default again, your fold of it goes.
	 */
	reconcile(): void;
}

/** What components receive: the state (with `sel` resolved) plus every transition. */
export interface Ui extends UiActions {
	s: UiState;
}

/**
 * Props every panel component takes: the view model and the UI (state + transitions). Controls are
 * reached through the UI transitions (they also move focus and toast, as in the mockup).
 */
export interface PanelProps {
	/** The view model for the run (or replay position) on screen. */
	panel: Panel;
	/** UI state and transitions (useUi). */
	ui: Ui;
}

type Listener = () => void;

/** The store behind useUi. Exported for tests; components use the `Ui` object. */
export class UiStore implements UiActions {
	state: UiState;
	panel: Panel | undefined;
	controls: Controls | undefined;
	private listeners = new Set<Listener>();
	/** A keyboard-focus tooltip was showing when set() hid it: show it again for the focused control after the render. */
	refocusTip = false;
	/** The plan overview's default the last time the panel changed (followOverview). */
	private lastExpand: boolean | undefined;

	constructor(init: Partial<UiState> = {}) {
		this.state = initialUi(init);
	}

	subscribe = (fn: Listener): (() => void) => {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	};

	getSnapshot = (): UiState => this.state;

	/** Updates state and re-renders (hides the tooltip, as the mockup's render() does). */
	set(patch: Partial<UiState>): void {
		this.state = { ...this.state, ...patch };
		if (focusTipShown()) this.refocusTip = true;
		hideTip();
		for (const fn of this.listeners) fn();
	}

	/** Updates state without re-rendering (consumed one-shot flags). */
	quietly(patch: Partial<UiState>): void {
		this.state = { ...this.state, ...patch };
	}

	/** The effective selection: yours if pinned, else the panel's default. */
	sel(): SelId | null {
		return this.state.pinned ? this.state.sel : (this.panel?.defaultSel ?? null);
	}

	private keys(...keys: (string | null | undefined)[]): string[] {
		return keys.filter((k): k is string => !!k);
	}

	private stash(): Partial<UiState> {
		const ed = this.state.editor;
		if (!ed) return {};
		return {
			drafts: { ...this.state.drafts, [draftKey(ed)]: { text: ed.text, note: ed.note } },
			editor: null,
			edOpener: null,
		};
	}

	private withoutDraft(ed: EditorState): Record<string, { text: string; note: string }> {
		const drafts = { ...this.state.drafts };
		delete drafts[draftKey(ed)];
		return drafts;
	}

	/** Patch that selects `id` (stashing an editor for another module, collapsing steps when it changes). */
	private selectPatch(id: SelId | null): Partial<UiState> {
		const patch: Partial<UiState> = {};
		const ed = this.state.editor;
		if (ed && ed.id !== id) Object.assign(patch, this.stash());
		if (this.sel() !== id) Object.assign(patch, { exp: null, evOpener: null });
		return { ...patch, sel: id, pinned: true };
	}

	focus = (...keys: (string | null | undefined)[]): void => {
		this.set({ focus: this.keys(...keys) });
	};

	setView = (view: View, focusKey?: string): void => {
		const s = this.state;
		// no focus key (nothing focused): focus stays where it is, as in the mockup
		const patch: Partial<UiState> = {
			view,
			pop: null,
			exp: null,
			lexp: null,
			lcur: null,
			focus: focusKey ? [focusKey] : null,
		};
		if (s.editor) {
			if (view === "modules") Object.assign(patch, { sel: s.editor.id, pinned: true });
			patch.scrollEd = true;
		} else patch.tail = view === "log" && !!this.panel?.live;
		this.set(patch);
	};

	toggleTheme = (): void => {
		const theme: Theme = this.state.theme === "dark" ? "light" : "dark";
		try {
			localStorage.setItem(THEME_KEY, theme);
		} catch {
			// private mode: the theme just is not remembered
		}
		this.set({ theme });
	};

	selectMod = (id: SelId, from?: string): void => {
		const s = this.state;
		if (s.view !== "modules") return;
		const own = from ?? `st-${id}`;
		if (this.sel() === id) {
			if (redoTarget(s) === id) return;
			this.set({ sel: id, pinned: true, evOpen: true, evOpener: own, focus: [`tab-${s.evTab}`] });
			return;
		}
		this.set({ ...this.selectPatch(id), focus: [own] });
	};

	clearSel = (): void => {
		const sel = this.sel();
		this.set({
			...this.stash(),
			sel: null,
			pinned: true,
			exp: null,
			evOpener: null,
			focus: this.keys(sel && `st-${sel}`),
		});
	};

	openEditor = (kind: EditorKind, id: ModuleId, opts: OpenEditorOptions = {}): void => {
		const panel = this.panel;
		const m = panel?.byId[id];
		if (!panel || !m) return;
		const s = this.state;
		const row = kind === "redo" ? defaultRow(panel, "redo", id) : (opts.row ?? defaultRow(panel, kind, id));
		const opener: Opener | null = opts.opener
			? { k: opts.opener, sel: opts.fromNow ? this.sel() : undefined }
			: opts.fromNow
				? { sel: this.sel() }
				: null;
		const patch: Partial<UiState> = { pop: null, scrollEd: true, focus: [kind === "redo" ? "rdtext" : "edtext"] };
		if (s.editor && draftKey(s.editor) === `${kind}:${id}`) {
			patch.editor = { ...s.editor, row };
			if (opener) patch.edOpener = opener;
		} else {
			const stashed = this.stash();
			const drafts = stashed.drafts ?? s.drafts;
			const d = drafts[`${kind}:${id}`];
			Object.assign(patch, stashed, {
				editor: { kind, id, text: d ? d.text : kind === "correct" ? "" : m.cur.text, note: d ? d.note : "", row },
				edOpener: opener,
			});
		}
		if (s.view === "modules") {
			if (this.sel() !== id) Object.assign(patch, { exp: null, evOpener: null });
			Object.assign(patch, { sel: id, pinned: true });
		}
		this.set(patch);
	};

	setEditorField = (field: "text" | "note", value: string): void => {
		const ed = this.state.editor;
		if (!ed) return;
		this.set({ editor: { ...ed, [field]: value } as EditorState });
	};

	closeEditor = (keep: boolean): void => {
		const s = this.state;
		const ed = s.editor;
		if (!ed) return;
		const drafts = keep ? { ...s.drafts, [draftKey(ed)]: { text: ed.text, note: ed.note } } : this.withoutDraft(ed);
		const op = s.edOpener;
		const patch: Partial<UiState> = { drafts, editor: null, edOpener: null };
		if (op && op.sel !== undefined && s.view === "modules") Object.assign(patch, { sel: op.sel, pinned: true });
		patch.focus = this.keys(op?.k, s.view === "modules" ? "prim" : `lr-${ed.row}`);
		this.set(patch);
	};

	saveEditor = (): void => {
		const s = this.state;
		const ed = s.editor;
		const panel = this.panel;
		if (!ed || !panel) return;
		if (ed.kind === "redo") {
			this.redoGo();
			return;
		}
		// the agent can no longer act on it (the run ended, or a replay is scrubbed back): nothing is sent
		if (!panel.live) return;
		if (!ed.text.trim()) {
			this.set({ focus: ["edtext"] });
			return;
		}
		const m = panel.byId[ed.id];
		// the module started (or finished) while you typed: a change would no longer be "used when it starts"
		if (ed.kind === "change" ? !m?.canChange : !m?.canCorrect) {
			this.reconcile();
			return;
		}
		const back = s.edOpener?.k;
		const base: Partial<UiState> = { drafts: this.withoutDraft(ed), editor: null, edOpener: null };
		if (ed.kind === "change") {
			const focusBack =
				s.view === "modules"
					? this.keys(outsideCard(back), "vchip")
					: this.keys(back, `lr-${defaultRow(panel, "change", ed.id)}`);
			// unchanged text creates no version: nothing is sent, and the toast says so
			if (ed.text === m?.cur.text) {
				this.set({ ...base, focus: focusBack });
				toast(`No change · ${ed.id} instructions stay v${m.cur.v}`);
				return;
			}
			const nv = (m?.cur.v ?? 0) + 1;
			if (!this.controls?.change(ed.id, ed.text)) return;
			this.set({ ...base, focus: focusBack });
			toast(`${ed.id} instructions saved as v${nv} · by you`);
		} else {
			// not sent (not connected): the editor stays open with your text
			if (!this.controls?.correct(ed.id, ed.text.trim())) return;
			this.set({ ...base, focus: s.view === "modules" ? ["prim"] : this.keys(back, `lr-${ed.row}`) });
			toast(`Correction queued · reaches the agent ${panel.now.reaches}`);
		}
	};

	redoGo = (): void => {
		const s = this.state;
		const ed = s.editor;
		const panel = this.panel;
		if (ed?.kind !== "redo" || !panel?.serverHeld) return;
		if (panel.busy) {
			toast("A redo is being set up · try again when it has started");
			return;
		}
		// a redo panel left open after its module was replaced (e.g. from another tab) must not rewind to old work
		if (!panel.byId[ed.id]?.canRedo) {
			this.reconcile();
			return;
		}
		const preview = redoPreview(panel, ed.id);
		if (!preview) return;
		if (!this.controls?.redo(ed.id, preview.attemptId, ed.text, ed.note.trim() || undefined)) return;
		// like Continue, the card follows the agent again: the new attempt, the modules after it, the summary
		this.set({
			drafts: this.withoutDraft(ed),
			editor: null,
			edOpener: null,
			pinned: false,
			sel: null,
			focus: s.view === "modules" ? ["prim", `st-${ed.id}`] : [`lr-${ed.row}`],
		});
		toast(`${preview.running ? "Agent stopped · redo" : "Redo"} from ${ed.id} started`);
	};

	togglePause = (on: boolean, focusKey: string): void => {
		if (!this.panel?.live) return;
		if (!this.controls?.armPause(on)) return;
		this.set({ focus: [focusKey] });
	};

	openPop = (pop: PopKind): void => {
		const next = this.state.pop === pop ? null : pop;
		const focus =
			next === "note"
				? ["notein"]
				: next === "stop"
					? ["stopcancel"]
					: next === "flags"
						? ["flaggo", "flaggo-0"]
						: [POP_KEY[pop]];
		this.set({ pop: next, focus });
	};

	closePop = (): void => {
		const pop = this.state.pop;
		this.set({ pop: null, focus: pop ? [POP_KEY[pop]] : null });
	};

	dismissPop = (): void => {
		if (this.state.pop) this.set({ pop: null });
	};

	suspend = (): void => {
		const s = this.state;
		if (s.pop || s.editor) this.set({ ...this.stash(), pop: null });
	};

	setNoteDraft = (text: string): void => {
		this.set({ noteDraft: text });
	};

	sendNote = (): void => {
		const text = this.state.noteDraft.trim();
		if (!this.panel?.live) return;
		if (!text) {
			this.set({ focus: ["notein"] });
			return;
		}
		// not sent (not connected): the draft stays in the field
		if (!this.controls?.note(text)) return;
		this.set({ noteDraft: "", pop: null, focus: ["notebtn"] });
		toast(`Note queued · reaches the agent ${this.panel?.now.reaches ?? "after its current step"}`);
	};

	stopAgent = (): void => {
		const s = this.state;
		const panel = this.panel;
		if (!panel?.live) return;
		const patch: Partial<UiState> = { pop: null };
		if (s.editor?.kind === "correct") Object.assign(patch, this.stash());
		if (!this.controls?.stop()) return;
		const target = panel?.now.module?.id ?? panel?.now.decision?.next;
		if (s.view === "modules" && target) {
			const ed = patch.editor === null ? null : s.editor;
			if (ed && ed.id !== target) Object.assign(patch, this.stash());
			if (this.sel() !== target) Object.assign(patch, { exp: null, evOpener: null });
			Object.assign(patch, { sel: target, pinned: true, focus: ["prim", `st-${target}`] });
		} else patch.focus = ["__fallback"];
		this.set(patch);
		toast("Agent stopped");
	};

	continueRun = (): void => {
		const panel = this.panel;
		const next = panel?.now.decision?.next;
		const ok = this.controls?.continueRun() ?? false;
		if (!ok) return;
		this.set({
			...this.stash(),
			pinned: false,
			sel: null,
			pop: null,
			evOpen: false,
			exp: null,
			lexp: null,
			lcur: null,
			ovFold: false,
			focus: this.state.view === "modules" && next ? [`st-${next}`] : ["__fallback"],
		});
		toast(next ? `Continued to ${next}` : "Continued");
	};

	toggleOverview = (): void => {
		const ov = this.panel?.overview;
		if (!ov) return;
		this.set({ ovFold: !overviewOpen(this.state, ov), focus: ["ovtoggle"] });
	};

	/** A new look at the plan (the overview opens by default again: a plan came, a re-plan holds the agent) drops your fold. */
	private followOverview(): void {
		const expand = this.panel?.overview?.expand;
		const opens = expand === true && this.lastExpand !== true;
		this.lastExpand = expand;
		if (opens && this.state.ovFold !== null) this.set({ ovFold: null });
	}

	flagGo = (flag: Flag): void => {
		const s = this.state;
		if (s.view === "modules") {
			const target = flag.moduleId ?? PRE;
			this.set({ ...this.selectPatch(target), pop: null, focus: [`st-${target}`] });
		} else this.set({ pop: null, lf: { ...s.lf, flag: true }, lcur: null, focus: ["lff"] });
	};

	toggleEv = (): void => {
		const s = this.state;
		if (redoHoldsColumn({ ...s, sel: this.sel() })) return;
		const evOpen = !s.evOpen;
		this.set({ evOpen, evOpener: evOpen ? "evtoggle" : s.evOpener, focus: ["evtoggle"] });
	};

	openEv = (tab: EvTab, opener?: string): void => {
		const s = this.state;
		if (redoHoldsColumn({ ...s, sel: this.sel() })) return;
		this.set({ evTab: tab, evOpen: true, evOpener: opener ?? s.evOpener, focus: [`tab-${tab}`] });
	};

	goRead = (path: string, opener?: string): void => {
		const s = this.state;
		if (redoHoldsColumn({ ...s, sel: this.sel() })) return;
		const m = this.panel?.byId[this.sel() ?? ""];
		const step = m?.steps.find(
			(st) =>
				(st.kind === "act" && st.act.type === "read" && st.act.path === path) ||
				(st.kind === "fold" && st.items.some((x) => x.path === path)),
		);
		this.set({
			evTab: "steps",
			evOpen: true,
			evOpener: opener ?? s.evOpener,
			exp: step?.key ?? null,
			focus: [step ? `step-${step.key}` : "tab-steps"],
		});
	};

	toggleStep = (key: string): void => {
		this.set({ exp: this.state.exp === key ? null : key, focus: [`step-${key}`] });
	};

	lfMod = (mod: string): void => {
		this.set({ lf: { ...this.state.lf, mod }, lcur: null, focus: [`lfm-${mod}`] });
	};

	lfType = (type: LogTypeFilter): void => {
		this.set({ lf: { ...this.state.lf, type }, lcur: null, focus: [`lft-${type}`] });
	};

	lfFlag = (): void => {
		this.set({ lf: { ...this.state.lf, flag: !this.state.lf.flag }, lcur: null, focus: ["lff"] });
	};

	lfQuery = (q: string): void => {
		this.set({ lf: { ...this.state.lf, q }, lcur: null });
	};

	toggleRow = (id: string): void => {
		this.set({ lexp: this.state.lexp === id ? null : id, lcur: id, focus: [`lr-${id}`] });
	};

	escapeLevel = (target: Element | null): boolean => {
		const s = this.state;
		const panel = this.panel;
		if (s.pop) {
			this.closePop();
			return true;
		}
		const t = target?.closest ? target : document.body;
		if (t.closest("#now, #harness")) return false;
		const body = t === document.body;
		if (s.editor && (body || t.closest(".ed, .redo"))) {
			this.closeEditor(true);
			return true;
		}
		const sel = this.sel();
		if (s.view === "modules") {
			const inEv = !!t.closest("#evCol");
			const inCard = !!t.closest(".card");
			const inSt = !!t.closest("#stations");
			if (s.exp && (inEv || body)) {
				this.set({ exp: null, focus: [`step-${s.exp}`] });
				return true;
			}
			if (s.editor && inCard) {
				this.closeEditor(true);
				return true;
			}
			if (s.evOpen && (inEv || inCard || inSt || body)) {
				const own = inSt ? (t.closest("[data-k]") as HTMLElement | null) : null;
				this.set({
					evOpen: false,
					exp: null,
					evOpener: null,
					focus: own?.dataset.k ? [own.dataset.k] : this.keys(s.evOpener, sel && `st-${sel}`),
				});
				return true;
			}
			if (sel && panel?.summary && (inCard || inSt || body)) {
				this.set({ sel: null, pinned: true, focus: [`st-${sel}`] });
				return true;
			}
			if (sel && inCard) {
				this.set({ focus: [`st-${sel}`] });
				return true;
			}
			return false;
		}
		if (s.lexp && (body || t.closest("#logList"))) {
			this.set({ lexp: null, focus: [`lr-${s.lexp}`] });
			return true;
		}
		return false;
	};

	move = (dir: 1 | -1, target: Element | null): void => {
		const s = this.state;
		const panel = this.panel;
		if (!panel) return;
		if (s.view === "modules") {
			// in the open plan overview (a row or its header) j/k walk its rows (plan modules only) and focus
			// stays on them
			const row = target?.closest?.(".ovr") as HTMLElement | null;
			const inOv = !!row || (!!target?.closest?.("#planOv") && overviewOpen(s, panel.overview));
			const ids: SelId[] = inOv ? panel.ids : [PRE, ...panel.ids];
			const st = target?.closest?.(".st") as HTMLElement | null;
			const base = row?.dataset.id ?? (st?.dataset.k?.startsWith("st-") ? st.dataset.k.slice(3) : this.sel());
			let i = base ? ids.indexOf(base) + dir : dir > 0 ? 1 : ids.length - 1;
			i = Math.max(0, Math.min(ids.length - 1, i));
			const id = ids[i];
			if (!id) return;
			this.set({ ...this.selectPatch(id), focus: [inOv ? `ov-${id}` : `st-${id}`] });
			return;
		}
		const rows = visibleEvents(panel, s);
		if (!rows.length) return;
		const b = target?.closest?.(".lr")?.querySelector<HTMLElement>(".lrb");
		const fromKey = b?.dataset.k?.startsWith("lr-") ? b.dataset.k.slice(3) : null;
		const cur = rows.findIndex((r) => r.id === (fromKey ?? s.lcur));
		const i = Math.max(0, Math.min(rows.length - 1, (cur < 0 && dir < 0 ? rows.length : cur) + dir));
		const row = rows[i];
		if (row) this.set({ lcur: row.id, focus: [`lr-${row.id}`] });
	};

	openLevel = (): void => {
		const s = this.state;
		const panel = this.panel;
		if (!panel) return;
		if (s.view === "modules") {
			const sel = this.sel();
			if (!sel || redoTarget(s) === sel) return;
			if (!s.evOpen) {
				this.set({ evOpen: true, evOpener: `st-${sel}`, focus: [`tab-${s.evTab}`] });
				return;
			}
			const first = panel.byId[sel]?.steps[0];
			if (first) this.set({ evTab: "steps", exp: first.key, focus: [`step-${first.key}`] });
			return;
		}
		const rows = visibleEvents(panel, s);
		const cur = s.lcur && rows.some((r) => r.id === s.lcur) ? s.lcur : null;
		if (cur) this.set({ lexp: s.lexp === cur ? null : cur, focus: [`lr-${cur}`] });
	};

	keydown = (e: KeyboardEvent): void => {
		const s = this.state;
		const t = (e.target as Element | null)?.closest ? (e.target as Element) : document.body;
		if (s.pop === "stop" && e.key === "Tab") {
			const buttons = Array.from(document.querySelectorAll<HTMLElement>("#now .pop button"));
			if (!buttons.length) return;
			e.preventDefault();
			const i = buttons.indexOf(document.activeElement as HTMLElement);
			buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
			return;
		}
		const typing = t.matches("input, textarea, select");
		if (e.key === "Escape") {
			if (typing && t.id === "q" && (t as HTMLInputElement).value) return;
			if (this.escapeLevel(t)) e.preventDefault();
			else hideTip();
			return;
		}
		if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
		const role = t.getAttribute("role");
		if (role === "tab" && /^(ArrowRight|ArrowLeft|Home|End)$/.test(e.key)) {
			const tabs = Array.from(t.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
			const i = tabs.indexOf(t as HTMLElement);
			const n =
				e.key === "Home"
					? tabs[0]
					: e.key === "End"
						? tabs.at(-1)
						: tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
			const tab = n?.dataset.k?.startsWith("tab-") ? (n.dataset.k.slice(4) as EvTab) : undefined;
			if (n && tab) {
				e.preventDefault();
				this.set({ evTab: tab, focus: [`tab-${tab}`] });
			}
			return;
		}
		if (role === "radio" && /^Arrow(Right|Left|Down|Up)$/.test(e.key)) {
			const group = t.closest('[role="radiogroup"]');
			const radios = Array.from(group?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
			const i = radios.indexOf(t as HTMLElement);
			const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
			const n = radios[(i + d + radios.length) % radios.length];
			if (n) {
				e.preventDefault();
				n.click();
			}
			return;
		}
		if (t.closest(".pop")) return;
		/* product shortcuts j/k/Enter only act while the plan, the card or the log list has focus (WCAG 2.1.4) */
		const scoped = !t.closest("#now, #harness, .redo, .ed") && !!t.closest("#stations, #planOv, .card, #logList");
		if (!scoped) return;
		if (e.key === "j" || e.key === "J") {
			e.preventDefault();
			this.move(1, t);
		} else if (e.key === "k" || e.key === "K") {
			e.preventDefault();
			this.move(-1, t);
		} else if (e.key === "Enter" && (t.id === "cardT" || t.id === "logList")) {
			e.preventDefault();
			this.openLevel();
		}
	};

	reset = (): void => {
		this.set(initialUi({ view: this.state.view, theme: this.state.theme }));
	};

	reconcile = (): void => {
		this.followOverview();
		const s = this.state;
		const ed = s.editor;
		const panel = this.panel;
		// a scrubbed-back replay keeps its editor suspended (suspend()); a run that ended keeps it readable
		if (!ed || !panel || panel.replaying) return;
		const m = panel.byId[ed.id];
		const why =
			ed.kind === "change"
				? !m?.canChange && panel.live
					? `${ed.id} has started, so your change was kept as a draft`
					: undefined
				: ed.kind === "correct"
					? !m?.canCorrect && panel.live
						? `${ed.id} is no longer running, so your correction was kept as a draft`
						: undefined
					: !m?.canRedo && panel.serverHeld
						? `Redo from ${ed.id} is no longer possible; your text was kept as a draft`
						: undefined;
		if (!why) return;
		const op = s.edOpener;
		const patch: Partial<UiState> = { ...this.stash() };
		if (op && op.sel !== undefined && s.view === "modules") Object.assign(patch, { sel: op.sel, pinned: true });
		const inEditor = !!document.activeElement?.closest?.(".ed, .redo");
		if (inEditor) patch.focus = this.keys(op?.k, s.view === "modules" ? "prim" : `lr-${ed.row}`);
		this.set(patch);
		toast(why);
	};
}

// ---- hook --------------------------------------------------------------------------------------

function fallbackFocus(s: UiState, sel: SelId | null): HTMLElement | null {
	if (s.view === "modules") {
		return (
			(sel ? document.querySelector<HTMLElement>(`[data-k="${cssKey(`st-${sel}`)}"]`) : null) ??
			document.getElementById("cardT")
		);
	}
	return document.getElementById(s.view === "log" ? "logList" : "main");
}

/**
 * The UI store for one run. Call once at the app root with the current Panel and Controls; it
 * returns the state (with the effective selection) and every transition. After each render it
 * applies the theme, updates the bar sizes, processes focus requests, and scrolls (tail / editor).
 * Remount (e.g. `key={runId}`) or call `reset()` when the run changes.
 */
export function useUi(panel: Panel, controls: Controls, init?: Partial<UiState>): Ui {
	const [store] = useState(() => new UiStore(init));
	const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	const sel = state.pinned ? state.sel : panel.defaultSel;

	// transitions run after commit, so this is always the panel the user is looking at
	useLayoutEffect(() => {
		store.panel = panel;
		store.controls = controls;
	});
	// live data can make the open editor stale (its module started, stopped or was replaced)
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the panel changes (store.panel was just set)
	useLayoutEffect(() => {
		store.reconcile();
	}, [panel, store]);

	// remember the last focused element in the product, so focus survives re-renders that remove it
	const [last] = useState(() => ({ el: null as HTMLElement | null, key: undefined as string | undefined }));
	useEffect(() => {
		const onFocus = (e: FocusEvent) => {
			const el = e.target as HTMLElement | null;
			if (!el?.closest?.("#now, #main")) return;
			last.el = el;
			last.key = el.dataset.k;
		};
		document.addEventListener("focusin", onFocus);
		return () => document.removeEventListener("focusin", onFocus);
	}, [last]);

	useLayoutEffect(() => {
		document.documentElement.setAttribute("data-theme", state.theme);
		setBarVars();
		syncTip();
		const s = store.state;
		const effective = s.pinned ? s.sel : (store.panel?.defaultSel ?? null);
		if (s.tail) window.scrollTo(0, document.documentElement.scrollHeight);
		if (s.scrollEd)
			document
				.querySelector(".lred, .redo, .ed")
				?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
		const keys = s.focus;
		if (s.tail || s.scrollEd || keys) store.quietly({ tail: false, scrollEd: false, focus: null });
		let el: HTMLElement | null = null;
		if (keys) {
			for (const k of keys) {
				el = document.querySelector<HTMLElement>(`[data-k="${cssKey(k)}"]`);
				if (el) break;
			}
			el ??= fallbackFocus(s, effective);
		} else if (
			last.el &&
			!last.el.isConnected &&
			(!document.activeElement || document.activeElement === document.body)
		) {
			el =
				(last.key ? document.querySelector<HTMLElement>(`[data-k="${cssKey(last.key)}"]`) : null) ??
				fallbackFocus(s, effective);
		}
		if (el) {
			el.focus({ preventScroll: true });
			ensureVisible(el);
			if (el instanceof HTMLTextAreaElement && keys) el.setSelectionRange(el.value.length, el.value.length);
		}
		// refocusing the already focused control fires no focusin: bring its tooltip back, with its new text
		if (store.refocusTip) {
			store.refocusTip = false;
			const active = document.activeElement;
			if (active?.hasAttribute("data-tip") && focusVisible(active)) showTip(active, "focus");
		}
	});

	const actions = useMemo(() => bindActions(store), [store]);
	return useMemo((): Ui => ({ ...actions, s: { ...state, sel } }), [actions, state, sel]);
}

/** Every UiActions method name (the Record type makes the compiler check the list is complete). */
const ACTION_NAMES: Record<keyof UiActions, true> = {
	focus: true,
	setView: true,
	toggleTheme: true,
	selectMod: true,
	clearSel: true,
	openEditor: true,
	setEditorField: true,
	closeEditor: true,
	saveEditor: true,
	redoGo: true,
	togglePause: true,
	openPop: true,
	closePop: true,
	dismissPop: true,
	suspend: true,
	setNoteDraft: true,
	sendNote: true,
	stopAgent: true,
	continueRun: true,
	toggleOverview: true,
	flagGo: true,
	toggleEv: true,
	openEv: true,
	goRead: true,
	toggleStep: true,
	lfMod: true,
	lfType: true,
	lfFlag: true,
	lfQuery: true,
	toggleRow: true,
	escapeLevel: true,
	move: true,
	openLevel: true,
	keydown: true,
	reset: true,
	reconcile: true,
};

/** The store's transitions as a plain object (they are arrow properties, so already bound). */
export function bindActions(store: UiStore): UiActions {
	const out: Partial<Record<keyof UiActions, unknown>> = {};
	for (const name of Object.keys(ACTION_NAMES) as (keyof UiActions)[]) out[name] = store[name];
	return out as UiActions;
}
