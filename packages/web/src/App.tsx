/**
 * App shell: Home when no run is open; otherwise one RunPanel (keyed by run id, so its UI state
 * starts fresh) that wires connection → reduceTrace → buildPanel → components.
 *
 * URL state: `?run=<id>&view=modules|log|raw&t=<seq>&study=1`. `run` changes push a history entry
 * (the browser's back button returns to the runs list); `view` and `t` are replaced in place.
 * `t` is the replay position: the seq of the last event shown (absent = follow the live end).
 * `study=1` hides the view switch, so the condition is fixed by the URL.
 *
 * Replay: the panel renders `reduceTrace(events up to t)` with `now` = that event's time and
 * `replaying` set, so every control is hidden as in a finished run.
 *
 * Global behaviour kept from the mockup: keyboard (ui.keydown, plus the harness keys v and t) and
 * click outside a popover closing it. NowBar owns the rest of the popover behaviour (the Stop
 * confirmation's inertness, focus leaving a non-modal popover) and the state announcements.
 */

import { isLive, reduceTrace, type TraceEvent } from "@vcm/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRun } from "./api.ts";
import { Harness, type ReplayControl } from "./components/Harness.tsx";
import { Home } from "./components/Home.tsx";
import { LogView } from "./components/LogView.tsx";
import { Metro } from "./components/Metro.tsx";
import { Work } from "./components/ModuleCard.tsx";
import { NowBar } from "./components/NowBar.tsx";
import { PlanOverview } from "./components/PlanOverview.tsx";
import { RawView } from "./components/RawView.tsx";
import { useControls } from "./controls.ts";
import { clock } from "./model/format.ts";
import { buildPanel } from "./model/panel.ts";
import { THEME_KEY, type Theme, useUi, type View } from "./state/ui.ts";
import { LiveRegions, resetRegions, toast, useWaiting } from "./ui/announce.tsx";
import { IconSprite } from "./ui/icons.tsx";
import { hideTip, installTooltips } from "./ui/tooltip.ts";

// ---- URL and theme ---------------------------------------------------------------------------

/** Applies and remembers a theme. */
function saveTheme(theme: Theme): void {
	document.documentElement.setAttribute("data-theme", theme);
	try {
		localStorage.setItem(THEME_KEY, theme);
	} catch {
		// private mode: the theme just is not remembered
	}
}

/** The theme on screen (`data-theme` on <html>), which survives moving between Home and a run. */
function shownTheme(): Theme {
	return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

interface Route {
	runId?: string;
	view: View;
	/** Replay position (seq), if any. */
	t?: number;
	study: boolean;
}

function readRoute(): Route {
	const p = new URLSearchParams(location.search);
	const view = p.get("view");
	const t = Number.parseInt(p.get("t") ?? "", 10);
	return {
		runId: p.get("run") || undefined,
		view: view === "log" || view === "raw" ? view : "modules",
		t: Number.isFinite(t) && t >= 0 ? t : undefined,
		study: p.get("study") === "1",
	};
}

/** Sets (string) or removes (undefined) URL parameters, keeping the others (e.g. `study`). */
function writeUrl(patch: Record<string, string | undefined>, push = false): void {
	const next = new URLSearchParams(location.search);
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) next.delete(k);
		else next.set(k, v);
	}
	const query = next.toString();
	const url = query ? `?${query}` : location.pathname;
	try {
		if (push) history.pushState(null, "", url);
		else history.replaceState(null, "", url);
	} catch {
		// browsers throttle history updates; the URL is a convenience
	}
}

/** Typing in a field, or a modifier held: single-key shortcuts stay off (WCAG 2.1.4). */
function shortcutOff(e: KeyboardEvent): boolean {
	const t = e.target as Element | null;
	if (e.metaKey || e.ctrlKey || e.altKey) return true;
	if (!t?.closest) return false;
	return t.matches("input, textarea, select, [contenteditable]") || !!t.closest(".pop");
}

