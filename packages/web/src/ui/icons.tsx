/**
 * The panel's one outline icon family: the mockup's `<svg><defs><symbol id="i-…">` sprite, verbatim
 * (plus `chevl`, the mirror of `chevr`, for the replay scrubber), and `<Icon>` (the mockup's `ic()`),
 * which references a symbol with `<use href="#i-name">`.
 */

/** Every symbol in the sprite. */
export type IconName =
	| "pause"
	| "pausestop"
	| "note"
	| "say"
	| "stop"
	| "flag"
	| "term"
	| "file"
	| "fileplus"
	| "filediff"
	| "edit"
	| "eye"
	| "flask"
	| "bot"
	| "user"
	| "check"
	| "x"
	| "clock"
	| "link"
	| "undo"
	| "cut"
	| "list"
	| "history"
	| "chevr"
	| "chevl"
	| "chevd"
	| "search"
	| "sun"
	| "moon"
	| "target"
	| "activity"
	| "panel"
	| "send"
	| "plan"
	| "playc"
	| "checkc"
	| "idle"
	| "arrowr"
	| "layers"
	| "end";

const SPRITE = `
	<symbol id="i-pause" viewBox="0 0 24 24"><rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/></symbol>
	<symbol id="i-pausestop" viewBox="0 0 24 24"><path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3z"/><path d="M10 9v6M14 9v6"/></symbol>
	<symbol id="i-note" viewBox="0 0 24 24"><path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/><path d="M8.5 9h7M8.5 12.5h4.5"/></symbol>
	<symbol id="i-say" viewBox="0 0 24 24"><path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.6A8 8 0 1 1 20.5 11.5z"/></symbol>
	<symbol id="i-stop" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></symbol>
	<symbol id="i-flag" viewBox="0 0 24 24"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4.5L17 13H5"/></symbol>
	<symbol id="i-term" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15H17"/></symbol>
	<symbol id="i-file" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></symbol>
	<symbol id="i-fileplus" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11.5v6M9 14.5h6"/></symbol>
	<symbol id="i-filediff" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 10v5M9.5 12.5h5M9.5 17.5h5"/></symbol>
	<symbol id="i-edit" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></symbol>
	<symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></symbol>
	<symbol id="i-flask" viewBox="0 0 24 24"><path d="M9 3h6M10 3v6.2L4.6 18.6A1.6 1.6 0 0 0 6 21h12a1.6 1.6 0 0 0 1.4-2.4L14 9.2V3"/><path d="M7.2 15h9.6"/></symbol>
	<symbol id="i-bot" viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M12 4.5V8M9 13.5v1M15 13.5v1"/><circle cx="12" cy="4" r=".6"/></symbol>
	<symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></symbol>
	<symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></symbol>
	<symbol id="i-x" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></symbol>
	<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></symbol>
	<symbol id="i-link" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/></symbol>
	<symbol id="i-undo" viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></symbol>
	<symbol id="i-cut" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.8"/><circle cx="6" cy="18" r="2.8"/><path d="M8.2 7.8L20 19M8.2 16.2L20 5"/></symbol>
	<symbol id="i-list" viewBox="0 0 24 24"><path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/></symbol>
	<symbol id="i-history" viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5M12 8v4.2l2.8 1.8"/></symbol>
	<symbol id="i-chevr" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></symbol>
	<symbol id="i-chevl" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></symbol>
	<symbol id="i-chevd" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></symbol>
	<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></symbol>
	<symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></symbol>
	<symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></symbol>
	<symbol id="i-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/></symbol>
	<symbol id="i-activity" viewBox="0 0 24 24"><path d="M3 12h4l3-7 4 14 3-7h4"/></symbol>
	<symbol id="i-panel" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/></symbol>
	<symbol id="i-send" viewBox="0 0 24 24"><path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/></symbol>
	<symbol id="i-plan" viewBox="0 0 24 24"><path d="M3.5 6.5l1.5 1.5 2.5-2.5M3.5 12l1.5 1.5 2.5-2.5M3.5 17.5l1.5 1.5 2.5-2.5M11 7h9.5M11 12.5h9.5M11 18h9.5"/></symbol>
	<symbol id="i-playc" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.8l5 3.2-5 3.2z"/></symbol>
	<symbol id="i-checkc" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.3l2.6 2.6 5-5.4"/></symbol>
	<symbol id="i-idle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M10 9v6M14 9v6"/></symbol>
	<symbol id="i-arrowr" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
	<symbol id="i-layers" viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></symbol>
	<symbol id="i-end" viewBox="0 0 24 24"><path d="M3 12h13"/><path d="M19 5.5v13"/><circle cx="9" cy="12" r="2.5"/></symbol>
`;

/** The symbol sprite. Render it once, near the top of the page; every `<Icon>` points into it. */
export function IconSprite() {
	return (
		<svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
			{/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, verbatim sprite from the mockup */}
			<defs dangerouslySetInnerHTML={{ __html: SPRITE }} />
		</svg>
	);
}

export interface IconProps {
	/** Symbol to draw. */
	name: IconName;
	/** Width and height in px (default 16). */
	size?: number;
	/** Extra classes after `i` (e.g. `muted`, `ic`). */
	className?: string;
}

/** An outline icon (decorative: `aria-hidden`; the control around it carries the name). Same markup as `ic()`. */
export function Icon({ name, size = 16, className }: IconProps) {
	return (
		<svg className={className ? `i ${className}` : "i"} width={size} height={size} aria-hidden="true">
			<use href={`#i-${name}`} />
		</svg>
	);
}
