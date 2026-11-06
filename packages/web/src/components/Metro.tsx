/**
 * Level 1, Modules view: the Metro line (the mockup's renderMetro()/stationHTML()/drawMetro()).
 * The before-plan station and one station per plan module in plan order (status glyph, short
 * label, one evidence graphic: the latest tests as pips), the line and dependency arcs in an SVG
 * measured from the stations, and the markers that sit on the line. Markers live in DOM order
 * between the stations (so Tab follows the line): the train docked before the working station, the
 * held diamond at the decision's slot, the one pause boundary at `now.slot`, and while a redo panel
 * is open the cut before the redo target (whose affected stations show `replaced`). A finished run
 * closes the line with the end bar.
 *
 * Between modules (the agent left one and has not started the next) the train waits in the gap
 * before the next module (Panel.between, the same gap as the next pause). Changes move instead of
 * jumping (ui/motion.ts): the train glides to its new place, turns into the held diamond at a hold and
 * back again on Continue (or rolls back on a redo), and fades out at the end; a segment the agent has
 * just travelled draws itself in; a station whose status changes pops its glyph and sends out a ring;
 * a new plan's stations arrive one after another. None of this changes a measured box.
 */

import type { ModuleId } from "@vcm/protocol";
import {
	type CSSProperties,
	Fragment,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
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
import { EASE, EASE_TRAIN, play, reducedMotion } from "../ui/motion.ts";
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
/** Half widths of the held diamond, the pause boundary button and the train, px (styles.css `.mk.held`, `.bnd`, `.train`). */
const HELD_HALF = 14;
const BND_HALF = 15;
const TRAIN_HALF = 17;
/** Where the pause boundary rides when the gap is too narrow for both markers: above the track, px. */
const BND_RAISE = -32;
/** A train gone for longer than this arrives in place (fades in) instead of gliding from where it was, ms. */
const TRAIN_STALE = 4000;
/** The train and the held diamond turn into each other when one goes and the other comes within this, ms. */
const MORPH = 1500;

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
	const train = stations.querySelector<HTMLElement>(".mk.train:not(.ghost) > i");
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
 * The line's segments into each station: adjacent stations without a declared dependency still share
 * the line (listed first, never highlighted), then the dependency edges. `key` is the segment's React
 * key and `data-seg`.
 */
function segments(panel: Panel): { a: ModuleId; b: ModuleId; edge: boolean; key: string }[] {
	const ids = panel.ids;
	const out: { a: ModuleId; b: ModuleId; edge: boolean; key: string }[] = [];
	const seen = new Set<string>();
	const add = (a: ModuleId, b: ModuleId, edge: boolean) => {
		const key = `${edge ? "e" : "s"}:${a}:${b}`;
		if (ids.includes(a) && ids.includes(b) && !seen.has(key)) {
			seen.add(key);
			out.push({ a, b, edge, key });
		}
	};
	for (let i = 0; i + 1 < ids.length; i++) {
		const a = ids[i] as ModuleId;
		const b = ids[i + 1] as ModuleId;
		if (!panel.edges.some(([ea, eb]) => ea === a && eb === b)) add(a, b, false);
	}
	for (const [a, b] of panel.edges) add(a, b, true);
	return out;
}

/** The segments the agent has travelled (by the model, not the redo preview), plus the tail and end bar once the run completed. */
function travelled(panel: Panel): Set<string> {
	const out = new Set(segments(panel).flatMap((s) => (lineClass(panel, s.b) === "done" ? [s.key] : [])));
	const first = panel.ids[0];
	if (first && lineClass(panel, first) === "done") out.add("pre");
	if (panel.status === "completed" && panel.ids.length) out.add("tail").add("term");
	return out;
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
	/* the lead-in from the before-plan station is travelled once the first module has started */
	const pre = first && lineClass(panel, first) === "done" ? "done" : "pre";
	const out: ReactNode[] = [
		<line
			key="pre"
			data-seg="pre"
			className={`ln ${pre}`}
			x1={xOf(PRE)}
			y1={y}
			x2={first ? xOf(first) : endX}
			y2={y}
		/>,
	];
	if (last) {
		const cls = `ln ${panel.status === "completed" ? "done" : "future"}${redo ? " gone" : ""}`;
		out.push(<line key="tail" data-seg="tail" className={cls} x1={xOf(last)} y1={y} x2={endX} y2={y} />);
	}
	for (const { a, b, edge, key } of segments(panel)) {
		const ia = ids.indexOf(a);
		const ib = ids.indexOf(b);
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
				out.push(
					<path key={`${key}:kept`} data-seg={`${key}:kept`} className="ln done" d={`M${x1} ${y} L${mx} ${y}`} />,
				);
				d = `M${mx} ${y} L${x2} ${y}`;
			}
			cls = "gone";
		}
		out.push(<path key={key} data-seg={key} className={`ln ${cls}${hl ? " hl" : ""}${dim ? " dimln" : ""}`} d={d} />);
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
		out.push(<line key="term" data-seg="term" className="ln term" x1={endX} y1={y - 9} x2={endX} y2={y + 9} />);
	}
	return out;
}

