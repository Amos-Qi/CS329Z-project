/**
 * The two editors, shared by the module card and the log rows (both views open the same ones):
 * - Editor: "Instructions for Mk" (change, Save as vN) or "Correction for Mk" (correct, Send
 *   correction), `#edPanel` with `#edText` (data-k `edtext`). Port of editorHTML().
 * - RedoPanel: "Redo from Mk" with instructions (`rdtext`), "What went wrong" (`rdnote`), and the
 *   consequence preview (Restore files, Rewind strip, Agent stops/idle) from redoPreview(). Port of
 *   redoPanel()/rewindStrip().
 * Neither knows which view it is in: what they send and where focus returns is up to the UI store.
 */

import type { ModuleId } from "@vcm/protocol";
import { joinAnd } from "../model/format.ts";
import { type ModView, type RedoPreview, redoPreview, type VersionView } from "../model/panel.ts";
import type { PanelProps } from "../state/ui.ts";
import { Icon } from "../ui/icons.tsx";
import { Glyph } from "../ui/primitives.tsx";

/** Props of Editor and RedoPanel. */
export interface EditorProps extends PanelProps {
	/** The module the open editor (`ui.s.editor`) is for. */
	mod: ModView;
}

/** `v1 → v2` inside a label: who wrote the current version, and that the next one is yours. */
function VersionStep({ cur }: { cur: VersionView }) {
	return (
		<span className="vchip" style={{ cursor: "default" }}>
			<Icon name={cur.by === "you" ? "user" : "bot"} size={12} />v{cur.v}
			<Icon name="arrowr" size={12} />
			<Icon name="user" size={12} />v{cur.v + 1}
		</span>
	);
}

/** `<div class="ed" id="edPanel">` for `ui.s.editor` of kind change or correct. */
export function Editor({ panel, ui, mod }: EditorProps) {
	const ed = ui.s.editor;
	if (!ed || ed.kind === "redo") return null;
	const field = (
		<textarea
			id="edText"
			className="field"
			rows={ed.kind === "change" ? 3 : 2}
			data-k="edtext"
			aria-labelledby="edH"
			placeholder={ed.kind === "correct" ? `What should ${mod.id} do differently?` : undefined}
			value={ed.text}
			onChange={(e) => ui.setEditorField("text", e.target.value)}
		/>
	);
	const cancel = (
		<button type="button" className="btn" data-k="edcancel" onClick={() => ui.closeEditor(false)}>
			Cancel
		</button>
	);
	if (ed.kind === "change") {
		return (
			// biome-ignore lint/a11y/useSemanticElements: the mockup's role="group" (a fieldset would restyle it)
			<div className="ed" id="edPanel" role="group" aria-labelledby="edH">
				<div className="lab" id="edH">
					<Icon name="edit" size={14} />
					Instructions for <span className="mono">{mod.id}</span>
					<VersionStep cur={mod.cur} />
				</div>
				{field}
				<div className="when">
					<Icon name="clock" size={14} />
					Used when {mod.id} starts
				</div>
				<div className="row">
					{cancel}
					<button type="button" className="btn primary" data-k="edsave" onClick={ui.saveEditor}>
						<Icon name="check" size={16} />
						Save as v{mod.cur.v + 1}
					</button>
				</div>
			</div>
		);
	}
	return (
		// biome-ignore lint/a11y/useSemanticElements: the mockup's role="group" (a fieldset would restyle it)
		<div className="ed" id="edPanel" role="group" aria-labelledby="edH">
			<div className="lab" id="edH">
				<Icon name="note" size={14} />
				Correction for <span className="mono">{mod.id}</span>
			</div>
			{field}
			<div className="when">
				<Icon name="clock" size={14} />
				{panel.now.when}
			</div>
			<div className="row">
				{cancel}
				<button type="button" className="btn primary" data-k="edsave" onClick={ui.saveEditor}>
					<Icon name="send" size={16} />
					Send correction
				</button>
			</div>
		</div>
	);
}

