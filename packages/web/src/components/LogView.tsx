/**
 * The baseline condition: one chronological list of every trace event (time, module tag, icon,
 * one-line summary, badges, expandable details), filter chips (module, type, flagged) and search,
 * and the same interventions on the rows where they naturally belong: Change Mk on the latest plan
 * row, Correct on the running module's rows, Redo from Mk on the start/finish rows of current
 * attempts, with the Editor / RedoPanel inline under the row they are anchored to. Port of the
 * mockup's renderLog(), logRows(), rowActions() and logDetail(), driven by panel.events.
 * No per-module aggregates (docs/design.md §6.3): every detail is the data of its own event.
 */

import type { ModuleId } from "@vcm/protocol";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { joinAnd } from "../model/format.ts";
import { type LogDetail, type LogEvent, type ModView, type Panel, type PlanItem, PRE } from "../model/panel.ts";
import { defaultRow, type EditorKind, LOG_TYPES, type PanelProps, type Ui, visibleEvents } from "../state/ui.ts";
import { Icon } from "../ui/icons.tsx";
import { DiffBar, Glyph, Pips, tipImg } from "../ui/primitives.tsx";
import { Editor, RedoPanel } from "./Editors.tsx";
import { CriteriaList, StepDetail, TextDetail, VersionList } from "./ModuleCard.tsx";

/** Props of LogView: the shared PanelProps. */
export type LogViewProps = PanelProps;

/** `<section class="log">` with the filters and `#logList` (rows' buttons carry `data-k="lr-<rowId>"`). */
export function LogView({ panel, ui }: LogViewProps) {
	const lf = ui.s.lf;
	const ed = ui.s.editor;
	const rows = visibleEvents(panel, ui.s);
	useTail(panel, !!ed);

	const mods = moduleChips(panel);
	const modTab = mods.includes(lf.mod) ? lf.mod : "all";
	const typeTab = LOG_TYPES.some((t) => t.k === lf.type) ? lf.type : "all";

	// the module you can correct now: Correct on its current attempt's rows, labelled on the newest one shown
	const working = Object.values(panel.byId).find((m) => m.canCorrect);
	const ofWorking = (e: LogEvent) => !!working && e.mod === working.id && e.seq >= (working.startSeq ?? 0);
	const latestAct = rows.findLast(ofWorking)?.id;

	// the open editor renders under its anchor row (always visible), or under the last row if that row is gone
	const anchor = ed ? (rows.some((r) => r.id === ed.row) ? ed.row : rows.at(-1)?.id) : undefined;
	const edMod = ed ? panel.byId[ed.id] : undefined;

	return (
		<section className="log" aria-label="Event log">
			{/* biome-ignore lint/a11y/useSemanticElements: the mockup's role="group" (a fieldset would restyle it) */}
			<div className="ltools" role="group" aria-label="Log filters">
				<div className="fgrp" role="radiogroup" aria-label="Module">
					{mods.map((v) => {
						const on = lf.mod === v;
						return (
							// biome-ignore lint/a11y/useSemanticElements: the mockup's chip radios (roving tabindex, arrow keys in ui.keydown)
							<button
								type="button"
								key={v}
								className="fc"
								role="radio"
								aria-checked={on}
								tabIndex={v === modTab ? 0 : -1}
								data-k={`lfm-${v}`}
								aria-label={v === "all" ? "All modules" : undefined}
								onClick={() => ui.lfMod(v)}
							>
								{v === "all" ? "All" : <span className="mono">{v}</span>}
							</button>
						);
					})}
				</div>
				<div className="fgrp" role="radiogroup" aria-label="Event type">
					{LOG_TYPES.map((t) => {
						const on = lf.type === t.k;
						return (
							// biome-ignore lint/a11y/useSemanticElements: the mockup's chip radios (roving tabindex, arrow keys in ui.keydown)
							<button
								type="button"
								key={t.k}
								className="fc"
								role="radio"
								aria-checked={on}
								tabIndex={t.k === typeTab ? 0 : -1}
								data-k={`lft-${t.k}`}
								data-tip={t.lbl}
								onClick={() => ui.lfType(t.k)}
							>
								{t.icon ? <Icon name={t.icon} size={14} /> : null}
								{t.short}
							</button>
						);
					})}
				</div>
				<div className="fgrp">
					<button
						type="button"
						className="fc"
						aria-pressed={lf.flag}
						data-k="lff"
						data-tip="Only flagged events"
						onClick={() => ui.lfFlag()}
					>
						<Icon name="flag" size={14} />
						Flagged
					</button>
				</div>
				<label className="search">
					<Icon name="search" size={16} />
					<span className="sr-only">Search events</span>
					<input
						id="q"
						type="search"
						placeholder="Search"
						value={lf.q}
						data-k="q"
						autoComplete="off"
						onChange={(e) => ui.lfQuery(e.target.value)}
					/>
				</label>
			</div>
			<ol className="ll" id="logList" tabIndex={-1} aria-label="Events, oldest first">
				{rows.length ? (
					rows.map((e) => {
						const open = ui.s.lexp === e.id;
						const edHere = ed && anchor === e.id ? ed : null;
						const cls = [
							"lr",
							open ? "open" : "",
							ui.s.lcur === e.id ? "cur" : "",
							edHere ? "edit" : "",
							e.id === latestAct ? "act" : "",
							edHere?.kind === "redo" && edHere.row === e.id ? "cut" : "",
						];
						return (
							// keyed by trace position: a redo after the run ended repeats the audit / run-end row ids
							<li key={e.seq} className={cls.filter(Boolean).join(" ")}>
								<div className="lrh">
									<RowButton e={e} open={open} ui={ui} />
									<RowActions
										panel={panel}
										ui={ui}
										e={e}
										working={working && ofWorking(e) ? working : undefined}
										labelled={e.id === latestAct}
									/>
								</div>
								{open && hasDetail(panel, e.detail) ? (
									<div className="lrd">
										<RowDetail panel={panel} detail={e.detail} />
									</div>
								) : null}
								{edHere && edMod ? (
									<div className="lred">
										{edHere.kind === "redo" ? (
											<RedoPanel panel={panel} ui={ui} mod={edMod} />
										) : (
											<Editor panel={panel} ui={ui} mod={edMod} />
										)}
									</div>
								) : null}
							</li>
						);
					})
				) : (
					<li className="lempty">
						<Glyph status="pending" size={16} />
						<span>No matching events</span>
					</li>
				)}
			</ol>
		</section>
	);
}

