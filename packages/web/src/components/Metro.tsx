/**
 * Level 1, Modules view: the Metro line (the mockup's renderMetro()/stationHTML()/drawMetro()).
 * The before-plan station and one station per plan module in plan order (status glyph, short
 * label, one evidence graphic: the latest tests as pips), the line and dependency arcs in an SVG
 * measured from the stations, and the markers that sit on the line. Markers live in DOM order
 * between the stations (so Tab follows the line): the train docked before the working station, the
 * held diamond at the decision's slot, the one pause boundary at `now.slot`, and while a redo panel
 * is open the cut before the redo target (whose affected stations show `replaced`). A finished run
 * closes the line with the end bar.
 */

import type { ModuleId } from "@vcm/protocol";
import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { plural } from "../model/format.ts";
import {
	type ModView,
	type Panel,
	PRE,
	type SelId,
	type StationStatus,
	shownLabel,
	shownStatus,
	slotLabel,
} from "../model/panel.ts";
import { type PanelProps, redoTarget } from "../state/ui.ts";
import { Icon } from "../ui/icons.tsx";
import { Glyph, Octagon, Pips, Strip, tipImg } from "../ui/primitives.tsx";

/** Props of Metro: the shared PanelProps. */
export type MetroProps = PanelProps;

/** The before-plan column's width against one module column (the mockup's `.62fr`). */
const PRE_COL = 0.62;
/** Module columns before there is a plan, so the before-plan station sits where it will with a typical plan. */
const EMPTY_COLS = 4;
/** Height of a dependency arc above the line, px. */
const ARC = 38;
/** Offset of the held diamond (left) and the pause boundary (right) when both sit in one gap, px. */
const SHARED_GAP = 15;
/** Half widths of the held diamond and the pause boundary button, px (styles.css `.mk.held`, `.bnd`). */
const HELD_HALF = 14;
const BND_HALF = 15;
/** Where the pause boundary rides when the gap is too narrow for both markers: above the track, px. */
const BND_RAISE = -32;

// ---- measuring (drawMetro's first half) -----------------------------------------------------

/** What drawMetro() reads from the DOM: dot centres relative to the metro section. */
interface Geometry {
	/** Section size (the SVG's viewBox). */
	w: number;
	h: number;
	/** The line's height (every dot's centre). */
	y: number;
	/** Dot centre x and ring radius by station id. */
	x: Record<SelId, number>;
	r: Record<SelId, number>;
	/** Distance between adjacent module stations. */
	gap: number;
	/** The stations grid's offset in the section (markers are positioned inside the grid). */
	ox: number;
	oy: number;
	/** Width of the train capsule (narrower on small screens). */
	trainW: number;
}

function measure(metro: HTMLElement, stations: HTMLElement, cols: number): Geometry | null {
	const mr = metro.getBoundingClientRect();
	const sr = stations.getBoundingClientRect();
	const x: Record<SelId, number> = {};
	const r: Record<SelId, number> = {};
	const order: SelId[] = [];
	let y: number | undefined;
	for (const b of stations.querySelectorAll<HTMLElement>(".st")) {
		const id = b.dataset.id;
		const dot = b.querySelector(".st-dot");
		if (!id || !dot) continue;
		const d = dot.getBoundingClientRect();
		x[id] = d.left - mr.left + d.width / 2;
		r[id] = d.width / 2;
		y ??= d.top - mr.top + d.height / 2;
		order.push(id);
	}
	if (y === undefined) return null;
	const [, m1, m2] = order;
	const gap = m1 && m2 ? (x[m2] ?? 0) - (x[m1] ?? 0) : sr.width / (PRE_COL + cols);
	const train = stations.querySelector<HTMLElement>(".train > i");
	return {
		w: mr.width,
		h: mr.height,
		y,
		x,
		r,
		gap,
		ox: sr.left - mr.left,
		oy: sr.top - mr.top,
		trainW: train?.offsetWidth ?? 28,
	};
}

