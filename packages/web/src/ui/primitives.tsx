/**
 * The mockup's graphic helpers as components, with the same SVG, markup and classes so the ported
 * CSS applies unchanged: `glyph()` → <Glyph>, `octagon()` → <Octagon>, `diffbar()` → <DiffBar>,
 * `pips()` → <Pips>, `strip()` → <Strip>, `codeBlock()` → <CodeBlock>, `tipImg()` → tipImg().
 */

import type { ReactNode } from "react";
import type { CodeLine } from "../model/format.ts";
import type { ActType, GlyphStatus } from "../model/panel.ts";

/**
 * Props for an informational graphic that can take keyboard focus, so its tooltip shows on hover
 * AND focus: spread onto the element (`<span className="pill" {...tipImg("Run time 6:00", "Run time")}>`).
 */
export function tipImg(
	label: string,
	tip?: string,
): { tabIndex: 0; role: "img"; "aria-label": string; "data-tip": string } {
	return { tabIndex: 0, role: "img", "aria-label": label, "data-tip": tip ?? label };
}

export interface GlyphProps {
	/** Status shape to draw (`pre` draws the small before-plan dot). */
	status: GlyphStatus;
	/** px, default 20. */
	size?: number;
	/** Spin the working arc (honours reduced motion through CSS). */
	animate?: boolean;
}

/** A status shape (shape + colour; decorative, aria-hidden). The mockup's `glyph(st, s, anim)`. */
export function Glyph({ status, size = 20, animate = false }: GlyphProps) {
	let body: ReactNode;
	switch (status) {
		case "verified":
			body = (
				<>
					<circle cx="10" cy="10" r="8.5" fill="var(--ok)" />
					<path
						d="M6 10.4l2.7 2.7 5.3-5.6"
						fill="none"
						stroke="var(--on-ok)"
						strokeWidth="1.9"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</>
			);
			break;
		case "unverified":
			body = (
				<>
					<circle cx="10" cy="10" r="7.6" fill="none" stroke="var(--warn)" strokeWidth="1.8" />
					<path d="M10 2.4A7.6 7.6 0 0 0 10 17.6Z" fill="var(--warn)" />
				</>
			);
			break;
		case "working":
			body = (
				<>
					<circle cx="10" cy="10" r="7.4" fill="none" stroke="var(--pend-line)" strokeWidth="2" />
					<g className={animate ? "spin" : ""}>
						<path
							d="M10 2.6A7.4 7.4 0 0 1 17.4 10"
							fill="none"
							stroke="var(--act)"
							strokeWidth="2.4"
							strokeLinecap="round"
						/>
					</g>
					<circle cx="10" cy="10" r="2.6" fill="var(--act)" />
				</>
			);
			break;
		case "waiting":
			body = (
				<rect x="4.4" y="4.4" width="11.2" height="11.2" rx="1.2" transform="rotate(45 10 10)" fill="var(--warn)" />
			);
			break;
		case "pending":
			body = <circle cx="10" cy="10" r="7.4" fill="none" stroke="var(--pend)" strokeWidth="1.8" />;
			break;
		case "failed":
			body = (
				<>
					<circle cx="10" cy="10" r="8.5" fill="var(--bad)" />
					<path d="M7 7l6 6M13 7l-6 6" stroke="var(--on-bad)" strokeWidth="1.9" strokeLinecap="round" />
				</>
			);
			break;
		case "stopped":
			body = <rect x="3.6" y="3.6" width="12.8" height="12.8" rx="2.4" fill="var(--bad)" />;
			break;
		case "replaced":
			body = (
				<>
					<circle cx="10" cy="10" r="7.4" fill="none" stroke="var(--pend)" strokeWidth="1.8" strokeDasharray="3 2.2" />
					<path d="M4.6 15.4L15.4 4.6" stroke="var(--bad)" strokeWidth="1.9" strokeLinecap="round" />
				</>
			);
			break;
		case "end":
			/* run end = metro terminus (bar + buffer), deliberately not the verified check */
			body = (
				<>
					<rect x="1.5" y="8.6" width="12" height="2.8" rx="1.4" fill="var(--fg-2)" />
					<rect x="14.6" y="3" width="3.6" height="14" rx="1.2" fill="var(--fg-2)" />
				</>
			);
			break;
		default:
			body = <circle cx="10" cy="10" r="5" fill="var(--pend)" />;
	}
	return (
		<svg className="g" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
			{body}
		</svg>
	);
}

export interface OctagonProps {
	/** px, default 20. */
	size?: number;
	/** Filled (armed) vs outline (offered, shown on hover/focus). */
	solid?: boolean;
}

/** The pause-at-boundary stop sign. The mockup's `octagon(s, solid)`. */
export function Octagon({ size = 20, solid = false }: OctagonProps) {
	return (
		<svg className="g" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
			<path
				d="M6.7 1.5h6.6l5.2 5.2v6.6l-5.2 5.2H6.7l-5.2-5.2V6.7z"
				fill={solid ? "var(--warn-solid)" : "var(--bg)"}
				stroke="var(--warn)"
				strokeWidth="1.5"
			/>
			<path
				d="M8.2 7v6M11.8 7v6"
				stroke={solid ? "var(--on-warn)" : "var(--warn-fg)"}
				strokeWidth="1.8"
				strokeLinecap="round"
			/>
		</svg>
	);
}

