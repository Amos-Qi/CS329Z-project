/**
 * Modules view, between the line and the card: the plan overview (Panel.overview), while the plan can
 * still be shaped before its work starts (the hold after the plan, and until the first module starts).
 * One calm row per module, graphics first: its status on a vertical rail like the line's, id, title
 * and purpose, then what it needs first (link + ids) and how it will be checked (a check + the number
 * of done-when criteria, which the row's tooltip names), a chip once you changed its instructions,
 * and Change Mk… — the card's own editor, sent as the same `edit` as "Change Mk first".
 *
 * The overview sits above the card instead of replacing it: a row (like its station) selects that
 * module's card, which stays the detail (instructions, criteria in full) and holds the editor, so the
 * whole plan stays in view while you change one module after another.
 *
 * It floats in with the plan, its rows drifting in one after another (styles.css), and once a module
 * starts it folds away: a copy collapses while the card below glides up (ui/motion.ts; nothing moves
 * under reduced motion or with Motion off).
 */

import { type CSSProperties, useLayoutEffect, useRef } from "react";
import type { OverviewRow } from "../model/panel.ts";
import { editorOn, type PanelProps, type Ui } from "../state/ui.ts";
import { Icon } from "../ui/icons.tsx";
import { EASE, ghostOf, play, reducedMotion } from "../ui/motion.ts";
import { Glyph } from "../ui/primitives.tsx";

/** Props of PlanOverview: the shared PanelProps. */
export type PlanOverviewProps = PanelProps;

/** `<section class="ov" id="planOv">` in a slot that keeps its place in the page while it comes and goes. */
export function PlanOverview({ panel, ui }: PlanOverviewProps) {
	const ov = panel.overview;
	const slotRef = useRef<HTMLDivElement>(null);
	const shown = useRef(!!ov);
	/** The copy that folds away, taken before React removes the overview. */
	const leaving = useRef<HTMLElement | null>(null);
	const ghost = useRef<HTMLElement | null>(null);
	/* copy the overview about to go now: rendering runs before React changes the DOM */
	if (shown.current && !ov && !leaving.current && !reducedMotion()) {
		const old = slotRef.current?.firstElementChild;
		if (old instanceof HTMLElement) leaving.current = ghostOf(old);
	}
	useLayoutEffect(() => {
		const slot = slotRef.current;
		const was = shown.current;
		shown.current = !!ov;
		if (!slot || was === !!ov) return;
		ghost.current?.remove();
		ghost.current = null;
		if (ov) {
			/* arriving after the page is up (the plan just came in): the card below glides down */
			const h = slot.offsetHeight;
			play(
				slot,
				[
					{ height: "0px", overflow: "clip" },
					{ height: `${h}px`, overflow: "clip" },
				],
				{ duration: 620, easing: EASE },
			);
			return;
		}
		const g = leaving.current;
		leaving.current = null;
		if (!g) return;
		/* (no entrance replays on the copy) */
		g.classList.add("ov-ghost");
		slot.appendChild(g);
		ghost.current = g;
		const out = play(
			g,
			[
				{ height: `${g.offsetHeight}px`, opacity: 1, overflow: "clip" },
				{ height: "0px", marginTop: "0px", opacity: 0, translate: "0 -14px", overflow: "clip" },
			],
			{ duration: 620, easing: EASE },
		);
		const done = () => {
			g.remove();
			if (ghost.current === g) ghost.current = null;
		};
		if (!out) done();
		else {
			out.onfinish = done;
			out.oncancel = done;
		}
	});
	return (
		<div className="ov-slot" ref={slotRef}>
			{ov ? (
				<section className="ov" id="planOv" aria-labelledby="ovH">
					<header className="ov-h">
						<h2 className="lab" id="ovH">
							<Icon name="plan" size={14} />
							Plan v{ov.version}
						</h2>
						{ov.rationale ? (
							// biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so its tooltip (the whole line) shows on keyboard focus
							<p className="ov-why" tabIndex={0} data-tip={ov.rationale}>
								<Icon name="say" size={14} />
								<span className="sr-only">The agent’s reason:</span>
								<span className="ov-wt">{ov.rationale}</span>
							</p>
						) : null}
					</header>
					<ol className="ov-l">
						{ov.rows.map((r, i) => (
							<Row key={r.id} r={r} i={i} ui={ui} current={ui.s.sel === r.id} />
						))}
					</ol>
				</section>
			) : null}
		</div>
	);
}

/** One module: a select button (the whole line) and, while it has not started, its Change button. */
function Row({ r, i, ui, current }: { r: OverviewRow; i: number; ui: Ui; current: boolean }) {
	const k = `ov-${r.id}`;
	const chg = `ov-chg-${r.id}`;
	const on = editorOn(ui.s, "change", r.id);
	/* the rail into a module is travelled once it has started (as on the line) */
	const ran = r.status !== "pending" && r.status !== "replaced";
	return (
		<li className={ran ? "ovr ran" : "ovr"} data-id={r.id} style={{ "--i": i } as CSSProperties}>
			<button
				type="button"
				className="ovb"
				data-k={k}
				aria-current={current}
				aria-label={r.label}
				aria-describedby={`ovd-${r.id}`}
				data-tip={r.desc || undefined}
				onClick={() => ui.selectMod(r.id, k)}
			>
				<span className="ov-node">
					<Glyph status={r.status} size={18} />
				</span>
				<span className="cid">{r.id}</span>
				<span className="ov-t">{r.title}</span>
				<span className="ov-g">{r.goal}</span>
				{/* empty facts are not drawn, but keep their column */}
				<span className="ov-f">
					{r.deps.length ? (
						<>
							<Icon name="link" size={12} />
							<span className="mono">{r.deps.join(" ")}</span>
						</>
					) : null}
				</span>
				<span className="ov-f">
					{r.checks.length ? (
						<>
							<Icon name="checkc" size={14} />
							<span className="mono">{r.checks.length}</span>
						</>
					) : null}
				</span>
				<span className="ov-f">
					{r.yours ? (
						<span className="vchip you">
							<Icon name="user" size={12} />v{r.yours}
						</span>
					) : null}
				</span>
			</button>
			{r.canChange ? (
				<button
					type="button"
					className="ib sm"
					data-k={chg}
					aria-label={`Change ${r.id} instructions`}
					data-tip={`Change ${r.id}…`}
					aria-expanded={on}
					aria-controls={on ? "edPanel" : undefined}
					onClick={() => ui.openEditor("change", r.id, { opener: chg })}
				>
					<Icon name="edit" size={16} />
				</button>
			) : (
				<span />
			)}
			<span className="sr-only" id={`ovd-${r.id}`}>
				{[r.goal.replace(/\.$/, ""), r.desc].filter(Boolean).join(". ")}
			</span>
		</li>
	);
}