// ---- app -------------------------------------------------------------------------------------

export function App() {
	const [route, setRoute] = useState(readRoute);
	useEffect(() => installTooltips(), []);
	useEffect(() => {
		const onPop = () => setRoute(readRoute());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);
	const open = useCallback((runId: string | undefined) => {
		hideTip();
		writeUrl({ run: runId, t: undefined }, true);
		setRoute(readRoute());
		window.scrollTo(0, 0);
	}, []);
	const back = useCallback(() => open(undefined), [open]);
	return (
		<>
			<IconSprite />
			{route.runId ? (
				<RunPanel
					key={route.runId}
					runId={route.runId}
					initialView={route.view}
					initialT={route.t}
					study={route.study}
					onBack={back}
				/>
			) : (
				<HomePage study={route.study} onOpen={open} />
			)}
			{/* outside the page switch: live regions that already exist are announced reliably */}
			<LiveRegions />
			<div id="tip" role="tooltip" hidden />
		</>
	);
}

/** Home plus the harness bar (theme only). */
function HomePage({ study, onOpen }: { study: boolean; onOpen: (runId: string) => void }) {
	const [theme, setTheme] = useState(shownTheme);
	const toggle = useCallback(() => {
		const next: Theme = shownTheme() === "dark" ? "light" : "dark";
		saveTheme(next);
		setTheme(next);
	}, []);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (shortcutOff(e) || e.key !== "t") return;
			toggle();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [toggle]);
	return (
		<>
			<Home onOpen={onOpen} />
			<Harness study={study} theme={theme} onTheme={toggle} />
		</>
	);
}

// ---- one run ---------------------------------------------------------------------------------

interface RunPanelProps {
	runId: string;
	initialView: View;
	/** Replay position from the URL (seq of the last event shown). */
	initialT?: number;
	study: boolean;
	onBack: () => void;
}

/** Number of events up to and including seq `at` (events are in seq order). */
function countUpTo(events: readonly TraceEvent[], at: number): number {
	return events.findLastIndex((e) => e.seq <= at) + 1;
}

/** Playback pace: the real gap between two events, kept readable (never a blur, never a long wait). */
const PLAY_MIN_MS = 300;
const PLAY_MAX_MS = 1200;