/**
 * Measures the stations after every render (any panel or UI change can add, drop or move one), when
 * the section resizes and once the web fonts are in. Re-renders only when something moved.
 */
function useGeometry(cols: number) {
	const metroRef = useRef<HTMLElement>(null);
	const stationsRef = useRef<HTMLDivElement>(null);
	const [geo, setGeo] = useState<Geometry | null>(null);
	const lastKey = useRef("null");
	const remeasure = useCallback(() => {
		const metro = metroRef.current;
		const stations = stationsRef.current;
		if (!metro || !stations) return;
		const next = measure(metro, stations, cols);
		const key = JSON.stringify(next);
		if (key === lastKey.current) return;
		lastKey.current = key;
		setGeo(next);
	}, [cols]);
	useLayoutEffect(() => {
		remeasure();
	});
	useEffect(() => {
		const metro = metroRef.current;
		let frame = 0;
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(remeasure);
		};
		const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : undefined;
		if (metro) observer?.observe(metro);
		if (!observer) window.addEventListener("resize", schedule);
		let alive = true;
		document.fonts?.ready.then(() => {
			if (alive) remeasure();
		});
		return () => {
			alive = false;
			cancelAnimationFrame(frame);
			observer?.disconnect();
			window.removeEventListener("resize", schedule);
		};
	}, [remeasure]);
	return { metroRef, stationsRef, geo };
}

// ---- drawing (drawMetro's second half) ------------------------------------------------------

/** The selection and its direct prerequisites and dependents (null: nothing selected, or pre). */
function relSet(panel: Panel, sel: SelId | null): Set<SelId> | null {
	if (!sel || sel === PRE || !panel.ids.includes(sel)) return null;
	const rel = new Set<SelId>([sel]);
	for (const [a, b] of panel.edges) {
		if (a === sel) rel.add(b);
		if (b === sel) rel.add(a);
	}
	return rel;
}

/** A segment of the line into `b` is travelled once `b` has started (pending and replaced are still ahead). */
function lineClass(panel: Panel, b: ModuleId): "done" | "future" {
	const st = panel.byId[b]?.status;
	return st === "pending" || st === "replaced" ? "future" : "done";
}

interface TrackArgs {
	panel: Panel;
	g: Geometry;
	rel: Set<SelId> | null;
	sel: SelId | null;
	/** Redo target that is a station (the cut is drawn before it). */
	cut: ModuleId | null;
	/** Any redo panel is open (the line after the cut is `gone`, no end bar). */
	redo: boolean;
	endX: number;
}

/**
 * The SVG paths: the dotted before-plan lead-in, the line between adjacent stations, the dependency
 * arcs (adjacent = a straight segment, otherwise a curve above), the tail to the end, and the end bar.
 */
