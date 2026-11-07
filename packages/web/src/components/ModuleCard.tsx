/**
 * Levels 2 and 3, Modules view: the module card (goal, done-when criteria, facts, vchip, primary
 * button, inline Editor), the evidence column (Steps / Diff / Test output / Instruction versions
 * tabs) or the RedoPanel in its place, and the run summary (finished, nothing selected). Port of
 * renderWork(), moduleCard(), cardTools(), critHTML(), factsHTML(), primaryBtn(), evidenceHTML(),
 * tabBody(), stepsHTML(), stepRow(), stepDetail(), versionsHTML() and summaryCard(). The detail
 * pieces (StepDetail, VersionList, CriteriaList, TextDetail) are exported for LogView's row details.
 *
 * When the card changes station or a redo starts a new attempt (the selection follows the agent, or
 * you pick a station), the new card slides in from the side it comes from with a light sweep while a
 * copy of the old one fades out underneath (ui/motion.ts).
 */

import type { CriterionStatus, Flag } from "@vcm/protocol";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { type CodeLine, joinAnd, oneLine, plural } from "../model/format.ts";
import {
	ACT_ICON,
	type ActView,
	type GlyphStatus,
	type ModView,
	type Panel,
	PRE,
	REDO_PREVIEW_LABEL,
	STATUS_LABEL,
	type StepView,
	type SummaryView,
	shownStatus,
	type TestsView,
} from "../model/panel.ts";
import { type EvTab, type PanelProps, redoTarget, type Ui } from "../state/ui.ts";
import { Icon, type IconName } from "../ui/icons.tsx";
import { EASE, EASE_TRAIN, ghostOf, play, reducedMotion } from "../ui/motion.ts";
import { CodeBlock, DiffBar, Glyph, Pips, Strip, tipImg } from "../ui/primitives.tsx";
import { Editor, RedoPanel } from "./Editors.tsx";

/** Props of Work: the shared PanelProps. */
export type WorkProps = PanelProps;

/** What the work area shows, for the change transition: a station (and attempt), or the run summary. */
const SUMMARY = "summary";

/** The card being replaced, copied before React changes it, and where it sat in the work area. */
interface Snapshot {
	key: string;
	node: HTMLElement;
	top: number;
	left: number;
	width: number;
}

/** The copy of a card that only fades out (ghostOf), placed where the card sat. */
function ghostCard(s: Snapshot): HTMLElement {
	const g = s.node;
	g.classList.add("card-ghost");
	g.style.top = `${s.top}px`;
	g.style.left = `${s.left}px`;
	g.style.width = `${s.width}px`;
	return g;
}

/** `<div class="work">`: the run summary when the run ended and nothing is selected, else the selected card. */
export function Work({ panel, ui }: WorkProps) {
	const mod = ui.s.sel ? panel.byId[ui.s.sel] : undefined;
	const card = mod ?? (panel.summary ? undefined : panel.pre);
	/* a redo's new attempt is a new card; a module's first attempt starting is the same card */
	const shown = card ? `${card.id}:${Math.max(1, card.attemptN ?? 1)}` : SUMMARY;
	const shownId: string = card?.id ?? SUMMARY;
	const workRef = useRef<HTMLDivElement>(null);
	const last = useRef({ key: shown, id: shownId });
	const snap = useRef<Snapshot | null>(null);
	const cardH = useRef<number | null>(null);
	/* a card that gets much shorter while the page is scrolled (a redo panel closing) would make the page
	   snap up as the scroll clamps: hold the old height and let it go, so the page glides up instead */
	useLayoutEffect(() => {
		const work = workRef.current;
		const h = (work?.firstElementChild as HTMLElement | null)?.offsetHeight ?? null;
		const before = cardH.current;
		cardH.current = h;
		if (!work || h === null || before === null || before - h < 40 || window.scrollY <= 0) return;
		const now = work.offsetHeight;
		play(work, [{ minHeight: `${now + before - h}px` }, { minHeight: `${now}px` }], { duration: 700, easing: EASE });
	});
	/* copy the card about to be replaced now: rendering runs before React changes the DOM */
	if (last.current.key !== shown && !snap.current && !reducedMotion()) {
		const old = workRef.current?.firstElementChild;
		if (old instanceof HTMLElement) {
			const node = ghostOf(old);
			snap.current = { key: last.current.key, node, top: old.offsetTop, left: old.offsetLeft, width: old.offsetWidth };
		}
	}
	/* the new card slides in from its side of the line (later modules from the right; the summary comes
	   after the last) with a light sweep, while the old one fades out underneath toward the other side */
	useLayoutEffect(() => {
		const prev = last.current;
		if (prev.key === shown) return;
		last.current = { key: shown, id: shownId };
		const before = snap.current;
		snap.current = null;
		const order = (id: string) => (id === PRE ? -1 : id === SUMMARY ? panel.ids.length : panel.ids.indexOf(id));
		const dir = Math.sign(order(shownId) - order(prev.id)) || 1;
		const work = workRef.current;
		const now = work?.firstElementChild;
		play(
			now,
			[
				{ opacity: 0.3, translate: `${dir * 72}px 0` },
				{ opacity: 1, translate: "0 0" },
			],
			{ duration: 680, easing: EASE },
		);
		play(
			now,
			[
				{ opacity: 1, translate: dir > 0 ? "-100% 0" : "100% 0" },
				{ opacity: 0, translate: dir > 0 ? "100% 0" : "-100% 0" },
			],
			{ duration: 950, easing: EASE_TRAIN, pseudoElement: "::after" },
		);
		if (work && before?.key === prev.key) {
			const g = ghostCard(before);
			work.appendChild(g);
			const out = play(
				g,
				[
					{ opacity: 0.9, translate: "0 0" },
					{ opacity: 0, translate: `${-dir * 90}px 0` },
				],
				{ duration: 180, easing: EASE },
			);
			if (!out) g.remove();
			else {
				out.onfinish = () => g.remove();
				out.oncancel = () => g.remove();
			}
		}
	});
	return (
		<div className="work" ref={workRef}>
			{card ? (
				<ModuleCard panel={panel} ui={ui} mod={card} />
			) : panel.summary ? (
				<RunSummary panel={panel} ui={ui} summary={panel.summary} />
			) : null}
		</div>
	);
}