/** One graphic for the conversation rewind: kept modules | cut | the attempts the redo replaces. */
function RewindStrip({ k, preview }: { k: ModuleId; preview: RedoPreview }) {
	const { kept, affected } = preview;
	const label =
		`Conversation rewound to before ${k}, keeps ${preview.keepEvents} of ${preview.totalEvents} events. ` +
		(kept.length ? `Keeps ${joinAnd(kept)}. ` : "") +
		`Replaces ${joinAnd(affected.map((a) => `${a.id} attempt ${a.n}`))}.`;
	return (
		<span className="rw" role="img" aria-label={label}>
			{kept.map((id) => (
				<span key={id} className="chip keep mono" aria-hidden="true">
					<Icon name="check" size={12} />
					{id}
				</span>
			))}
			<span className="rwcut" aria-hidden="true">
				<Icon name="cut" size={14} />
			</span>
			{affected.map((a) => (
				<span key={a.attemptId} className="chip struck mono" aria-hidden="true">
					<Glyph status="replaced" size={12} />
					{a.id} #{a.n}
				</span>
			))}
		</span>
	);
}

/** `<section class="redo" id="redoPanel">` for `ui.s.editor` of kind redo. */
export function RedoPanel({ panel, ui, mod }: EditorProps) {
	const ed = ui.s.editor;
	if (ed?.kind !== "redo") return null;
	const k = mod.id;
	const preview: RedoPreview = redoPreview(panel, k) ?? {
		moduleId: k,
		attemptId: mod.attemptId ?? "",
		kept: [],
		affected: [],
		files: [],
		running: panel.running,
		cutRow: "",
		keepEvents: 0,
		totalEvents: panel.events.length,
	};
	const running = preview.running;
	return (
		<section className="redo" id="redoPanel" aria-labelledby="redoH">
			<div className="redo-h">
				<Icon name="undo" size={18} />
				<h3 id="redoH">
					Redo from <span className="mono">{k}</span>
				</h3>
				<span className="spacer" />
				<button
					type="button"
					className="ib"
					aria-label="Close redo"
					data-tip="Close"
					data-k="redox"
					onClick={() => ui.closeEditor(false)}
				>
					<Icon name="x" size={18} />
				</button>
			</div>
			<div>
				<label className="lab" htmlFor="rdText">
					Instructions <VersionStep cur={mod.cur} />
				</label>
				<textarea
					id="rdText"
					className="field"
					rows={3}
					data-k="rdtext"
					value={ed.text}
					onChange={(e) => ui.setEditorField("text", e.target.value)}
				/>
			</div>
			<div>
				<label className="lab" htmlFor="rdNote">
					What went wrong
				</label>
				<input
					id="rdNote"
					className="field"
					data-k="rdnote"
					value={ed.note}
					placeholder="Optional"
					autoComplete="off"
					onChange={(e) => ui.setEditorField("note", e.target.value)}
				/>
			</div>
			<ul className="cq" aria-label="What this redo will do">
				<li>
					<span className="ci">
						<Icon name="undo" size={16} />
					</span>
					<span className="k">Restore</span>
					<span className="chips">
						{preview.files.length ? (
							preview.files.map((p) => (
								<span key={p} className="chip mono rst" role="img" aria-label={`Restore ${p}`}>
									<Icon name="file" size={12} />
									{p}
									<Icon name="undo" size={12} />
								</span>
							))
						) : (
							<span className="muted">—</span>
						)}
					</span>
				</li>
				<li>
					<span className="ci">
						<Icon name="history" size={16} />
					</span>
					<span className="k">Rewind</span>
					<RewindStrip k={k} preview={preview} />
				</li>
				<li>
					<span className={running ? "ci bad" : "ci"}>
						<Icon name={running ? "stop" : "idle"} size={16} />
					</span>
					<span className="k">Agent</span>
					<span>
						<span aria-hidden="true">{running ? "Stops now" : "Idle"}</span>
						<span className="sr-only">
							{running ? "The agent is stopped now and waits until idle" : "The agent is idle, nothing to stop"}
						</span>
					</span>
				</li>
			</ul>
			<div className="row">
				<button type="button" className="btn" data-k="rdcancel" onClick={() => ui.closeEditor(false)}>
					Cancel
				</button>
				{/* while the server sets up a redo, another one would be refused */}
				<button
					type="button"
					className="btn danger"
					data-k="rdgo"
					aria-disabled={panel.busy || undefined}
					onClick={ui.redoGo}
				>
					<Icon name="undo" size={16} />
					{running ? "Stop & redo" : "Redo"} from {k}
				</button>
			</div>
		</section>
	);
}
