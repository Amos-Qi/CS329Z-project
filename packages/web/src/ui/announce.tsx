/**
 * Live regions and toasts (the mockup's `#toast`, `#live`, `#alert`, `announce()`, `toast()`).
 *
 * The visual toast is decorative for assistive tech (aria-hidden); every message also goes to the
 * persistent live regions, which are never re-created, so screen readers hear each one once.
 * Rules kept from the mockup: messages are set after a short delay so a repeated message is
 * announced again; an assertive alert (a decision is needed) is cleared by the next polite status
 * message unless the agent is still waiting.
 *
 * `announce()` and `toast()` are plain functions (call them from event handlers or effects);
 * `<LiveRegions/>` renders the elements once for the whole app (outside the page switch), the open run
 * reports whether the agent waits with `useWaiting()`, and `resetRegions()` clears them.
 */

import { useLayoutEffect, useSyncExternalStore } from "react";
import { Icon } from "./icons.tsx";

interface Regions {
	toast: { id: number; msg: string; error: boolean } | null;
	live: string;
	alert: string;
}

let regions: Regions = { toast: null, live: "", alert: "" };
let waiting = false;
let toastId = 0;
const timers: Partial<Record<"toast" | "live" | "alert", number>> = {};
const listeners = new Set<() => void>();

function set(patch: Partial<Regions>): void {
	regions = { ...regions, ...patch };
	for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/**
 * Says `msg` in the polite status region (`#live`), or in the assertive one (`#alert`) when
 * `assertive` (use only for "Decision needed" and errors). A polite message clears a stale alert
 * unless the agent is waiting for you.
 */
export function announce(msg: string, assertive = false): void {
	if (!assertive && !waiting) {
		clearTimeout(timers.alert);
		set({ alert: "" });
	}
	const key = assertive ? "alert" : "live";
	clearTimeout(timers[key]);
	set({ [key]: "" });
	timers[key] = window.setTimeout(() => set({ [key]: msg }), 80);
}

/**
 * Shows a toast for 2.8 s and announces it. `error: true` draws the × icon in red and announces
 * assertively (server errors). Toasts report what really happened, e.g. "M4 instructions saved as v2 · by you".
 */
export function toast(msg: string, opts: { error?: boolean } = {}): void {
	const error = opts.error === true;
	clearTimeout(timers.toast);
	set({ toast: { id: ++toastId, msg, error } });
	timers.toast = window.setTimeout(() => set({ toast: null }), 2800);
	announce(msg, error);
}

/** Clears the toast and both regions (leaving a run, so its last alert does not carry over to Home). */
export function resetRegions(): void {
	for (const t of Object.values(timers)) clearTimeout(t);
	waiting = false;
	set({ toast: null, live: "", alert: "" });
}

/**
 * The agent is waiting for you at a boundary (call from the open run): a decision alert stays until this
 * turns false, and is cleared then (Continue, Redo or Stop answered it), so no stale call to action remains.
 */
export function useWaiting(isWaiting: boolean): void {
	// a layout effect, so it is current before the panel's (passive) announcement effects of the same render
	useLayoutEffect(() => {
		if (waiting && !isWaiting) {
			clearTimeout(timers.alert);
			set({ alert: "" });
		}
		waiting = isWaiting;
	}, [isWaiting]);
	useLayoutEffect(
		() => () => {
			waiting = false;
		},
		[],
	);
}

/** The toast and the two live regions. Render once for the whole app (outside `#main`), never re-created. */
export function LiveRegions() {
	const state = useSyncExternalStore(
		subscribe,
		() => regions,
		() => regions,
	);
	const t = state.toast;
	return (
		<>
			<div id="toast" className={t?.error ? "toast err" : "toast"} aria-hidden="true" hidden={!t}>
				{t ? (
					<>
						<Icon name={t.error ? "x" : "check"} size={16} />
						<span>{t.msg}</span>
					</>
				) : null}
			</div>
			<div id="live" className="sr-only" role="status" aria-atomic="true">
				{state.live}
			</div>
			<div id="alert" className="sr-only" role="alert" aria-atomic="true">
				{state.alert}
			</div>
		</>
	);
}