/** The module chips: All, pre, the plan's modules, then dropped modules that still have rows. */
function moduleChips(panel: Panel): string[] {
	const ids: string[] = [...panel.ids];
	for (const e of panel.events) {
		if (e.mod !== PRE && panel.byId[e.mod] && !ids.includes(e.mod)) ids.push(e.mod);
	}
	return ["all", PRE, ...ids];
}

/** `.lrb`: time, module tag, icon or glyph, one-line text, badges (diff bar, pips, failed, flag). */
function RowButton({ e, open, ui }: { e: LogEvent; open: boolean; ui: Ui }) {
	const a = e.act;
	return (
		<button
			type="button"
			className="lrb"
			data-k={`lr-${e.id}`}
			aria-expanded={open}
			data-tip={e.flag ? e.flags.map((f) => f.text).join(" · ") : undefined}
			onClick={() => ui.toggleRow(e.id)}
		>
			<span className="tm">{e.t}</span>
			<span className="tag">{e.mod}</span>
			{e.glyph ? <Glyph status={e.glyph} size={16} /> : <Icon name={e.icon ?? "list"} className="ic" />}
			<span className="sm2">
				{e.text}
				{a?.exit ? <span className="sr-only">, failed</span> : null}
				{e.flag ? <span className="sr-only">, flagged</span> : null}
			</span>
			<span className="bdg">
				{a && (a.type === "write" || a.type === "edit") ? <DiffBar add={a.add} del={a.del} /> : null}
				{a?.type === "test" ? <Pips pass={a.pass} fail={a.fail} live={a.live} /> : null}
				{a?.exit ? <Icon name="x" size={14} /> : null}
				{/* the flag icon is decoration; the row's own tooltip and hidden text carry the meaning */}
				{e.flag ? (
					<span className="lflag" aria-hidden="true">
						<Icon name="flag" size={14} />
					</span>
				) : null}
			</span>
		</button>
	);
}

