/**
 * Modules view, between the line and the card: the plan overview (Panel.overview), whenever there is a
 * plan. One calm row per module, graphics first: its status on a vertical rail like the line's, id,
 * title and purpose, then what it needs first (link + ids) and how it will be checked (a check + the
 * number of done-when criteria, which the row's tooltip names), a chip once you changed its
 * instructions, and Change Mk… while it has not started — the card's own editor, sent as the same
 * `edit` as "Change Mk first".
 *
 * It opens while the plan can still be shaped before its work starts (the hold after the plan) and
 * folds to its header line once the work goes on (Continue folds it); the toggle at its top right
 * opens it again at any time. The overview sits above the card instead of replacing it: a row (like
 * its station) selects that module's card, which stays the detail (instructions, criteria in full) and
 * holds the editor, so the whole plan stays in view while you change one module after another.
 *
 * It floats in with the plan, its rows drifting in one after another (styles.css). Opening eases the
 * box open; folding collapses a copy of the rows while the card below glides up (ui/motion.ts; nothing
 * moves under reduced motion or with Motion off).
 */

import { type CSSProperties, type RefObject, useLayoutEffect, useRef } from "react";
import type { OverviewRow } from "../model/panel.ts";
import { editorOn, overviewOpen, type PanelProps, type Ui } from "../state/ui.ts";
import { Icon } from "../ui/icons.tsx";
import { EASE, ghostOf, play, reducedMotion } from "../ui/motion.ts";
import { Glyph } from "../ui/primitives.tsx";

/** Props of PlanOverview: the shared PanelProps. */
export type PlanOverviewProps = PanelProps;

/**
 * Glides `ref`'s one child in and out, so what is below glides instead of jumping: the container's
 * height eases from what is on screen now to its new height; when the child goes, a copy of it
 * (ghostOf, taken before React removes it) fades inside the closing container. A change in the middle
 * of another (fold again while opening) carries on from the height on screen. Only while the container
 * itself stays (a container that just came or went with its parent is the parent's motion).
 */
function useComeAndGo(ref: RefObject<HTMLElement | null>, present: boolean): void {
	const shown = useRef(present);
	const host = useRef<HTMLElement | null>(null);
	/** Taken before React changes the DOM: the container's height on screen, and the copy of a child that goes. */
	const from = useRef(0);
	const leaving = useRef<HTMLElement | null>(null);
	const ghost = useRef<HTMLElement | null>(null);
	const glide = useRef<Animation | undefined>(undefined);
	if (shown.current !== present && !reducedMotion()) {
		const box = ref.current;
		from.current = box?.getBoundingClientRect().height ?? 0;
		const old = present ? null : box?.querySelector(":scope > :not(.ov-ghost)");
		if (old && !leaving.current) {
			const copy = ghostOf(old);
			/* a fold still running inside it has already gone: the copy shows the box as it ends up */
			for (const nested of copy.querySelectorAll(".ov-ghost")) nested.remove();
			leaving.current = copy;
		}
	}
	useLayoutEffect(() => {
		const box = ref.current;
		const was = shown.current;
		const same = !!box && box === host.current;
		shown.current = present;
		host.current = box;
		const g = leaving.current;
		leaving.current = null;
		if (was === present) return;
		glide.current?.cancel();
		glide.current = undefined;
		ghost.current?.remove();
		ghost.current = null;
		if (!box || !same) return;
		if (!present && g) {
			/* (no entrance replays on the copy) */
			g.classList.add("ov-ghost");
			box.appendChild(g);
			ghost.current = g;
			play(
				g,
				[
					{ opacity: 1, translate: "0 0" },
					{ opacity: 0, translate: "0 -14px" },
				],
				{ duration: 620, easing: EASE },
			);
		}
		const to = present ? box.offsetHeight : 0;
		const anim = play(
			box,
			[
				{ height: `${from.current}px`, overflow: "clip" },
				{ height: `${to}px`, overflow: "clip" },
			],
			{ duration: 620, easing: EASE },
		);
		glide.current = anim;
		const done = () => {
			if (glide.current === anim) glide.current = undefined;
			if (g && ghost.current === g) {
				g.remove();
				ghost.current = null;
			}
		};
		if (!anim) done();
		else anim.onfinish = done;
	});
}

/** `<section class="ov" id="planOv">` in a slot that keeps its place in the page while it comes and goes. */
export function PlanOverview({ panel, ui }: PlanOverviewProps) {
	const ov = panel.overview;
	const open = overviewOpen(ui.s, ov);
	const slotRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	useComeAndGo(slotRef, !!ov);
	useComeAndGo(bodyRef, open);
	const what = `${open ? "Hide" : "Show"} the plan’s modules`;
	return (
		<div className="ov-slot" ref={slotRef}>
			{ov ? (
				/* named apart from the line's "Plan" region */
				<section className="ov" id="planOv" aria-label={`Plan overview, version ${ov.version}`}>
					<header className="ov-h">
						<h2 className="lab">
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
						<button
							type="button"
							className="ib sm ov-tg"
							data-k="ovtoggle"
							aria-expanded={open}
							aria-controls={open ? "ovList" : undefined}
							aria-label={what}
							data-tip={what}
							onClick={ui.toggleOverview}
						>
							<Icon name="chevd" size={18} />
						</button>
					</header>
					<div className="ov-body" ref={bodyRef}>
						{open ? (
							<ol className="ov-l" id="ovList">
								{ov.rows.map((r, i) => (
									<Row key={r.id} r={r} i={i} ui={ui} current={ui.s.sel === r.id} />
								))}
							</ol>
						) : null}
					</div>
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
