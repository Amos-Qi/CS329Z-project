/**
 * The harness bar: the mockup's floating MOCKUP pill restyled as researcher chrome (`#harness`,
 * `.harness`, `.hg` groups, `.hb` buttons, `.scrub`). Back to runs, view switch (Modules / Log /
 * Raw; hidden in study mode), theme toggle, and the replay scrubber (slider over trace positions,
 * play/pause, step, jump to the end). Not part of either condition.
 *
 * Home renders it without a run (no `ui`): then only the theme toggle is shown, driven by
 * `theme`/`onTheme`.
 */

import type { Theme, Ui, View } from "../state/ui.ts";
import { Icon } from "../ui/icons.tsx";

/** The replay scrubber's state and commands (owned by the app shell). */
export interface ReplayControl {
	/** Number of trace events. */
	length: number;
	/** Index of the last event shown (length - 1 = the live end). */
	pos: number;
	/** Showing the newest event (not scrubbed back). */
	atEnd: boolean;
	/** Auto-advancing. */
	playing: boolean;
	/** `m:ss` of the shown position since run start. */
	clock: string;
	/** The run is still going, so the end keeps moving ("Live" rather than "End"). */
	live?: boolean;
	seek(pos: number): void;
	play(): void;
	pause(): void;
	/** Jump to the newest event and follow it. */
	toLive(): void;
}

/** Props of Harness. */
export interface HarnessProps {
	/** For the view switch (ui.s.view, ui.setView) and the theme toggle (ui.s.theme, ui.toggleTheme); absent on Home. */
	ui?: Ui;
	/** Study mode (`&study=1`): the view switch is hidden, the condition is fixed by the URL. */
	study: boolean;
	/** Back to Home (the runs list); absent on Home. */
	onBack?: () => void;
	/** Replay scrubber; absent when there is no trace yet. */
	replay?: ReplayControl;
	/** Without `ui` (Home): the theme shown and its toggle. */
	theme?: Theme;
	onTheme?: () => void;
}

const VIEWS: [View, string][] = [
	["modules", "Modules"],
	["log", "Log"],
	["raw", "Raw"],
];

/** `<section id="harness" class="harness">` (a named region). */
export function Harness({ ui, study, onBack, replay, theme: homeTheme, onTheme }: HarnessProps) {
	const theme = ui?.s.theme ?? homeTheme ?? "dark";
	const other = theme === "dark" ? "light" : "dark";
	const keys = ui ? `Keys: ${study ? "" : "v view · "}t theme · j/k move · Enter open · Esc back` : "Keys: t theme";
	return (
		<section id="harness" className="harness" aria-label="Harness controls (not part of the product)">
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: the mockup's tag takes focus so its key list shows on focus too */}
			<span className="harness-tag" tabIndex={0} data-tip={keys}>
				Harness
			</span>
			{onBack ? (
				<button type="button" className="hb" onClick={onBack} data-k="hback">
					<Icon name="list" size={14} />
					Runs
				</button>
			) : null}
			{ui && !study ? (
				// biome-ignore lint/a11y/useSemanticElements: the mockup's role="group" (a fieldset would restyle it)
				<div className="hg" role="group" aria-label="View (study condition)">
					{VIEWS.map(([v, label]) => (
						<button
							key={v}
							type="button"
							className="hb"
							aria-pressed={ui.s.view === v}
							data-k={`hv-${v}`}
							onClick={() => ui.setView(v, `hv-${v}`)}
						>
							{label}
						</button>
					))}
				</div>
			) : null}
			{replay ? <Scrubber replay={replay} /> : null}
			<button
				type="button"
				className="hb"
				data-k="htheme"
				aria-label={`Theme: ${theme}. Switch to ${other}`}
				onClick={ui ? ui.toggleTheme : onTheme}
			>
				<Icon name={theme === "dark" ? "moon" : "sun"} size={14} />
				{theme === "dark" ? "Dark" : "Light"}
			</button>
		</section>
	);
}

/**
 * Replay: play/pause, previous event, the position slider (arrow keys step one event, Home/End
 * jump), next event, the position as m:ss, and jump to the end. Buttons that cannot act stay
 * focusable with aria-disabled (the mockup's pattern).
 */
function Scrubber({ replay }: { replay: ReplayControl }) {
	const { length, pos, atEnd, playing, clock } = replay;
	const last = Math.max(0, length - 1);
	const canPlay = length > 1;
	const toEnd = replay.live ? "Live" : "End";
	const step = (dir: 1 | -1) => {
		const next = pos + dir;
		if (next >= 0 && next <= last) replay.seek(next);
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: a labelled group like the view switch (a fieldset would restyle it)
		<div className="scrub" role="group" aria-label="Replay">
			<button
				type="button"
				className="hb"
				data-k="hplay"
				aria-label={playing ? "Pause replay" : "Play replay"}
				data-tip={playing ? "Pause replay" : atEnd ? "Play from the start" : "Play replay"}
				aria-disabled={!canPlay}
				onClick={() => {
					if (!canPlay) return;
					if (playing) replay.pause();
					else replay.play();
				}}
			>
				<Icon name={playing ? "idle" : "playc"} size={14} />
			</button>
			<button
				type="button"
				className="hb"
				data-k="hprev"
				aria-label="Previous event"
				data-tip="Previous event"
				aria-disabled={pos <= 0}
				onClick={() => step(-1)}
			>
				<Icon name="chevl" size={14} />
			</button>
			<input
				type="range"
				min={0}
				max={last}
				step={1}
				value={Math.min(pos, last)}
				disabled={length < 2}
				aria-label="Replay position"
				aria-valuetext={`${clock}, event ${pos + 1} of ${length}`}
				data-k="hscrub"
				onChange={(e) => replay.seek(Number(e.currentTarget.value))}
			/>
			<button
				type="button"
				className="hb"
				data-k="hnext"
				aria-label="Next event"
				data-tip="Next event"
				aria-disabled={pos >= last}
				onClick={() => step(1)}
			>
				<Icon name="chevr" size={14} />
			</button>
			<span className="mono" aria-hidden="true">
				{clock}
			</span>
			<button
				type="button"
				className="hb"
				data-k="hlive"
				data-tip={replay.live ? "Jump to now and follow the run" : "Jump to the end"}
				aria-disabled={atEnd}
				onClick={() => {
					if (!atEnd) replay.toLive();
				}}
			>
				<Icon name="end" size={14} />
				{toEnd}
			</button>
		</div>
	);
}