/** Props of ModuleCard. */
export interface ModuleCardProps extends PanelProps {
	/** The station to show (a module, or `panel.pre`). */
	mod: ModView;
}

/** `<article class="card">` for one station (with `#cardT` title, `prim` primary button, `#evCol`). */
export function ModuleCard({ panel, ui, mod: m }: ModuleCardProps) {
	const ed = ui.s.editor;
	const redoHere = ed?.kind === "redo" && ed.id === m.id;
	const edHere = !!ed && ed.kind !== "redo" && ed.id === m.id;
	const evOpen = ui.s.evOpen || redoHere;
	const cardRef = useRef<HTMLElement>(null);
	const ceRef = useRef<HTMLElement>(null);
	const shape = useRef({ ev: evOpen, redo: redoHere, h: 0 });
	/* opening or closing the evidence column (or the redo panel in it) fades the column in and eases the
	   card's height, instead of reflowing the card in one frame */
	useLayoutEffect(() => {
		const card = cardRef.current;
		const h = card?.offsetHeight ?? 0;
		const prev = shape.current;
		shape.current = { ev: evOpen, redo: redoHere, h };
		if (prev.ev === evOpen && prev.redo === redoHere) return;
		play(
			ceRef.current,
			[
				{ opacity: 0.2, translate: "0 10px" },
				{ opacity: 1, translate: "0 0" },
			],
			{ duration: 480, easing: EASE },
		);
		if (card && prev.h && Math.abs(prev.h - h) > 12) {
			play(
				card,
				[
					{ height: `${prev.h}px`, overflow: "clip" },
					{ height: `${h}px`, overflow: "clip" },
				],
				{ duration: 480, easing: EASE },
			);
		}
	});
	const st = m.status;
	/* keep the real status shape; a small slashed chip says a pending redo will replace it */
	const replaced = st !== "replaced" && shownStatus(panel, redoTarget(ui.s), m.id) === "replaced";
	const left = m.goal || m.criteria.length;
	const hasFacts = !!(m.files.length || m.tests || m.looked.length || m.actions.length);
	return (
		<article ref={cardRef} className={evOpen ? "card" : "card noev"} aria-labelledby="cardT">
			<div className="cm">
				<header className="ch">
					<Glyph status={st} size={24} />
					{replaced ? (
						<span className="rpl" {...tipImg(REDO_PREVIEW_LABEL)}>
							<Glyph status="replaced" size={16} />
						</span>
					) : null}
					{m.isPre ? null : <span className="cid">{m.id}</span>}
					<h2 id="cardT" tabIndex={-1}>
						{m.title}
					</h2>
					<span className="sr-only">
						, {STATUS_LABEL[st]}
						{m.depsText ? `, ${m.depsText}` : ""}
					</span>
					<div className="tools">
						<CardTools ui={ui} mod={m} redoHere={redoHere} />
					</div>
				</header>
				<div className={left && hasFacts ? "cbody" : "cbody solo"}>
					{left ? (
						<div className="cl">
							{m.goal ? (
								<p className="goal">
									<Icon name="target" size={16} />
									<span>{m.goal}</span>
								</p>
							) : null}
							<CriteriaList criteria={m.criteria} tests={m.tests} />
						</div>
					) : null}
					{hasFacts ? <Facts ui={ui} mod={m} off={redoHere} /> : null}
				</div>
				{edHere ? <Editor panel={panel} ui={ui} mod={m} /> : null}
				{edHere || redoHere ? null : (
					<div className="cf">
						<PrimaryButton ui={ui} mod={m} />
					</div>
				)}
			</div>
			{evOpen ? (
				<aside className="ce" id="evCol" ref={ceRef} aria-label={redoHere ? "Redo" : "Evidence"}>
					{redoHere ? <RedoPanel panel={panel} ui={ui} mod={m} /> : <Evidence ui={ui} mod={m} />}
				</aside>
			) : null}
		</article>
	);
}