interface RowActionsProps extends PanelProps {
	e: LogEvent;
	/** The module you can correct, when this row belongs to its current attempt. */
	working?: ModView;
	/** This is the newest shown row of that module: the Correct button carries its label. */
	labelled: boolean;
}

/** `.lra`: the same interventions as the Modules view, on the rows where they naturally belong. */
function RowActions({ panel, ui, e, working, labelled }: RowActionsProps) {
	const ed = ui.s.editor;
	const expanded = (kind: EditorKind, id: ModuleId, row: string) => {
		const on = !!ed && ed.kind === kind && ed.id === id && ed.row === row;
		return {
			"aria-expanded": on,
			"aria-controls": on ? (kind === "redo" ? "redoPanel" : "edPanel") : undefined,
		};
	};
	const open = (kind: EditorKind, id: ModuleId, row: string, k: string) => () =>
		ui.openEditor(kind, id, { row, opener: k });
	const buttons: ReactNode[] = [];

	// Change Mk… on the latest plan row, for every module that has not started (while the agent is live)
	if (e.kind === "plan" && e.current) {
		for (const m of panel.modules) {
			if (!m.canChange) continue;
			const k = `la-${e.id}-${m.id}`;
			buttons.push(
				<button
					type="button"
					key={k}
					className="btn sm"
					data-k={k}
					{...expanded("change", m.id, e.id)}
					onClick={open("change", m.id, e.id, k)}
				>
					<Icon name="edit" size={14} />
					Change {m.id}…
				</button>,
			);
		}
	}

	// Correct on every row of the running attempt: labelled on its newest row, icon-only elsewhere
	if (working) {
		const k = `la-${e.id}`;
		const props = {
			"data-k": k,
			...expanded("correct", working.id, e.id),
			onClick: open("correct", working.id, e.id, k),
		};
		buttons.push(
			labelled ? (
				<button type="button" key="correct" className="btn sm" {...props}>
					<Icon name="note" size={14} />
					Correct {working.id}…
				</button>
			) : (
				<button
					type="button"
					key="correct"
					className="ib sm"
					aria-label={`Correct ${working.id}…`}
					data-tip={`Correct ${working.id}`}
					{...props}
				>
					<Icon name="note" size={16} />
				</button>
			),
		);
	}

	// Redo from Mk… on the start and finish rows of the attempt it would rewind (anchored to its start row)
	const target =
		(e.kind === "start" || e.kind === "finish") && e.current && e.moduleId ? panel.byId[e.moduleId] : undefined;
	if (target && target.primary === "redo") {
		const k = `la-${e.id}`;
		const row = defaultRow(panel, "redo", target.id);
		buttons.push(
			<button
				type="button"
				key="redo"
				className="btn sm dghost"
				data-k={k}
				{...expanded("redo", target.id, row)}
				onClick={open("redo", target.id, row, k)}
			>
				<Icon name="undo" size={14} />
				Redo from {target.id}…<span className="sr-only">, {e.kind} row</span>
			</button>,
		);
	}

	return <div className="lra">{buttons}</div>;
}

/** Whether a row has anything to expand into (rows without details still toggle, as in the mockup). */
function hasDetail(panel: Panel, d: LogDetail): boolean {
	switch (d.kind) {
		case "none":
			return false;
		case "finish":
			return d.criteria.length > 0;
		case "versions":
			return !!panel.byId[d.moduleId];
		case "flags":
			return d.flags.length > 0;
		case "plan":
			return d.modules.length > 0;
		default:
			return true;
	}
}