function RunPanel({ runId, initialView, initialT, study, onBack }: RunPanelProps) {
	const connection = useRun(runId);
	const events = useMemo(() => connection.events.filter(Boolean), [connection.events]);

	// replay position: seq of the last event shown, or null to follow the end
	const [at, setAt] = useState<number | null>(initialT ?? null);
	const [playing, setPlaying] = useState(false);
	const count = at === null ? events.length : countUpTo(events, at);
	const shown = useMemo(() => (count >= events.length ? events : events.slice(0, count)), [events, count]);
	const replaying = count < events.length;

	const state = useMemo(() => reduceTrace(shown), [shown]);
	// the clock ticks only while the server is running this run and you are watching its end
	const following = !replaying && isLive(state) && !!connection.control?.live;
	const [tick, setTick] = useState(() => Date.now());
	useEffect(() => {
		if (!following) return;
		setTick(Date.now());
		const id = setInterval(() => setTick(Date.now()), 1000);
		return () => clearInterval(id);
	}, [following]);
	const lastT = shown.at(-1)?.t;
	const now = following ? Math.max(tick, lastT ?? 0) : (lastT ?? tick);

	const panel = useMemo(
		() => buildPanel(state, { events: shown, now, control: connection.control, replaying }),
		[state, shown, now, connection.control, replaying],
	);
	const controls = useControls(replaying ? undefined : runId, connection, state.pendingBoundary?.boundaryId);
	const ui = useUi(panel, controls, { view: initialView, theme: shownTheme() });
	const { keydown, dismissPop, setView, toggleTheme, suspend } = ui;
	const view = ui.s.view;
	useWaiting(panel.now.kind === "waiting");

	// scrubbed back, nothing can be sent: an open popover closes and an open editor is kept as a draft
	useEffect(() => {
		if (replaying) suspend();
	}, [replaying, suspend]);
	// what this run said does not carry over to Home
	useEffect(() => resetRegions, []);

	// ---- global keyboard, click outside a popover ----
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			keydown(e);
			if (e.defaultPrevented || shortcutOff(e)) return;
			if (e.key === "t") toggleTheme();
			else if (e.key === "v" && !study) {
				const k = (document.activeElement as HTMLElement | null)?.dataset?.k;
				setView(view === "modules" ? "log" : "modules", k);
			}
		};
		const onClick = (e: MouseEvent) => {
			const t = e.target as Element | null;
			if (!t?.closest?.(".pop") && !t?.closest?.('[aria-haspopup="dialog"]')) dismissPop();
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("click", onClick);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("click", onClick);
		};
	}, [keydown, dismissPop, setView, toggleTheme, study, view]);

	// ---- URL: view and replay position ----
	useEffect(() => {
		if (!study) writeUrl({ view });
	}, [view, study]);
	useEffect(() => {
		// debounced: dragging the slider would otherwise flood the history API
		const id = setTimeout(() => writeUrl({ t: at === null ? undefined : String(at) }), 250);
		return () => clearTimeout(id);
	}, [at]);

	// ---- server errors and a lost connection ----
	useEffect(() => {
		if (connection.errorId && connection.error) toast(connection.error, { error: true });
	}, [connection.errorId, connection.error]);
	const wasConnected = useRef(false);
	useEffect(() => {
		if (connection.connected) wasConnected.current = true;
		else if (wasConnected.current) {
			wasConnected.current = false;
			toast("Disconnected from the server", { error: true });
		}
	}, [connection.connected]);

	// ---- replay ----
	// the timer reads the newest events without restarting each time a live event arrives
	const eventsRef = useRef(events);
	useEffect(() => {
		eventsRef.current = events;
	});
	useEffect(() => {
		if (!playing) return;
		const list = eventsRef.current;
		const cur = list[count - 1];
		const next = list[count];
		if (!next) {
			setPlaying(false);
			return;
		}
		const gap = cur ? next.t - cur.t : 0;
		const id = setTimeout(
			() => setAt(count + 1 >= eventsRef.current.length ? null : next.seq),
			Math.min(PLAY_MAX_MS, Math.max(PLAY_MIN_MS, gap)),
		);
		return () => clearTimeout(id);
	}, [playing, count]);

	const start = events[0]?.t ?? 0;
	const replay: ReplayControl | undefined = events.length
		? {
				length: events.length,
				pos: Math.max(0, count - 1),
				atEnd: !replaying,
				playing,
				clock: clock((lastT ?? start) - start),
				// the server holds the run, so new events can still arrive at the end
				live: !!connection.control?.live,
				seek: (p) => {
					setPlaying(false);
					dismissPop();
					setAt(p >= events.length - 1 ? null : (events[Math.max(0, p)]?.seq ?? null));
				},
				play: () => {
					if (events.length < 2) return;
					dismissPop();
					if (!replaying) setAt(events[0]?.seq ?? null);
					setPlaying(true);
				},
				pause: () => setPlaying(false),
				toLive: () => {
					setPlaying(false);
					setAt(null);
				},
			}
		: undefined;

	return (
		<>
			<NowBar panel={panel} ui={ui} />
			<main id="main">
				{view === "modules" ? (
					<>
						<Metro panel={panel} ui={ui} />
						<PlanOverview panel={panel} ui={ui} />
						<Work panel={panel} ui={ui} />
					</>
				) : view === "log" ? (
					<LogView panel={panel} ui={ui} />
				) : (
					<RawView events={shown} />
				)}
			</main>
			<Harness ui={ui} study={study} onBack={onBack} replay={replay} />
		</>
	);
}