/** The show/hide evidence toggle; hidden while the redo panel occupies the second column. */
function EvToggle({ ui, redoHere }: { ui: Ui; redoHere: boolean }) {
	if (redoHere) return null;
	const o = ui.s.evOpen;
	const what = `${o ? "Hide" : "Show"} evidence`;
	return (
		<button
			type="button"
			className="ib"
			aria-expanded={o}
			aria-controls={o ? "evCol" : undefined}
			aria-label={what}
			data-tip={what}
			data-k="evtoggle"
			onClick={ui.toggleEv}
		>
			<Icon name="panel" size={18} />
		</button>
	);
}

/** Attempt chips, only when a module has more than one attempt: replaced ones slashed, the shown one plain. */
function AttemptChips({ mod: m }: { mod: ModView }) {
	if (m.attempts.length < 2) return null;
	const say = (a: ModView["attempts"][number]) => (a.replaced ? "replaced by redo" : a.current ? "shown" : a.status);
	const label = `Attempts: ${m.attempts.map((a) => `#${a.n} ${say(a)}`).join(", ")}`;
	return (
		<span className="chips" {...tipImg(label)}>
			{m.attempts.map((a) => (
				<span key={a.attemptId} className={a.replaced ? "chip struck mono" : "chip mono"} aria-hidden="true">
					{a.replaced ? <Glyph status="replaced" size={12} /> : null}#{a.n}
				</span>
			))}
		</span>
	);
}

/** Header tools: time pill, attempt chips, version chip, evidence toggle (the mockup's cardTools). */
function CardTools({ ui, mod: m, redoHere }: { ui: Ui; mod: ModView; redoHere: boolean }) {
	if (m.isPre) {
		return (
			<>
				{m.span ? (
					<span
						className="pill"
						{...tipImg(`Before the plan was made, ${m.span.replace("–", " to ")}`, "Before the plan was made")}
					>
						<Icon name="clock" size={14} />
						<span className="mono">{m.span}</span>
					</span>
				) : null}
				<EvToggle ui={ui} redoHere={redoHere} />
			</>
		);
	}
	const you = m.cur.by === "you";
	return (
		<>
			{m.dur ? (
				<span className="pill" {...tipImg(`${m.status === "working" ? "Running for" : "Took"} ${m.dur}`)}>
					<Icon name="clock" size={14} />
					<span className="mono">{m.dur}</span>
				</span>
			) : null}
			<AttemptChips mod={m} />
			<button
				type="button"
				className={you ? "vchip you" : "vchip"}
				aria-label={`Instructions v${m.cur.v}, written by ${you ? "you" : "the agent"}. Show history`}
				data-tip={`Instructions v${m.cur.v} · by ${you ? "you" : "agent"}`}
				data-k="vchip"
				aria-disabled={redoHere || undefined}
				onClick={() => {
					if (!redoHere) ui.openEv("versions", "vchip");
				}}
			>
				<Icon name={you ? "user" : "bot"} size={14} />v{m.cur.v}
			</button>
			<EvToggle ui={ui} redoHere={redoHere} />
		</>
	);
}

/** Props of CriteriaList. */
export interface CriteriaListProps {
	/** Done-when criteria with their status. */
	criteria: { text: string; st: CriterionStatus }[];
	/** The latest tests, for the "(N failing)" tooltip of agent-claimed criteria. */
	tests?: TestsView | null;
}

