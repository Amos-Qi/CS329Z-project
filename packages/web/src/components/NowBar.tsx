/**
 * Level 0, shared by both views: the Now bar (state glyph, active module, current action, segmented
 * progress + "next" in the Modules view only, flags pill, armed chip, pause / note / stop), and while
 * the agent is held, the decision card (Continue to Mk, Change Mk first, Redo Mj, Stop) with the
 * note, stop and flags popovers. Port of the mockup's renderNow() and its popovers.
 *
 * Controls exist only while the agent can still act on them (panel.live): a finished run, a
 * recorded run and a scrubbed-back replay show the same bar without them. The Stop confirmation is
 * modal (the mockup's applyModal: #main and everything else in the bar inert, Tab trapped by
 * ui.keydown, Esc closes); the note and flags popovers are not, and close when focus leaves them.
 */

import { type CSSProperties, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { plural } from "../model/format.ts";
import {
	type Flag,
	type GlyphStatus,
	type ModView,
	type NowView,
	type Panel,
	shownLabel,
	shownStatus,
} from "../model/panel.ts";
import { type PanelProps, redoTarget, type Ui } from "../state/ui.ts";
import { announce } from "../ui/announce.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { Glyph, Octagon, tipImg } from "../ui/primitives.tsx";

/** Props of NowBar: the shared PanelProps (the view comes from `ui.s.view`). */
export type NowBarProps = PanelProps;

/** `<header id="now" class="now">` — the Now bar / decision card. */
export function NowBar({ panel, ui }: NowBarProps) {
	const now = panel.now;
	const waiting = now.kind === "waiting";
	const live = panel.live;
	const pop = ui.s.pop;
	const stopPopRef = useRef<HTMLDivElement>(null);
	const noteCtlRef = useRef<HTMLDivElement>(null);
	const flagCtlRef = useRef<HTMLDivElement>(null);

	useStopModal(pop === "stop", stopPopRef);
	useFocusClose(ui, noteCtlRef, flagCtlRef);
	useAnnounceState(panel);

	/* a popover whose trigger went away (run ended, flags cleared by a redo) closes */
	const orphan = (pop === "flags" && now.flags.length === 0) || ((pop === "note" || pop === "stop") && !live);
	const { dismissPop } = ui;
	useEffect(() => {
		if (orphan) dismissPop();
	}, [orphan, dismissPop]);

	/* segmented progress and "next" belong to the Modules view only (docs/design.md §6.3) */
	const prog = ui.s.view === "modules" ? <Progress panel={panel} ui={ui} /> : null;
	const flags = <FlagPill panel={panel} ui={ui} ctlRef={flagCtlRef} />;

	let body: ReactNode;
	if (waiting && now.decision) {
		const d = now.decision;
		const what = d.what;
		const ed = ui.s.editor;
		/* the Raw view renders no editor, so no button there says it controls one */
		const edOn = (kind: "change" | "redo", id: string | undefined) =>
			!!ed && !!id && ed.kind === kind && ed.id === id && ui.s.view !== "raw";
		const changeOn = edOn("change", d.next);
		const redoOn = edOn("redo", d.redo?.moduleId);
		body = (
			<>
				{/* row 1: state, what happened + its flag, progress, then the persistent controls in the same corner as in Working */}
				<div className="now-state">
					<Glyph status="waiting" size={24} />
					<div className="dc-title">
						<span>Waiting for you</span>
						<span
							className="pill"
							id="waitP"
							{...tipImg(`Waiting for you for ${now.waitClock}`, "How long the agent has waited for you")}
						>
							<Icon name="clock" size={14} />
							<span className="mono" id="waitT">
								{now.waitClock}
							</span>
						</span>
					</div>
				</div>
				<div className="dc-what" {...tipImg(what.label, what.tip)}>
					{what.glyph ? (
						<Glyph status={what.glyph} size={16} />
					) : what.icon ? (
						<Icon name={what.icon} size={16} />
					) : null}
					{what.mod ? <span className="mono">{what.mod}</span> : null}
					<span>{what.text}</span>
				</div>
				{flags}
				{prog}
				{live ? (
					<div className="dc-ctl">
						<ArmedChip panel={panel} />
						<PauseButton panel={panel} ui={ui} />
						<NoteControl panel={panel} ui={ui} ctlRef={noteCtlRef} />
					</div>
				) : null}
				{/* row 2: exactly the four decisions */}
				{live ? (
					<div className="dc-acts">
						<button type="button" className="btn warn" data-k="dc-cont" onClick={ui.continueRun}>
							<Icon name="arrowr" size={16} />
							{d.next ? `Continue to ${d.next}` : "Continue"}
						</button>
						{d.next && d.nextMod?.canChange ? (
							<button
								type="button"
								className="btn"
								data-k="dc-change"
								aria-expanded={changeOn}
								aria-controls={changeOn ? "edPanel" : undefined}
								onClick={() => d.next && ui.openEditor("change", d.next, { opener: "dc-change", fromNow: true })}
							>
								<Icon name="edit" size={16} />
								Change {d.next} first
							</button>
						) : null}
						<span className="spacer" />
						{d.redo && d.redoMod?.canRedo ? (
							<button
								type="button"
								className="btn dghost"
								data-k="dc-redo"
								aria-expanded={redoOn}
								aria-controls={redoOn ? "redoPanel" : undefined}
								onClick={() => d.redo && ui.openEditor("redo", d.redo.moduleId, { opener: "dc-redo", fromNow: true })}
							>
								<Icon name="undo" size={16} />
								Redo {d.redo.moduleId}
							</button>
						) : null}
						<StopControl panel={panel} ui={ui} labelled popRef={stopPopRef} />
					</div>
				) : null}
			</>
		);
	} else {
		body = (
			<>
				<div className="now-state">
					<Glyph
						status={stateGlyph(now)}
						size={24}
						animate={(now.kind === "working" || now.kind === "starting") && !panel.replaying}
					/>
					<div className="now-title">
						<NowTitle panel={panel} />
					</div>
				</div>
				{now.action && (now.kind === "working" || now.kind === "starting") ? (
					<span className="pill" {...tipImg(now.action.label)}>
						<Icon name={now.action.icon} size={14} />
						<span className="mono">{now.action.object}</span>
					</span>
				) : null}
				{now.kind === "error" && now.error ? (
					<span className="pill" {...tipImg(`Error: ${now.error}`)}>
						<Icon name="x" size={14} />
						<span>{firstWords(now.error)}</span>
					</span>
				) : null}
				{prog}
				{flags}
				{/* controls exist only while the agent can still act on them */}
				{live ? (
					<div className="ctls">
						<ArmedChip panel={panel} />
						<PauseButton panel={panel} ui={ui} />
						<NoteControl panel={panel} ui={ui} ctlRef={noteCtlRef} />
						<span className="vsep" aria-hidden="true" />
						<StopControl panel={panel} ui={ui} labelled={false} popRef={stopPopRef} />
					</div>
				) : null}
			</>
		);
	}

	return (
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: the mockup names the bar ("Agent status" / "Decision needed")
		<header
			id="now"
			className={waiting ? "now waiting" : "now"}
			aria-label={waiting ? "Decision needed" : "Agent status"}
		>
			{body}
		</header>
	);
}

// ---- pieces ------------------------------------------------------------------------------------

interface PieceProps {
	panel: Panel;
	ui: Ui;
}

function stateGlyph(now: NowView): GlyphStatus {
	switch (now.kind) {
		case "working":
		case "starting":
			return "working";
		case "stopped":
			return "stopped";
		case "error":
			return "failed";
		default:
			return "end";
	}
}

/** `Working on M3 · title` / `Stopped in M3 · title` / `Stopped before M4 · title` / `Finished`. */
function NowTitle({ panel }: { panel: Panel }) {
	const now = panel.now;
	const m = now.module;
	switch (now.kind) {
		case "working":
			return m ? <ModTitle lead="Working on" mod={m} /> : <span className="k">Working</span>;
		case "starting":
			if (panel.status === "idle") return "Starting";
			/* before the plan the agent is at the before-plan station; between modules no module is active */
			return panel.plan ? (
				<span className="k">Working</span>
			) : (
				<>
					<span className="k">Working</span> <span className="k">·</span> {panel.pre.title}
				</>
			);
		case "stopped":
			return m && now.stoppedWhere ? (
				<ModTitle lead={now.stoppedWhere === "in" ? "Stopped in" : "Stopped before"} mod={m} />
			) : (
				"Stopped"
			);
		case "error":
			return m && now.stoppedWhere ? (
				<ModTitle lead={now.stoppedWhere === "in" ? "Error in" : "Error before"} mod={m} />
			) : (
				"Error"
			);
		default:
			return "Finished";
	}
}

function ModTitle({ lead, mod }: { lead: string; mod: ModView }) {
	return (
		<>
			<span className="k">{lead}</span> <span className="mono">{mod.id}</span> <span className="k">·</span> {mod.title}
		</>
	);
}

/** The first line of an error message, short enough for the bar (the tooltip has all of it). */
function firstWords(text: string): string {
	const line = text.split("\n")[0]?.trim() ?? "";
	return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/* L0 reflects only the agent's state (no L1 selection outline) */
function Progress({ panel, ui }: PieceProps) {
	const now = panel.now;
	if (!now.progress.length) return null;
	const k = redoTarget(ui.s);
	const shown = now.progress.map((p) => ({ id: p.id, real: p.status, st: shownStatus(panel, k, p.id) }));
	const label = `Progress: ${shown.map((p) => `${p.id} ${shownLabel(p.real, p.st)}`).join("; ")}`;
	const next = now.kind === "working" ? now.next : undefined;
	return (
		<div className="prog">
			<span className="seg" {...tipImg(label)}>
				{shown.map((p) => (
					<i key={p.id} className={`s ${p.st}`} />
				))}
			</span>
			{next ? (
				<span className="next" {...tipImg(`Next module: ${next.id} · ${next.title}`)}>
					<Icon name="arrowr" size={14} />
					<span>next</span>
					<span className="mono">{next.id}</span>
				</span>
			) : null}
		</div>
	);
}

/** Leading glyph or icon of a flag in the flags popover (the flagged module's shape, as on the line). */
function flagMark(flag: Flag): { glyph?: GlyphStatus; icon?: IconName } {
	switch (flag.rule) {
		case "unverified":
			return { glyph: "unverified" };
		case "tests_failing":
			return { glyph: "failed" };
		case "command_change":
			return { icon: "term" };
		case "unassigned_edit":
			return { icon: "edit" };
		default:
			return { icon: "activity" };
	}
}

/* the flag pill is hidden at zero; clicking a flag selects its module (Modules) or filters the log (Log) */
function FlagPill({ panel, ui, ctlRef }: PieceProps & { ctlRef: RefObject<HTMLDivElement | null> }) {
	const flags = panel.now.flags;
	if (!flags.length) return null;
	const open = ui.s.pop === "flags";
	return (
		<div className="ctl" ref={ctlRef}>
			<button
				type="button"
				className="pill flag"
				aria-label={`${plural(flags.length, "flag")}. Show flags`}
				aria-expanded={open}
				aria-haspopup="dialog"
				data-tip="Flags"
				data-k="flagbtn"
				onClick={() => ui.openPop("flags")}
			>
				<Icon name="flag" size={14} />
				<span className="mono">{flags.length}</span>
			</button>
			{open ? (
				<div className="pop" role="dialog" aria-label="Flags">
					<h3>
						<Icon name="flag" size={16} />
						Flags
					</h3>
					{flags.map((f, i) => {
						const mark = flagMark(f);
						return (
							<button
								key={f.id}
								type="button"
								className="btn ghost"
								style={FLAG_BTN}
								data-k={i === 0 ? "flaggo" : `flaggo-${i}`}
								onClick={() => ui.flagGo(f)}
							>
								{mark.glyph ? <Glyph status={mark.glyph} size={16} /> : <Icon name={mark.icon ?? "flag"} size={16} />}
								<span>{f.text}</span>
								<Icon name="chevr" size={14} />
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

const FLAG_BTN: CSSProperties = {
	justifyContent: "flex-start",
	height: "auto",
	minHeight: 34,
	whiteSpace: "normal",
	textAlign: "left",
};

/** Where an armed pause would hold the agent, as chip text (`after M3` / `after plan` / `before M4`). */
function pauseLabel(now: NowView): string | undefined {
	return now.slotLabel;
}

function ArmedChip({ panel }: { panel: Panel }) {
	const at = pauseLabel(panel.now);
	if (!panel.now.armed || !panel.live || !at) return null;
	const [word, ...rest] = at.split(" ");
	const target = rest.join(" ");
	return (
		<span
			className="pill armed"
			id="armedChip"
			{...tipImg(`Pause armed ${at}`, `Agent will stop and wait for you ${at}`)}
		>
			<Octagon size={14} solid />
			<span>{word}</span>
			<span className={target === "plan" ? undefined : "mono"}>{target}</span>
		</span>
	);
}

/* constant name; aria-pressed carries the state and the armed chip describes where */
function PauseButton({ panel, ui }: PieceProps) {
	const on = panel.now.armed;
	const at = pauseLabel(panel.now);
	const tip = on ? `Pause armed${at ? ` ${at}` : ""}. Press to disarm` : `Pause at next stop${at ? ` (${at})` : ""}`;
	return (
		<button
			type="button"
			className="ib"
			aria-pressed={on}
			aria-label="Pause at next stop"
			aria-describedby={on && at ? "armedChip" : undefined}
			data-tip={tip}
			data-k="pausebtn"
			onClick={() => ui.togglePause(!on, "pausebtn")}
		>
			<Icon name="pausestop" size={20} />
		</button>
	);
}

function NoteControl({ panel, ui, ctlRef }: PieceProps & { ctlRef: RefObject<HTMLDivElement | null> }) {
	const queued = panel.now.queued;
	const n = queued.length;
	const open = ui.s.pop === "note";
	return (
		<div className="ctl" ref={ctlRef}>
			<button
				type="button"
				className="ib"
				aria-label={`Note to agent${n ? `, ${n} queued` : ""}`}
				data-tip="Note to agent"
				aria-expanded={open}
				aria-haspopup="dialog"
				data-k="notebtn"
				onClick={() => ui.openPop("note")}
			>
				<Icon name="note" size={20} />
				{n ? <span className="dot" aria-hidden="true" /> : null}
			</button>
			{open ? <NotePop panel={panel} ui={ui} /> : null}
		</div>
	);
}

function NotePop({ panel, ui }: PieceProps) {
	/* what you already sent and the agent has not read yet (notes and corrections; the button's count), in both views */
	const queued = panel.now.queued;
	return (
		<form
			className="pop"
			role="dialog"
			aria-label="Note to agent"
			onSubmit={(e) => {
				e.preventDefault();
				ui.sendNote();
			}}
		>
			{queued.length ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the list scrolls, so it takes focus (keyboard scrolling)
				<ul className="nq" id="noteQ" tabIndex={0} aria-label={`${queued.length} queued for the agent`}>
					{queued.map((q) => (
						<li key={q.interventionId}>
							<Icon name="note" size={14} />
							{q.kind === "correct" && q.moduleId ? (
								<>
									<span className="sr-only">Correction for</span> <span className="tag">{q.moduleId}</span>{" "}
								</>
							) : (
								<>
									<span className="sr-only">Note:</span>{" "}
								</>
							)}
							<span className="nt">{q.text}</span>
							<span className="mono tm">{q.t}</span>
						</li>
					))}
				</ul>
			) : null}
			<label className="when" htmlFor="noteIn">
				<Icon name="clock" size={14} />
				{panel.now.when}
			</label>
			<div className="frow-in">
				<input
					id="noteIn"
					className="field"
					autoComplete="off"
					placeholder="One line for the agent"
					data-k="notein"
					value={ui.s.noteDraft}
					aria-describedby={queued.length ? "noteQ" : undefined}
					onChange={(e) => ui.setNoteDraft(e.target.value)}
				/>
				<button className="btn primary" type="submit">
					<Icon name="send" size={16} />
					Send
				</button>
			</div>
		</form>
	);
}

/** What Stop does now, for the confirmation (the mockup's stopPop text, from live data). */
function stopText(now: NowView): string {
	if (now.kind === "working" && now.module) return `${now.module.id} stops mid-step. Code changes so far are kept.`;
	const before =
		now.decision?.next ??
		(now.kind === "starting" && now.slot?.boundary === "before_start" ? now.slot.moduleId : undefined);
	if (before) return `The run ends before ${before}. Code is kept.`;
	return now.kind === "waiting"
		? "The run ends here. Code is kept."
		: "The agent stops mid-step. Code changes so far are kept.";
}

function StopControl({
	panel,
	ui,
	labelled,
	popRef,
}: PieceProps & { labelled: boolean; popRef: RefObject<HTMLDivElement | null> }) {
	const open = ui.s.pop === "stop";
	return (
		<div className="ctl">
			{labelled ? (
				<button
					type="button"
					className="btn dghost"
					aria-expanded={open}
					aria-haspopup="dialog"
					data-k="stopbtn"
					onClick={() => ui.openPop("stop")}
				>
					<Icon name="stop" size={16} />
					Stop
				</button>
			) : (
				<button
					type="button"
					className="ib danger"
					aria-label="Stop the agent"
					data-tip="Stop the agent"
					aria-expanded={open}
					aria-haspopup="dialog"
					data-k="stopbtn"
					onClick={() => ui.openPop("stop")}
				>
					<Icon name="stop" size={20} />
				</button>
			)}
			{open ? (
				<div
					className="pop"
					role="alertdialog"
					aria-modal="true"
					aria-labelledby="stopH"
					aria-describedby="stopD"
					ref={popRef}
				>
					<h3 id="stopH">
						<Icon name="stop" size={16} />
						Stop the agent?
					</h3>
					<p id="stopD" className="muted" style={{ margin: 0, fontSize: 12 }}>
						{stopText(panel.now)}
					</p>
					<div className="row">
						<button type="button" className="btn" data-k="stopcancel" onClick={ui.closePop}>
							Cancel
						</button>
						<button type="button" className="btn danger" data-k="stopgo" onClick={ui.stopAgent}>
							<Icon name="stop" size={16} />
							Stop now
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

// ---- behaviour ---------------------------------------------------------------------------------

/**
 * The Stop confirmation is modal: everything else in the bar and the page is inert while it is
 * open (the mockup's applyModal: #main, and every sibling on the way from the popover up to #now).
 * Re-applied after every render and undone in the cleanup, so React-owned nodes never keep it.
 */
function useStopModal(open: boolean, popRef: RefObject<HTMLDivElement | null>): void {
	useLayoutEffect(() => {
		const pop = open ? popRef.current : null;
		if (!pop) return;
		const inert: HTMLElement[] = [];
		const main = document.getElementById("main");
		if (main) inert.push(main);
		for (let n: HTMLElement | null = pop; n && n.id !== "now"; n = n.parentElement) {
			const parent: HTMLElement | null = n.parentElement;
			if (!parent) break;
			for (const c of Array.from(parent.children)) if (c !== n && c instanceof HTMLElement) inert.push(c);
		}
		for (const el of inert) el.inert = true;
		return () => {
			for (const el of inert) el.inert = false;
		};
	});
}

/**
 * Non-modal popovers (note, flags) close when focus lands outside them and their trigger, without
 * moving focus (the mockup's focusout rule). Listening for focusin rather than focusout means the
 * close renders after focus has arrived, so nothing pulls it back.
 */
function useFocusClose(
	ui: Ui,
	noteCtl: RefObject<HTMLDivElement | null>,
	flagCtl: RefObject<HTMLDivElement | null>,
): void {
	const pop = ui.s.pop;
	const { dismissPop } = ui;
	useEffect(() => {
		if (pop !== "note" && pop !== "flags") return;
		const onFocus = (e: FocusEvent) => {
			const ctl = (pop === "note" ? noteCtl : flagCtl).current;
			const to = e.target;
			if (ctl && to instanceof Node && !ctl.contains(to)) dismissPop();
		};
		document.addEventListener("focusin", onFocus);
		return () => document.removeEventListener("focusin", onFocus);
	}, [pop, dismissPop, noteCtl, flagCtl]);
}

/**
 * Says what changed in the agent's state (the mockup's announceState): a decision is needed
 * (assertive, stays until the agent moves on), the agent started a module, the run finished.
 * Not while scrubbing a replay, and not for the state a run opens in (except a pending decision).
 * Stopping is already announced by its toast.
 */
function useAnnounceState(panel: Panel): void {
	const now = panel.now;
	const key = `${now.kind}|${now.module?.id ?? ""}|${now.decision?.boundaryId ?? ""}`;
	const last = useRef<string | null>(null);
	const message = stateMessage(panel);
	const text = message?.text;
	const assertive = message?.assertive ?? false;
	const replaying = panel.replaying;
	const loaded = panel.events.length > 0;
	useEffect(() => {
		if (!loaded || last.current === key) return;
		const first = last.current === null;
		last.current = key;
		/* opening a run says only a pending decision; after that, every change (the mockup announces changes) */
		if (!replaying && text && (!first || assertive)) announce(text, assertive);
	}, [key, loaded, replaying, text, assertive]);
}

function stateMessage(panel: Panel): { text: string; assertive: boolean } | undefined {
	const now = panel.now;
	if (now.kind === "waiting" && now.decision) {
		const d = now.decision;
		const where = d.next ? `before ${d.next}` : d.after ? `after ${d.after}` : "after the plan";
		const tip = d.what.tip.replace(/\.$/, "");
		return { text: `Decision needed. The agent is waiting ${where}. ${tip}.`, assertive: true };
	}
	if (now.kind === "working" && now.module) {
		return { text: `Agent working on ${now.module.id}, ${now.module.title}.`, assertive: false };
	}
	if (now.kind === "finished") {
		const n = now.flags.length;
		return { text: n ? `Run finished. ${plural(n, "flag")}.` : "Run finished.", assertive: false };
	}
	if (now.kind === "error") return { text: "Run ended with an error.", assertive: false };
	return undefined;
}