export interface DiffBarProps {
	/** Added lines. */
	add: number;
	/** Deleted lines. */
	del: number;
	/** false = bar only; "align" = keep a muted zero side so columns line up; default = omit the zero side. */
	nums?: false | "align";
}

/** Five-block diff bar plus `+a −d`. The mockup's `diffbar(a, d, nums)`. */
export function DiffBar({ add, del, nums }: DiffBarProps) {
	const total = add + del;
	let na = 0;
	let nd = 0;
	if (total > 0) {
		na = Math.round((5 * add) / total);
		nd = 5 - na;
		if (del > 0 && nd === 0) {
			nd = 1;
			na = 4;
		}
		if (add > 0 && na === 0) {
			na = 1;
			nd = 4;
		}
	}
	const blocks = [0, 1, 2, 3, 4].map((i) => <i key={i} className={i < na ? "a" : i < na + nd ? "d" : ""} />);
	const zero = (v: string) => (nums === "align" ? <span className="z">{v}</span> : null);
	const pa = add ? <span className="p">+{add}</span> : zero("+0");
	const pd = del ? <span className="m">−{del}</span> : zero("−0");
	return (
		<>
			<span className="db" role="img" aria-label={`+${add} −${del} lines`}>
				{blocks}
			</span>
			{nums === false ? null : (
				<span className="dn" aria-hidden="true">
					{pa}
					{pa && pd ? " " : null}
					{pd}
				</span>
			)}
		</>
	);
}

export interface PipsProps {
	/** Passed tests. */
	pass: number;
	/** Failed tests (failed + errors). */
	fail: number;
	/** Append a ring: still running. */
	live?: boolean;
	/** false = pips only (no `p/n`). */
	nums?: false;
	/** Max pips drawn (scaled down beyond it), default 12. */
	cap?: number;
}

/** Test pips: dots passed, crosses failed, a ring while running, then `p/n`. The mockup's `pips()`. */
export function Pips({ pass, fail, live = false, nums, cap = 12 }: PipsProps) {
	const n = pass + fail;
	const sp = n > cap ? Math.round((pass / n) * cap) : pass;
	const sf = n > cap ? cap - sp : fail;
	const items: ReactNode[] = [];
	for (let i = 0; i < sp; i++) items.push(<i key={`p${i}`} className="pp" />);
	for (let i = 0; i < sf; i++) items.push(<i key={`f${i}`} className="pf" />);
	if (live) items.push(<i key="l" className="pl" />);
	const label = `Tests: ${pass} passed, ${fail} failed${live ? ", still running" : ""}`;
	return (
		<>
			<span className="pips" role="img" aria-label={label}>
				{items}
			</span>
			{nums === false ? null : (
				<span className="tn" aria-hidden="true">
					{pass}/{n}
				</span>
			)}
		</>
	);
}

/** The fields Strip reads from an action (ActView fits). */
export interface StripAct {
	type: ActType;
	live?: boolean;
	fail?: number;
}

export interface StripProps {
	/** Actions in order, one tick each. */
	acts: readonly StripAct[];
	/** Make it a tab stop (so its legend tooltip shows on focus). */
	focusable?: boolean;
}

const TICK: Record<ActType, string> = {
	read: "t-read",
	write: "t-edit",
	edit: "t-edit",
	bash: "t-bash",
	test: "t-test",
};

/** Activity strip: one tick per action (legend tooltip). The mockup's `strip(acts, focusable)`. */
export function Strip({ acts, focusable = false }: StripProps) {
	const count = { read: 0, edit: 0, bash: 0, test: 0 };
	const ticks = acts.map((a, i) => {
		let cls = TICK[a.type];
		if (a.type === "test") cls += a.live ? " live" : (a.fail ?? 0) > 0 ? " fail" : "";
		count[a.type === "write" ? "edit" : a.type]++;
		// biome-ignore lint/suspicious/noArrayIndexKey: ticks are positional and never reorder
		return <i key={i} className={`t ${cls}`} />;
	});
	return (
		<span
			className="strip"
			role="img"
			aria-label={`Activity: ${count.read} read, ${count.edit} edit, ${count.bash} command, ${count.test} test runs`}
			data-tip="legend"
			tabIndex={focusable ? 0 : undefined}
		>
			{ticks}
		</span>
	);
}

export interface CodeBlockProps {
	/** `[kind, text]` lines (see model/format.ts LineKind). */
	lines: readonly CodeLine[];
	/** Region name (a code block can scroll, so it is a named region), default "Output". */
	label?: string;
}

/** A diff / output / excerpt block: a named region (it can scroll). The mockup's `codeBlock(lines, label)`. */
export function CodeBlock({ lines, label = "Output" }: CodeBlockProps) {
	return (
		<section className="code" aria-label={label}>
			{lines.map(([kind, text], i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
				<div key={i} className={kind}>
					{text}
				</div>
			))}
		</section>
	);
}