function track({ panel, g, rel, sel, cut, redo, endX }: TrackArgs): ReactNode[] {
	const ids = panel.ids;
	const y = g.y;
	const xOf = (id: SelId) => g.x[id] ?? 0;
	const ki = cut ? ids.indexOf(cut) : Number.POSITIVE_INFINITY;
	const first = ids[0];
	const last = ids.at(-1);
	const out: ReactNode[] = [
		<line key="pre" className="ln pre" x1={xOf(PRE)} y1={y} x2={first ? xOf(first) : endX} y2={y} />,
	];
	if (last) {
		const cls = `ln ${panel.status === "completed" ? "done" : "future"}${redo ? " gone" : ""}`;
		out.push(<line key="tail" className={cls} x1={xOf(last)} y1={y} x2={endX} y2={y} />);
	}
	// adjacent stations without a declared dependency still share the line (drawn first, never highlighted)
	const segs: [ModuleId, ModuleId, boolean][] = [];
	for (let i = 0; i + 1 < ids.length; i++) {
		const a = ids[i] as ModuleId;
		const b = ids[i + 1] as ModuleId;
		if (!panel.edges.some(([ea, eb]) => ea === a && eb === b)) segs.push([a, b, false]);
	}
	for (const [a, b] of panel.edges) segs.push([a, b, true]);
	const seen = new Set<string>();
	for (const [a, b, edge] of segs) {
		const ia = ids.indexOf(a);
		const ib = ids.indexOf(b);
		const key = `${edge ? "e" : "s"}:${a}:${b}`;
		if (ia < 0 || ib < 0 || seen.has(key)) continue;
		seen.add(key);
		const adj = ib - ia === 1;
		const x1 = xOf(a);
		const x2 = xOf(b);
		let cls: string = lineClass(panel, b);
		/* highlighted = both ends in the selection's related set; arrowheads only on the selection's own edges */
		const hl = edge && !!rel && rel.has(a) && rel.has(b);
		const own = edge && !!sel && (a === sel || b === sel);
		const dim = !!rel && !hl;
		let d: string;
		let ax: number;
		let ay: number;
		if (adj) {
			d = `M${x1} ${y} L${x2} ${y}`;
			ax = x1 + (x2 - x1) * 0.3;
			ay = y;
		} else {
			const dx = x2 - x1;
			d = `M${x1} ${y} C${x1 + dx * 0.18} ${y - ARC} ${x2 - dx * 0.18} ${y - ARC} ${x2} ${y}`;
			ax = (x1 + x2) / 2;
			ay = y - ARC * 0.75;
		}
		if (ib >= ki) {
			if (adj && ia === ki - 1) {
				const mx = (x1 + x2) / 2;
				out.push(<path key={`${key}:kept`} className="ln done" d={`M${x1} ${y} L${mx} ${y}`} />);
				d = `M${mx} ${y} L${x2} ${y}`;
			}
			cls = "gone";
		}
		out.push(<path key={key} className={`ln ${cls}${hl ? " hl" : ""}${dim ? " dimln" : ""}`} d={d} />);
		if (own && hl) {
			const s = x2 >= x1 ? 1 : -1;
			out.push(
				<path
					key={`${key}:arw`}
					className="arw"
					d={`M${ax - 3.5 * s} ${ay - 4.5} L${ax + 2.5 * s} ${ay} L${ax - 3.5 * s} ${ay + 4.5}`}
				/>,
			);
		}
	}
	if (panel.status === "completed" && !redo) {
		out.push(<line key="term" className="ln term" x1={endX} y1={y - 9} x2={endX} y2={y + 9} />);
	}
	return out;
}

// ---- stations -------------------------------------------------------------------------------

interface StationProps {
	m: ModView;
	/** Shown status (`replaced` while a redo panel would replace it). */
	status: StationStatus;
	current: boolean;
	/** `""`, `" rel"` or `" dim"`. */
	related: string;
	onSelect: (id: SelId) => void;
}

/** One station button (the mockup's stationHTML): click selects, a second click opens the evidence. */
function Station({ m, status, current, related, onSelect }: StationProps) {
	const flagged = m.flag ? ", flagged" : "";
	const tip =
		m.isPre || status === m.status
			? m.tip
			: `${m.id} · ${m.title} — ${shownLabel(m.status, status)}${m.desc ? ` · ${m.desc}` : ""}`;
	const aria = m.isPre ? `${m.title}${flagged}` : `${m.id} ${m.title}, ${shownLabel(m.status, status)}${flagged}`;
	/* ONE compact evidence graphic per station: the latest tests as pips; pre uses the activity
	   strip's tick vocabulary, so one legend covers both */
	let ev: ReactNode = null;
	if (m.isPre) ev = m.actions.length ? <Strip acts={m.actions} /> : null;
	else if (m.tests) ev = <Pips pass={m.tests.pass} fail={m.tests.fail} live={m.tests.live} nums={false} cap={8} />;
	return (
		<button
			type="button"
			className={`st${related}`}
			data-id={m.id}
			data-k={`st-${m.id}`}
			aria-current={current}
			aria-label={aria}
			aria-describedby={`ev-${m.id}`}
			data-tip={tip}
			onClick={() => onSelect(m.id)}
		>
			<span className="st-dot">
				<Glyph status={status} size={m.isPre ? 16 : 22} />
				{m.flag ? (
					<span className="fl" aria-hidden="true">
						<Icon name="flag" size={12} />
					</span>
				) : null}
			</span>
			<span className="st-lab">
				{m.isPre ? (
					<Icon name="eye" size={14} />
				) : (
					<>
						<span className="mono">{m.id}</span>
						<span className="nm">{m.short}</span>
					</>
				)}
			</span>
			<span className={`st-ev${status === "replaced" ? " struck" : ""}`}>{ev}</span>
			<span className="sr-only" id={`ev-${m.id}`}>
				{m.desc}
			</span>
		</button>
	);
}