/** `<div><div class="lab">Done when</div><ul class="crit">` (the mockup's critHTML); nothing when empty. */
export function CriteriaList({ criteria, tests }: CriteriaListProps) {
	if (!criteria.length) return null;
	const failing = tests && tests.fail > 0 ? tests.fail : 0;
	return (
		<div>
			<div className="lab">Done when</div>
			<ul className="crit">
				{criteria.map((c, i) => {
					const g: GlyphStatus =
						c.st === "verified"
							? "verified"
							: c.st === "agent" || c.st === "unreported"
								? "unverified"
								: c.st === "failed"
									? "failed"
									: "pending";
					/* status shape + exactly ONE source icon (flask = tests show it, speech bubble = agent says); details in tooltip + name */
					const tip =
						c.st === "verified"
							? "Met · tests show it"
							: c.st === "agent"
								? `Agent says met · tests don’t show it${failing ? ` (${failing} failing)` : ""}`
								: c.st === "failed"
									? "Not met"
									: c.st === "unreported"
										? "No result from the agent"
										: "Not checked yet";
					const say =
						c.st === "verified"
							? "met, tests show it"
							: c.st === "agent"
								? `agent says met, tests do not show it${failing ? ` (${failing} failing)` : ""}`
								: c.st === "failed"
									? "not met"
									: c.st === "unreported"
										? "the agent reported no result"
										: "not checked yet";
					return (
						// biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so its tooltip shows on keyboard focus (mockup)
						// biome-ignore lint/suspicious/noArrayIndexKey: criteria texts may repeat; the list is positional
						<li key={i} tabIndex={0} data-tip={tip} aria-label={`${c.text}: ${say}`}>
							<Glyph status={g} size={16} />
							<span>{c.text}</span>
							<span className="src" aria-hidden="true">
								{c.st === "verified" ? (
									<span className="sx ok">
										<Icon name="flask" size={14} />
									</span>
								) : c.st === "agent" ? (
									<span className="sx say">
										<Icon name="say" size={14} />
									</span>
								) : null}
							</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/** Each fact is identified by its leading icon + tooltip (no text labels); empty facts are not drawn. */
function Facts({ ui, mod: m, off }: { ui: Ui; mod: ModView; off: boolean }) {
	const dis = off || undefined;
	const groups: ReactNode[] = [];
	if (m.files.length) {
		groups.push(
			// biome-ignore lint/a11y/useSemanticElements: the mockup's role="group" (a fieldset would restyle it)
			<div key="files" role="group" aria-label="Changed files">
				{m.files.map((f) => (
					<button
						key={f.path}
						type="button"
						className="frow"
						data-k={`f-${f.path}`}
						aria-label={`Changed ${f.path}, +${f.add} −${f.del} lines. Open diff`}
						data-tip="Changed · open diff"
						aria-disabled={dis}
						onClick={() => {
							if (!off) ui.openEv("diff", `f-${f.path}`);
						}}
					>
						<Icon name="file" size={16} className="muted" />
						<span className="fn mono">{f.path}</span>
						<span className="spacer" />
						<DiffBar add={f.add} del={f.del} />
					</button>
				))}
			</div>,
		);
	}
	if (m.tests) {
		const t = m.tests;
		groups.push(
			// biome-ignore lint/a11y/useSemanticElements: the mockup's role="group" (a fieldset would restyle it)
			<div key="tests" role="group" aria-label="Latest tests">
				<button
					type="button"
					className="frow"
					data-k="f-tests"
					aria-label={`Latest tests: ${t.pass} passed, ${t.fail} failed${t.live ? ", still running" : t.stopped ? ", stopped" : ""}. Open output`}
					data-tip="Latest tests · open output"
					aria-disabled={dis}
					onClick={() => {
						if (!off) ui.openEv("tests", "f-tests");
					}}
				>
					<Icon name="flask" size={16} className="muted" />
					<Pips pass={t.pass} fail={t.fail} live={t.live} />
				</button>
			</div>,
		);
	}
	if (m.looked.length) {
		groups.push(
			// biome-ignore lint/a11y/useSemanticElements: the mockup's role="group" (a fieldset would restyle it)
			<div key="looked" role="group" aria-label="Looked at">
				<div className="chips">
					{m.looked.map((p) => (
						<button
							key={p}
							type="button"
							className="chip lnk mono"
							data-k={`lk-${p}`}
							aria-label={`Looked at ${p}. Open step`}
							data-tip="Looked at · open step"
							aria-disabled={dis}
							onClick={() => {
								if (!off) ui.goRead(p, `lk-${p}`);
							}}
						>
							<Icon name="eye" size={12} />
							{p}
						</button>
					))}
				</div>
			</div>,
		);
	}
	if (m.actions.length) {
		groups.push(
			// biome-ignore lint/a11y/useSemanticElements: the mockup's role="group" (a fieldset would restyle it)
			<div key="activity" role="group" aria-label="Activity">
				<div className="frow">
					<Icon name="activity" size={16} className="muted" />
					<Strip acts={m.actions} focusable />
				</div>
			</div>,
		);
	}
	return groups.length ? <div className="facts">{groups}</div> : null;
}

/** The card's one primary button by status: Change (not started), Correct (running), Redo from (started). */
function PrimaryButton({ ui, mod: m }: { ui: Ui; mod: ModView }) {
	if (m.isPre || !m.primary) return null;
	const open = (kind: "change" | "correct" | "redo") => () => ui.openEditor(kind, m.id, { opener: "prim" });
	if (m.primary === "change") {
		return (
			<button type="button" className="btn primary" data-k="prim" onClick={open("change")}>
				<Icon name="edit" size={16} />
				Change {m.id}…
			</button>
		);
	}
	if (m.primary === "correct") {
		return (
			<button type="button" className="btn primary" data-k="prim" onClick={open("correct")}>
				<Icon name="note" size={16} />
				Correct {m.id}…
			</button>
		);
	}
	return (
		<button type="button" className="btn dghost" data-k="prim" onClick={open("redo")}>
			<Icon name="undo" size={16} />
			Redo from {m.id}…
		</button>
	);
}

// ---- evidence column ---------------------------------------------------------------------------

const TABS: { k: EvTab; icon: IconName; lbl: string }[] = [
	{ k: "steps", icon: "list", lbl: "Steps" },
	{ k: "diff", icon: "filediff", lbl: "Diff" },
	{ k: "tests", icon: "flask", lbl: "Test output" },
	{ k: "versions", icon: "history", lbl: "Instruction versions" },
];

/** Tabs + tab panel. Icon-only tabs: the numbers already appear on the card (level 2), so they are not repeated. */
function Evidence({ ui, mod: m }: { ui: Ui; mod: ModView }) {
	/* the before-plan station has no instructions; it gets Diff / Test output only when it has them */
	const tabs = m.isPre
		? TABS.filter((x) => x.k === "steps" || (x.k === "diff" && m.files.length) || (x.k === "tests" && m.tests))
		: TABS;
	const t = tabs.some((x) => x.k === ui.s.evTab) ? ui.s.evTab : "steps";
	return (
		<>
			<div className="tabs" role="tablist" aria-label="Evidence">
				{tabs.map((x) => (
					<button
						key={x.k}
						type="button"
						className="tab"
						role="tab"
						id={`tab-${x.k}`}
						aria-selected={x.k === t}
						aria-controls="evp"
						tabIndex={x.k === t ? 0 : -1}
						data-k={`tab-${x.k}`}
						aria-label={x.lbl}
						data-tip={x.lbl}
						onClick={() => ui.openEv(x.k)}
					>
						<Icon name={x.icon} size={16} />
					</button>
				))}
			</div>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: the tab panel is a tab stop (it can scroll), as in the mockup */}
			<div className="evb" role="tabpanel" id="evp" tabIndex={0} aria-labelledby={`tab-${t}`}>
				<TabBody ui={ui} mod={m} tab={t} />
			</div>
		</>
	);
}

/** Nothing to show: "Not started" before the module ran, else a dash. */
function Empty({ mod: m }: { mod: ModView }) {
	if (!m.isPre && !m.attemptId) {
		return (
			<div className="empty">
				<Glyph status="pending" size={14} />
				<span>Not started</span>
			</div>
		);
	}
	if (m.status === "working") {
		return (
			<div className="empty">
				<Glyph status="working" size={14} animate />
				<span>Starting</span>
			</div>
		);
	}
	return (
		<div className="empty">
			<span className="muted">—</span>
		</div>
	);
}

function TabBody({ ui, mod: m, tab }: { ui: Ui; mod: ModView; tab: EvTab }) {
	if (tab === "diff") {
		if (!m.files.length) return <Empty mod={m} />;
		return (
			<>
				{m.files.map((f, i) => (
					<div key={f.path} className="det" style={{ margin: i < m.files.length - 1 ? "0 0 8px" : 0 }}>
						<div className="dh">
							<Icon name="file" size={14} />
							<span>{f.path}</span>
							<span className="spacer" />
							<DiffBar add={f.add} del={f.del} />
						</div>
						{f.diff.length ? <CodeBlock lines={f.diff} label={`Diff ${f.path}`} /> : null}
					</div>
				))}
			</>
		);
	}
	if (tab === "tests") {
		const t = m.tests;
		if (!t) return <Empty mod={m} />;
		return (
			<div className="det" style={{ margin: 0 }}>
				<div className="dh">
					<Icon name="term" size={14} />
					<span>{t.act.target}</span>
					<span className="spacer" />
					<Pips pass={t.pass} fail={t.fail} live={t.live} />
				</div>
				<CodeBlock lines={t.act.out} label={`${t.act.target} output`} />
			</div>
		);
	}
	if (tab === "versions") return <VersionList mod={m} />;
	return <Steps ui={ui} mod={m} />;
}

/**
 * The station's steps (actions with folded reads), the agent's narration, and the notes and
 * corrections you sent that reached it, in trace order. They come from the same rows the Log
 * shows, so either view can review what you sent.
 */
function Steps({ ui, mod: m }: { ui: Ui; mod: ModView }) {
	if (!m.steps.length) return <Empty mod={m} />;
	return (
		<ul className="steps">
			{m.steps.map((st) => {
				const open = ui.s.exp === st.key;
				return (
					<li key={st.key}>
						<StepRow ui={ui} step={st} open={open} />
						{open ? <StepBody step={st} /> : null}
					</li>
				);
			})}
		</ul>
	);
}

/** Past-tense verb per action type (step labels). */
const PAST: Record<ActView["type"], string> = {
	read: "Read",
	write: "Wrote",
	edit: "Edited",
	bash: "Ran",
	test: "Ran",
};

/** The tool call as a step: icon, target, result badge, time (the mockup's stepRow / userStepRow). */
function StepRow({ ui, step, open }: { ui: Ui; step: StepView; open: boolean }) {
	const key = step.key;
	const toggle = () => ui.toggleStep(key);
	if (step.kind === "you") {
		const what = step.what === "note" ? "Note · by you" : "Correction · by you";
		/* sent to an attempt a redo replaced: it stays reviewable, marked with that attempt */
		const to = step.attemptN ? `#${step.attemptN}` : undefined;
		return (
			<button
				type="button"
				className="step you"
				data-k={`step-${key}`}
				aria-expanded={open}
				aria-label={`${what}${to ? `, to attempt ${to} (replaced)` : ""}: ${step.text}${step.queued ? ", queued" : ""}`}
				data-tip={step.queued ? "Queued" : to ? `Sent to attempt ${to}, replaced by a redo` : undefined}
				onClick={toggle}
			>
				<Icon name="note" size={16} className="ic" />
				<span className="tg">{what}</span>
				<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
					{to ? (
						<span className="tag" aria-hidden="true">
							{to}
						</span>
					) : null}
					{step.queued ? <Icon name="clock" size={14} className="muted" /> : null}
				</span>
				<span className="tm">{step.t}</span>
			</button>
		);
	}
	if (step.kind === "say") {
		return (
			<button
				type="button"
				className="step say"
				data-k={`step-${key}`}
				aria-expanded={open}
				aria-label={`Agent says: ${step.text}${step.where ? `, ${step.where}` : ""}`}
				onClick={toggle}
			>
				<Icon name="say" size={16} className="ic" />
				<span className="tg">{oneLine(step.text)}</span>
				{/* outside modules after the plan: where it was said (`after M2`) */}
				{step.where ? (
					<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<span className="tag" aria-hidden="true">
							{step.where}
						</span>
					</span>
				) : (
					<span />
				)}
				<span className="tm">{step.t}</span>
			</button>
		);
	}
	/* result badges: diff bar for edits, pips for tests, a red x only when a command fails; successful reads and commands carry none */
	let tg: string;
	let badge: ReactNode = null;
	let lbl: string;
	let icon: IconName;
	let fail = false;
	/* outside modules after the plan: where it happened (`after M2`) */
	const where = (step.kind === "fold" ? step.items[0] : step.act)?.where;
	if (step.kind === "fold") {
		tg = `explored ${step.items.length} files`;
		badge = <Strip acts={step.items} />;
		lbl = `Explored ${step.items.length} files: ${step.items.map((x) => x.target).join(", ")}`;
		icon = ACT_ICON.fold;
	} else {
		const a = step.act;
		const state = a.live ? ", still running" : a.stopped ? ", stopped" : "";
		tg = a.target;
		icon = ACT_ICON[a.type];
		if (a.exit) {
			badge = <Icon name="x" size={14} />;
			lbl = `${PAST[a.type]} ${a.target}, failed`;
			fail = true;
		} else if (a.type === "read") lbl = `Read ${a.target}${state}`;
		else if (a.type === "write" || a.type === "edit") {
			/* no result yet (running, or cut off): no diff to draw */
			if (!state) badge = <DiffBar add={a.add} del={a.del} />;
			lbl = `${PAST[a.type]} ${a.target}${state || `, +${a.add} −${a.del} lines`}`;
		} else if (a.type === "test") {
			badge = <Pips pass={a.pass} fail={a.fail} live={a.live} />;
			lbl = `Ran ${a.target}: ${a.pass} passed, ${a.fail} failed${state}`;
			fail = a.fail > 0;
		} else lbl = `Ran ${a.target}${state}`;
	}
	return (
		<button
			type="button"
			className={fail ? "step fail" : "step"}
			data-k={`step-${key}`}
			aria-expanded={open}
			aria-label={where ? `${lbl}, ${where}` : lbl}
			onClick={toggle}
		>
			<Icon name={icon} size={16} className="ic" />
			<span className="tg">{tg}</span>
			<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
				{where ? (
					<span className="tag" aria-hidden="true">
						{where}
					</span>
				) : null}
				{badge}
			</span>
			<span className="tm">{step.t}</span>
		</button>
	);
}

/** What an expanded step shows. */
function StepBody({ step }: { step: StepView }) {
	if (step.kind === "act") return <StepDetail act={step.act} />;
	if (step.kind === "fold") {
		const lines = step.items.map(
			(x): CodeLine => [
				"c",
				`${x.t}  read ${x.target}${x.lines !== undefined ? `  · ${plural(x.lines, "line")}` : ""}`,
			],
		);
		const call = `read × ${step.items.length}`;
		return (
			<div className="det">
				<div className="dh">
					<Icon name="term" size={14} />
					<span>{call}</span>
				</div>
				<CodeBlock lines={lines} label={call} />
			</div>
		);
	}
	if (step.kind === "say") return <TextDetail icon="say" head="agent" text={step.text} />;
	return <TextDetail icon="user" head="by you" text={step.text} />;
}

/** Props of StepDetail. */
export interface StepDetailProps {
	/** The action to expand (diff, output or excerpt under a `.dh` call header). */
	act: ActView;
}

/** `<div class="det">` under an expanded step or log row (the mockup's stepDetail). */
export function StepDetail({ act: a }: StepDetailProps) {
	let lines = a.out;
	let label = `${a.target} output`;
	if (a.type === "read") {
		label = `Excerpt ${a.target}`;
		if (!lines.length) lines = [["c", `${a.target}${a.lines !== undefined ? ` · ${plural(a.lines, "line")}` : ""}`]];
	} else if (a.type === "write" || a.type === "edit") {
		label = `Diff ${a.target}`;
		if (a.diff.length && !a.exit) lines = a.diff;
	}
	return (
		<div className="det">
			<div className="dh">
				<Icon name="term" size={14} />
				<span>{a.call}</span>
			</div>
			{lines.length ? <CodeBlock lines={lines} label={label} /> : null}
		</div>
	);
}

/** Props of VersionList. */
export interface VersionListProps {
	/** The module whose instruction versions to list (newest first). */
	mod: ModView;
}

/** `<ol class="vers">` (the mockup's versionsHTML). */
export function VersionList({ mod }: VersionListProps) {
	return (
		<ol className="vers">
			{mod.versions
				.slice()
				.reverse()
				.map((v, i) => (
					<li key={v.v} className={i === 0 ? "cur" : ""}>
						<div className="vh2">
							<Icon name={v.by === "you" ? "user" : "bot"} size={14} />
							<span className="mono">v{v.v}</span>
							<span>· by {v.by === "you" ? "you" : "agent"}</span>
							<span className="spacer" />
							<span className="mono">{v.t}</span>
						</div>
						<div style={{ whiteSpace: "pre-wrap" }}>{v.text}</div>
						{v.note ? <div className="muted">{v.note}</div> : null}
					</li>
				))}
		</ol>
	);
}

/** Props of TextDetail. */
export interface TextDetailProps {
	/** Header icon, or a status glyph instead. */
	icon?: IconName;
	glyph?: GlyphStatus;
	/** Header text (`by you`, `task`, `instructions v2 · by you`). */
	head: string;
	/** Body text. */
	text: string;
}

/** `<div class="det">` with a header and a text body (the mockup's userDetail and run/task details). */
export function TextDetail({ icon, glyph, head, text }: TextDetailProps) {
	return (
		<div className="det">
			<div className="dh">
				{glyph ? <Glyph status={glyph} size={14} /> : icon ? <Icon name={icon} size={14} /> : null}
				<span>{head}</span>
			</div>
			<div style={{ padding: "8px 10px", whiteSpace: "pre-wrap" }}>{text}</div>
		</div>
	);
}

// ---- run summary -------------------------------------------------------------------------------

/** Props of RunSummary. */
export interface RunSummaryProps extends PanelProps {
	summary: SummaryView;
}

/**
 * `<article class="card sum">`, finished and nothing selected. The metro line above already shows
 * each module's status and tests, so the summary only adds what the line does not: run time (shown
 * once, here), the flags, the audit, and the whole-run files.
 */
export function RunSummary({ panel, ui, summary }: RunSummaryProps) {
	const { files, total } = summary;
	const end: GlyphStatus = summary.status === "aborted" ? "stopped" : summary.status === "error" ? "failed" : "end";
	return (
		<article className="card sum" aria-labelledby="cardT">
			<div className="cm">
				<header className="ch">
					<Glyph status={end} size={24} />
					<h2 id="cardT" tabIndex={-1}>
						Run summary
					</h2>
					{end === "end" ? null : <span className="sr-only">, {STATUS_LABEL[end]}</span>}
					<div className="tools">
						<span className="pill" {...tipImg(`Run time ${summary.runClock}`, "Run time")}>
							<Icon name="clock" size={14} />
							<span className="mono">{summary.runClock}</span>
						</span>
					</div>
				</header>
				<SummaryFoot panel={panel} ui={ui} summary={summary} />
			</div>
			<aside className="ce" aria-label="Whole-run files">
				<div className="tabs">
					<span
						className="fh"
						{...tipImg(
							`Whole run: ${plural(total.files, "file")} changed, +${total.add} −${total.del} lines`,
							`Whole run: ${plural(total.files, "file")} changed`,
						)}
					>
						<Icon name="filediff" size={16} />
						<span className="mono">{total.files}</span>
						<DiffBar add={total.add} del={total.del} />
					</span>
				</div>
				<div className="evb">
					{files.map((f) => (
						<button
							key={f.path}
							type="button"
							className="frow"
							data-k={`sf-${f.path}`}
							aria-label={`${f.path}, +${f.add} −${f.del} lines, changed by ${joinAnd(f.by.map((b) => stationName(panel, b)))}`}
							onClick={() => {
								const last = f.by.at(-1);
								if (last) ui.selectMod(last);
							}}
						>
							<Icon name="file" size={16} className="muted" />
							<span className="fn mono">{f.path}</span>
							<span className="spacer" />
							{f.by.map((b) => (
								<span key={b} className="tag">
									{b}
								</span>
							))}
							<DiffBar add={f.add} del={f.del} nums="align" />
						</button>
					))}
				</div>
			</aside>
		</article>
	);
}

/** A station as words: its id, or the before-plan station's title. */
function stationName(panel: Panel, id: string): string {
	return id === PRE ? panel.pre.title : id;
}

/** Flags (each opens its station) and the audit's findings (only the non-zero ones). */
function SummaryFoot({ panel, ui, summary }: RunSummaryProps) {
	const { flags, audit } = summary;
	const items: ReactNode[] = [];
	const target = (f: Flag) => f.moduleId ?? PRE;
	flags.forEach((f, i) => {
		const k = target(f);
		items.push(
			<button
				key={f.id}
				type="button"
				className="pill flag"
				data-k={i === 0 ? "sum-flag" : `sum-flag-${i}`}
				aria-label={`${flags.length === 1 ? "1 flag" : "Flag"}: ${f.text}. Open ${stationName(panel, k)}`}
				onClick={() => ui.selectMod(k)}
			>
				<Icon name="flag" size={14} />
				{flags.length === 1 ? <span className="mono">1</span> : null}
				<span>{f.text}</span>
			</button>,
		);
	});
	/* exploring before the plan is expected; only actions outside modules after the plan are a finding */
	const outside = panel.pre.actions.filter((a) => a.where && a.where !== "before plan").length;
	if (outside) {
		items.push(
			<button
				key="unassigned"
				type="button"
				className="pill"
				data-k="sum-pre"
				aria-label={`${plural(outside, "action")} outside modules. Open ${panel.pre.title}`}
				data-tip="Audit · actions outside modules"
				onClick={() => ui.selectMod(PRE)}
			>
				<Glyph status="pre" size={14} />
				<span className="mono">{outside}</span>
				<span>outside modules</span>
			</button>,
		);
	}
	if (audit?.unattributed.length) {
		const n = audit.unattributed.length;
		const paths = [...new Set(audit.unattributed.map((c) => c.path))];
		items.push(
			<span key="unattributed" className="pill" {...tipImg(`Audit · changed by a command: ${paths.join(", ")}`)}>
				<Icon name="term" size={14} />
				<span className="mono">{n}</span>
				<span>{n === 1 ? "unattributed change" : "unattributed changes"}</span>
			</span>,
		);
	}
	if (audit?.missing) {
		items.push(
			<span
				key="missing"
				className="pill"
				{...tipImg(`Audit · ${plural(audit.missing, "action")} missing from the trace`)}
			>
				<Icon name="x" size={14} />
				<span className="mono">{audit.missing}</span>
				<span>missing</span>
			</span>,
		);
	}
	return items.length ? <div className="sumfoot">{items}</div> : null;
}