/** `.lrd` content: the mockup's logDetail(), from the row's own event data. */
function RowDetail({ panel, detail: d }: { panel: Panel; detail: LogDetail }) {
	switch (d.kind) {
		case "act":
			return <StepDetail act={d.act} />;
		case "versions": {
			const m = panel.byId[d.moduleId];
			return m ? <VersionList mod={m} /> : null;
		}
		case "plan":
			return <PlanDetail modules={d.modules} rationale={d.rationale} />;
		case "start":
			// the instructions this attempt started with
			return (
				<TextDetail
					icon={d.version.by === "you" ? "user" : "bot"}
					head={`instructions v${d.version.v} · by ${d.version.by}`}
					text={d.version.text}
				/>
			);
		case "finish": {
			const m = panel.byId[d.moduleId];
			return <CriteriaList criteria={d.criteria} tests={m?.attemptId === d.attemptId ? m.tests : undefined} />;
		}
		case "flags":
			return (
				<>
					{d.flags.map((f) => (
						<div key={f.id} className="flagbar" role="note">
							<Icon name="flag" size={16} />
							<span>{f.text}</span>
						</div>
					))}
				</>
			);
		case "text":
			return <TextDetail icon={d.icon} glyph={d.glyph} head={d.head} text={d.text} />;
		default:
			return null;
	}
}

/**
 * The plan as proposed (the agent's reason, then id, title, deps, goal, done-when, instructions of that
 * version): the same plan text as the Modules view's overview, with no live status, which would be a
 * treatment-only overview.
 */
function PlanDetail({ modules, rationale }: { modules: PlanItem[]; rationale?: string }) {
	return (
		<>
			{rationale ? <TextDetail icon="say" head="agent’s reason" text={rationale} /> : null}
			<ol className="plan">
				{modules.map((m) => (
					<li key={m.id}>
						<div className="ph">
							<i className="pb" aria-hidden="true" />
							<span className="cid" style={{ fontSize: 12 }}>
								{m.id}
							</span>
							<span>{m.title}</span>
							{m.deps.length ? (
								<span className="pill" style={{ height: 22 }} {...tipImg(`Depends on ${joinAnd(m.deps)}`)}>
									<Icon name="link" size={12} />
									<span className="mono">{m.deps.join(" ")}</span>
								</span>
							) : null}
						</div>
						<div className="pg">
							<span>
								<Icon name="target" size={12} />
								{m.goal}
							</span>
							{m.criteria.map((c, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: criteria are positional and may repeat
								<span key={i}>
									<i className="pb" aria-hidden="true" />
									Done when: {c}
								</span>
							))}
						</div>
						<div className="pi">{m.text}</div>
					</li>
				))}
			</ol>
		</>
	);
}

/** Whether the page is scrolled to its end. */
function atPageEnd(): boolean {
	const root = document.documentElement;
	return window.scrollY + window.innerHeight >= root.scrollHeight - 8;
}

/**
 * The log opens at its newest row while the agent is live (once the server confirms it holds the
 * agent; a run that had ended when it loaded opens at the top), then follows new rows as long as you
 * stay at the end. Never while an editor is open: it would scroll away from what you type.
 */
function useTail(panel: Panel, editing: boolean): void {
	const atEnd = useRef(true);
	const seen = useRef(0);
	const opened = useRef(false);
	useEffect(() => {
		const onScroll = () => {
			atEnd.current = atPageEnd();
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);
	useLayoutEffect(() => {
		const rows = panel.events.length;
		const grew = rows > seen.current;
		seen.current = rows;
		let tail = false;
		if (!opened.current) {
			// the trace says the run is going on (isLive), but the control state may not have arrived yet
			const going = panel.status === "running" || panel.status === "paused";
			if (panel.live) {
				tail = true;
				opened.current = true;
			} else if (rows > 0 && !going) opened.current = true;
		} else tail = grew && atEnd.current && panel.live;
		if (tail && !editing) window.scrollTo(0, document.documentElement.scrollHeight);
		atEnd.current = atPageEnd();
	});
}