// ---- stations -------------------------------------------------------------------------------

interface StationProps {
	m: ModView;
	/** Position on the line (the arrival stagger). */
	i: number;
	/** Shown status (`replaced` while a redo panel would replace it). */
	status: StationStatus;
	current: boolean;
	/** `""`, `" rel"` or `" dim"`. */
	related: string;
	onSelect: (id: SelId) => void;
}

/** One station button (the mockup's stationHTML): click selects, a second click opens the evidence. */
function Station({ m, i, status, current, related, onSelect }: StationProps) {
	const dotRef = useRef<HTMLSpanElement>(null);
	const real = m.status;
	const lastStatus = useRef(real);
	/* a real status change (not the redo preview's `replaced`) pops the glyph and sends a ring out of the
	   dot in the new status's colour; the dot's own box never moves */
	useLayoutEffect(() => {
		if (lastStatus.current === real) return;
		lastStatus.current = real;
		const dot = dotRef.current;
		play(
			dot?.querySelector(".g"),
			[
				{ scale: 0.35, opacity: 0.2 },
				{ scale: 1.2, opacity: 1, offset: 0.6 },
				{ scale: 1, opacity: 1 },
			],
			{ duration: 620, easing: EASE },
		);
		play(
			dot,
			[
				{ opacity: 0.95, scale: 0.85 },
				{ opacity: 0, scale: 2.2 },
			],
			{
				duration: 1000,
				easing: EASE,
				pseudoElement: "::before",
			},
		);
	}, [real]);
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
			style={{ "--i": i } as CSSProperties}
			onClick={() => onSelect(m.id)}
		>
			<span className="st-dot" data-s={real} ref={dotRef}>
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

// ---- motion ---------------------------------------------------------------------------------

/** Where a marker (the train, the held diamond) was last drawn: its element and place (centre in the stations grid), its running glide, and since when it is gone. */
interface Sighting {
	at: string;
	x: number;
	y: number;
	el: HTMLElement;
	glide?: { anim: Animation; dx: number; dy: number };
	gone?: number;
}

/** Where a sighted marker is on screen now: its place, less what is left of its glide. */
function onScreen(s: Sighting): { x: number; y: number } {
	const g = s.glide;
	if (g?.anim.playState !== "running") return { x: s.x, y: s.y };
	const p = g.anim.effect?.getComputedTiming().progress ?? 1; // eased progress
	return { x: s.x + g.dx * (1 - p), y: s.y + g.dy * (1 - p) };
}

/** A marker's sighting from its left/top (its centre), or null if it is not placed yet. */
function sight(el: HTMLElement): Sighting | null {
	const x = Number.parseFloat(el.style.left);
	const y = Number.parseFloat(el.style.top);
	return Number.isFinite(x) && Number.isFinite(y) ? { at: el.dataset.at ?? "", x, y, el } : null;
}

/** Glides `s` in from `from` (a marker is a new element whenever it changes place, so this is FLIP). */
function glideFrom(s: Sighting, from: { x: number; y: number }, fade = false): void {
	const dx = from.x - s.x;
	const dy = from.y - s.y;
	if (Math.hypot(dx, dy) < 1) return;
	const anim = play(
		s.el,
		[
			/* the diamond starts as big as the train it turns from (overriding its CSS pop-in) */
			{
				translate: `${dx}px ${dy}px`,
				...(fade ? { opacity: 0.6, transform: "translate(-50%, -50%) scale(0.85)" } : {}),
			},
			{ translate: "0 0", ...(fade ? { opacity: 1, transform: "translate(-50%, -50%) scale(1)" } : {}) },
		],
		{ duration: Math.min(1500, 600 + Math.hypot(dx, dy) * 1.4), easing: EASE_TRAIN },
	);
	if (anim) s.glide = { anim, dx, dy };
}

/** A marker that just left fades out where it was, as a copy (React has already removed it). */
function ghost(grid: HTMLElement, s: Sighting): void {
	if (reducedMotion()) return;
	const copy = s.el.cloneNode(true) as HTMLElement;
	for (const a of ["data-at", "data-k", "data-tip", "tabindex", "role", "aria-label", "aria-pressed"])
		copy.removeAttribute(a);
	copy.setAttribute("aria-hidden", "true");
	copy.classList.add("ghost");
	const p = onScreen(s);
	copy.style.left = `${p.x}px`;
	copy.style.top = `${p.y}px`;
	grid.appendChild(copy);
	const anim = play(
		copy,
		[
			{ opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
			{ opacity: 0, transform: "translate(-50%, -50%) scale(0.5)" },
		],
		{ duration: 460, easing: EASE },
	);
	if (!anim) copy.remove();
	else {
		anim.onfinish = () => copy.remove();
		anim.oncancel = () => copy.remove();
	}
}

/**
 * The train and the held diamond, after each render (positions are read only once the stations are
 * measured). The train glides to every new place from where it is on screen, so a move that cuts a glide
 * short continues from where it really was. At a hold the train turns into the diamond (the diamond
 * glides in from the train); on Continue or a redo the diamond turns back into the train (which glides
 * from the diamond, back along the line for a redo). A train back after being gone a while, or back in
 * the same place, fades in; a marker that leaves without turning into the other fades out.
 */
function useMarkerMotion(stationsRef: RefObject<HTMLDivElement | null>, measured: boolean) {
	const train = useRef<Sighting | null>(null);
	const held = useRef<Sighting | null>(null);
	useLayoutEffect(() => {
		const grid = stationsRef.current;
		if (!grid || !measured) return;
		const now = performance.now();
		const tEl = grid.querySelector<HTMLElement>(".mk.train:not(.ghost)");
		const hEl = grid.querySelector<HTMLElement>(".mk.held:not(.ghost)");
		const pt = train.current;
		const ph = held.current;
		const recent = (s: Sighting | null) => s?.gone !== undefined && now - s.gone < MORPH;
		const trainLeft = !!pt && pt.gone === undefined && !tEl;
		const heldLeft = !!ph && ph.gone === undefined && !hEl;
		if (pt && trainLeft) pt.gone = now;
		if (ph && heldLeft) ph.gone = now;

		const t = tEl ? sight(tEl) : null;
		if (t) {
			train.current = t;
			if (pt?.gone !== undefined) {
				if (ph && (heldLeft || recent(ph)))
					glideFrom(t, onScreen(ph)); // the diamond turns back into the train
				else if (pt.at === t.at || now - pt.gone > TRAIN_STALE)
					play(
						t.el,
						[
							{ opacity: 0, transform: "translate(-50%, -50%) scale(0.6)" },
							{ opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
						],
						{ duration: 520, easing: EASE },
					);
				else glideFrom(t, onScreen(pt));
			} else if (pt) {
				const from = onScreen(pt);
				const gliding = pt.glide?.anim.playState === "running";
				if (pt.at === t.at && pt.x === t.x && pt.y === t.y)
					t.glide = pt.glide; // same place: its glide runs on
				else if (pt.at !== t.at || gliding) {
					/* a new place, or the same one re-measured mid-glide; re-measured at rest (resize) it just moves */
					pt.glide?.anim.cancel();
					glideFrom(t, from);
				}
			}
		}

		const h = hEl ? sight(hEl) : null;
		if (h) {
			held.current = h;
			const fresh = !ph || ph.gone !== undefined || ph.at !== h.at;
			if (!fresh && ph) h.glide = ph.glide;
			else if (pt && (trainLeft || recent(pt))) glideFrom(h, onScreen(pt), true); // the train turns into the diamond
		}

		if (pt && trainLeft && !hEl) ghost(grid, pt);
		if (ph && heldLeft && !tEl) ghost(grid, ph);
	});
}

/**
 * A segment the agent has just travelled (by the model) draws itself from its start, and the end bar
 * rises once the run completes. The first drawing (load, a view switch) shows as it is. While a redo
 * panel is open nothing changes (its preview greys segments out without anyone travelling), and a
 * segment that stops being travelled (the redo ran, a replay stepped back) drops a draw still running.
 */
function useTrackDraw(svgRef: RefObject<SVGSVGElement | null>, measured: boolean, frozen: boolean, now: Set<string>) {
	const done = useRef<Set<string> | null>(null);
	const draws = useRef(new Map<string, Animation>());
	useLayoutEffect(() => {
		const svg = svgRef.current;
		if (!svg || !measured || frozen) return;
		const prev = done.current;
		done.current = now;
		for (const [seg, anim] of draws.current) {
			if (now.has(seg) && anim.playState === "running") continue;
			if (!now.has(seg)) anim.cancel();
			draws.current.delete(seg);
		}
		if (!prev) return;
		for (const seg of now) {
			if (prev.has(seg)) continue;
			const el = svg.querySelector<SVGGeometryElement>(`[data-seg="${seg}"]`);
			if (!el) continue;
			let anim: Animation | undefined;
			if (seg === "term") {
				anim = play(
					el,
					[
						{ opacity: 0, scale: "1 0" },
						{ opacity: 1, scale: "1 1" },
					],
					{ duration: 520, delay: 650, easing: EASE, fill: "backwards" },
				);
			} else {
				const len = el.getTotalLength();
				if (!(len > 0)) continue;
				/* the dotted future stays underneath until the light has passed (a copy, removed after) */
				const under = el.cloneNode() as SVGGeometryElement;
				under.removeAttribute("data-seg");
				under.setAttribute("class", "ln future draw-under");
				el.before(under);
				anim = play(
					el,
					[
						{ strokeDasharray: `${len} ${len}`, strokeDashoffset: `${len}` },
						{ strokeDasharray: `${len} ${len}`, strokeDashoffset: "0" },
					],
					{ duration: Math.min(1300, 450 + len * 1.6), easing: EASE_TRAIN },
				);
				if (!anim) under.remove();
				else {
					anim.addEventListener("finish", () => under.remove());
					anim.addEventListener("cancel", () => under.remove());
				}
			}
			if (anim) draws.current.set(seg, anim);
		}
	});
}

// ---- the line -------------------------------------------------------------------------------

/** `<section class="metro" id="metro">` with `#stations` (stations carry `data-k="st-<id>"`). */
export function Metro({ panel, ui }: MetroProps) {
	const ids = panel.ids;
	const cols = ids.length || EMPTY_COLS;
	const { metroRef, stationsRef, geo } = useGeometry(cols);
	const svgRef = useRef<SVGSVGElement>(null);
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
	/* between modules the train waits in the gap the model names (the same gap as the next pause), so a
	   module change reads as one journey instead of a vanishing train */
	const between = !k && !decision ? panel.between : undefined;
	const ahead = between?.next;
	const parkAt: SelId | null = between ? stationAt(between.after) : null;

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
		/* held here (or the train waits here between modules), and the pause after Continue is in the same
		   gap (held after M3, pause before M4): side by side when the gap between the two rings has room for
		   both, else the pause rides above the track (the held diamond, the one interrupting signal, never
		   moves onto a ring or under the button) */
		const shared = ((!!decision && heldAt === id) || parkAt === id) && !!slot && slotAt === id;
		const next = stationIds[stationIds.indexOf(id) + 1];
		const ring = (sid: SelId | undefined) => (sid ? (g?.r[sid] ?? 18) : 0);
		const half = g ? (next ? (xOf(next) - ring(next) - xOf(id) - ring(id)) / 2 : endX - xOf(id) - ring(id)) : 0;
		const fits = half >= SHARED_GAP + Math.max(parkAt === id ? TRAIN_HALF : HELD_HALF, BND_HALF) + 2;
		const shift = shared && fits ? SHARED_GAP : 0;
		const raise = shared && !fits ? BND_RAISE : 0;
		if (parkAt === id) {
			out.push(
				<span
					key="park"
					className="mk train"
					data-at={`park:${id}`}
					{...tipImg(ahead ? `Agent is between modules, ${ahead} next` : "Agent is finishing the run")}
					style={pos(slotX(id) - shift)}
				>
					<i />
				</span>,
			);
		}
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

	useMarkerMotion(stationsRef, !!g);
	useTrackDraw(svgRef, !!g, !!k, travelled(panel));

	const label = ids.length
		? `Plan: before plan and ${plural(ids.length, "module")}. Use j and k to move.`
		: "Plan: before plan, no modules yet";

	return (
		<section className={panel.live ? "metro live" : "metro"} id="metro" aria-label="Plan" ref={metroRef}>
			<svg
				ref={svgRef}
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
								i={stationIds.indexOf(id)}
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