// ---- the line -------------------------------------------------------------------------------

/** `<section class="metro" id="metro">` with `#stations` (stations carry `data-k="st-<id>"`). */
export function Metro({ panel, ui }: MetroProps) {
	const ids = panel.ids;
	const cols = ids.length || EMPTY_COLS;
	const { metroRef, stationsRef, geo } = useGeometry(cols);
	const sel = ui.s.sel;
	const k = redoTarget(ui.s);
	const cut = k && ids.includes(k) ? k : null;
	const rel = relSet(panel, sel);
	const stationIds: SelId[] = [PRE, ...ids];
	const lastId = stationIds.at(-1) ?? PRE;
	/* until the new stations are measured (a plan just changed), draw nothing; the layout effect re-measures before paint */
	const g = geo && stationIds.every((id) => geo.x[id] !== undefined) ? geo : null;
	const xOf = (id: SelId) => g?.x[id] ?? 0;
	const endX = g ? Math.min(xOf(lastId) + g.gap * 0.42, g.w - 14) : 0;
	/** The gap after a station: halfway to the next one, or the end of the line. */
	const slotX = (id: SelId) => {
		const next = stationIds[stationIds.indexOf(id) + 1];
		return next ? (xOf(id) + xOf(next)) / 2 : endX;
	};
	const pos = (x: number, dy = 0) => (g ? { left: x - g.ox, top: g.y + dy - g.oy } : undefined);
	/** The station a slot's `after` names (null = after the before-plan station; unknown → the line's end). */
	const stationAt = (after: ModuleId | null) => (after === null ? PRE : ids.includes(after) ? after : lastId);

	const decision = panel.now.decision;
	const heldAt = decision ? stationAt(decision.after) : null;
	const slot = panel.now.slot;
	const slotAt = slot ? stationAt(slot.after) : null;
	const armed = panel.now.armed;
	/* before the plan exists the agent works at the before-plan station */
	const preWorking = !ids.length && panel.status === "running" && !decision;

	const before = (m: ModView): ReactNode => {
		/* the train docks on the incoming side of the working station */
		if (k || !(m.status === "working" || (m.isPre && preWorking))) return null;
		const x = Math.max(xOf(m.id) - (g?.r[m.id] ?? 18) - 3 - (g?.trainW ?? 28) / 2, 17);
		return (
			<span
				className="mk train"
				data-at={`tr:${m.id}`}
				{...tipImg(m.isPre ? "Agent is working before plan" : `Agent is working in ${m.id}`)}
				style={pos(x)}
			>
				<i />
			</span>
		);
	};

	const after = (id: SelId): ReactNode => {
		const out: ReactNode[] = [];
		/* held here, and the pause after Continue is in the same gap (held after M3, pause before M4): side by
		   side when the gap between the two rings has room for both, else the pause rides above the track
		   (the held diamond, the one interrupting signal, never moves onto a ring or under the button) */
		const shared = !!decision && heldAt === id && !!slot && slotAt === id;
		const next = stationIds[stationIds.indexOf(id) + 1];
		const ring = (sid: SelId | undefined) => (sid ? (g?.r[sid] ?? 18) : 0);
		const half = g ? (next ? (xOf(next) - ring(next) - xOf(id) - ring(id)) / 2 : endX - xOf(id) - ring(id)) : 0;
		const fits = half >= SHARED_GAP + Math.max(HELD_HALF, BND_HALF) + 2;
		const shift = shared && fits ? SHARED_GAP : 0;
		const raise = shared && !fits ? BND_RAISE : 0;
		if (decision && heldAt === id) {
			out.push(
				<span
					key="held"
					className="mk held"
					data-at={`b:${id}`}
					{...tipImg(`Agent is held ${slotLabel(decision)}, waiting for you`, "Agent is held here, waiting for you")}
					style={pos(slotX(id) - shift)}
				>
					<Glyph status="waiting" size={18} />
				</span>,
			);
		}
		if (slot && slotAt === id) {
			/* exactly the boundary the shared Now-bar toggle arms (same intervention set in both views) */
			const where = slotLabel(slot);
			out.push(
				<button
					key="bnd"
					type="button"
					className={`mk ${armed ? "on" : "bnd"}`}
					data-at={`b:${id}`}
					data-k={`bnd-${id}`}
					aria-pressed={armed}
					aria-label={`Pause ${where}`}
					data-tip={armed ? `Pause armed: agent will wait ${where}. Click to remove` : `Pause ${where}`}
					style={pos(slotX(id) + shift, raise)}
					onClick={() => ui.togglePause(!armed, `bnd-${id}`)}
				>
					{armed ? (
						<Octagon size={24} solid />
					) : (
						<span className="o-on">
							<Octagon size={20} />
						</span>
					)}
				</button>,
			);
		}
		return out;
	};

	const cutMarks = (id: ModuleId): ReactNode => {
		const prev = stationIds[stationIds.indexOf(id) - 1] ?? PRE;
		const x = (xOf(prev) + xOf(id)) / 2;
		return (
			<>
				<span className="cutline" data-at={`c:${id}`} aria-hidden="true" style={pos(x)} />
				{/* the scissors ride above the track, clear of the arrowheads and the selection ring */}
				<span
					className="mk cutmk"
					data-at={`c:${id}`}
					{...tipImg(`Redo rewinds to here, before ${id}`, `Redo rewinds to here (before ${id})`)}
					style={pos(x, -40)}
				>
					<Icon name="cut" size={14} />
				</span>
			</>
		);
	};

	const label = ids.length
		? `Plan: before plan and ${plural(ids.length, "module")}. Use j and k to move.`
		: "Plan: before plan, no modules yet";

	return (
		<section className="metro" id="metro" aria-label="Plan" ref={metroRef}>
			<svg
				className="metro-svg"
				id="metroSvg"
				aria-hidden="true"
				width={g?.w}
				height={g?.h}
				viewBox={g ? `0 0 ${g.w} ${g.h}` : undefined}
			>
				{g ? track({ panel, g, rel, sel, cut, redo: !!k, endX }) : null}
			</svg>
			{/* biome-ignore lint/a11y/useSemanticElements: the mockup's role="group" (a fieldset would restyle it) */}
			<div
				className="stations"
				id="stations"
				role="group"
				aria-label={label}
				ref={stationsRef}
				style={{ gridTemplateColumns: `${PRE_COL}fr repeat(${cols}, minmax(0, 1fr))` }}
			>
				{stationIds.map((id) => {
					const m = panel.byId[id];
					if (!m) return null;
					return (
						<Fragment key={id}>
							{cut === id ? cutMarks(id) : null}
							{before(m)}
							<Station
								m={m}
								status={shownStatus(panel, k, id)}
								current={sel === id}
								related={rel ? (rel.has(id) ? " rel" : " dim") : ""}
								onSelect={ui.selectMod}
							/>
							{after(id)}
						</Fragment>
					);
				})}
			</div>
		</section>
	);
}
