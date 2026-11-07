# Refined Project Design

**Visible and Controllable Modules for Human Oversight of Coding Agents** (Alexia Huang & Qi Wu, CS329Z)

This document turns the [proposal](proposal.pdf) into a buildable design on top of the
[pi coding agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent` v1.4).
It records the decisions we have made, the reasoning behind them, and the questions still open.

---

## 0. Summary

A single pi agent works on a small Python repository. As part of its normal tool use it
**declares a module plan**, then **starts and finishes modules** through three extension tools.
The extension tags every tool call with the active module, takes a workspace snapshot at every
module boundary, and streams an append-only **trace** to a web UI. The UI renders the trace two ways:

- **Modular view** (treatment): a shared Now bar, the plan drawn as a Metro line of module
  stations, and a module card with done-when criteria, files and tests. The full evidence is one
  level down (§6).
- **Log view** (baseline): a searchable chronological log of the _same_ events under the _same_
  Now bar, with the _same_ controls.

At any module boundary the user can pause the agent, edit a module's instructions, or request a
revision. A revision rewinds the conversation (pi's session tree) and the workspace (git snapshot)
together, invalidates later attempts, and re-runs from there.

### What changed from the proposal

| Proposal                                               | Refinement                                                                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "An adapter records tool calls…"                       | Concretely a pi extension (`packages/extension`) using `tool_call` / `tool_result` / `message_end` hooks, plus three module tools.                                                                                  |
| "Agent explicitly announces module transitions"        | Transitions are **tool calls** (`start_module`, `finish_module`). This makes them structured, gives us a natural place to pause (the tool just waits), and puts them in pi's session tree so we can rewind to them. |
| "Pause at module boundaries"                           | Three boundary kinds: after `plan_modules`, at `start_module`, at `finish_module`. Both conditions also have an emergency **Stop** (abort).                                                                         |
| "Restore conversation state with a workspace snapshot" | `session.navigateTree(entryBeforeStart)` + a shadow-git checkpoint (`git --git-dir=<run>/snapshots.git`) that never touches the task repo's own `.git`.                                                             |
| "Equivalent information and controls" in the baseline  | Made precise as an **equivalence contract** (§6.3): the same agent with the same module protocol in both conditions, the same trace, one shared state reducer; only organization and navigation differ.             |
| Tasks in public repos                                  | Python + pytest only; hidden behavioral tests; seeded failures injected **at runtime** so the traces stay coherent (§8).                                                                                            |

---

## 1. Research questions and hypotheses

- **RQ1 — Understanding.** With the modular view, do developers more accurately identify the
  agent's current goal, what has been completed, and which changes depend on which?
  _H1: comprehension rubric score is higher with the modular view at equal or lower time._
- **RQ2 — Error localization.** Do developers detect seeded or natural errors more often, and
  localize their _origin_ (module/action) and _affected changes_ more accurately, without more
  false alarms on clean traces?
  _H2a: detection and localization accuracy are higher. H2b: the false-alarm rate on clean traces is not meaningfully higher._
- **RQ3 — Intervention.** Given a live run with an error, do developers correct it more often
  within a fixed time budget, with fewer unnecessary interventions and no more regressions?
  _H3: correction success is higher, with no increase in unnecessary interventions._

RQ1 and RQ2 come from the **trace-inspection study** (replayed traces). RQ3 comes from the
**interactive intervention study** (live runs started from a matched state).

---

## 2. System architecture

```
                     ┌──────────────────────────── packages/server (Node host) ───────────────────────────┐
 ┌──────────────┐ WS │  RunManager ── creates run dir, workspace copy, applies seeded failure             │
 │ packages/web │◄──►│     │                                                                               │
 │  ModularView │    │     ├─ pi AgentSession (SDK, OpenRouter model)                                      │
 │  LogView     │    │     │     └─ modules extension (packages/extension) ── emits TraceEvents ──┐       │
 │  Replay      │    │     ├─ BoundaryGate   (pending pause ⇄ UI decisions)                       │       │
 └──────────────┘    │     ├─ Checkpointer   (shadow git snapshots of workspace)                  ▼       │
                     │     └─ TraceStore     runs/<id>/trace.jsonl  (+ pi session JSONL, raw events)       │
                     └─────────────────────────────────────────────────────────────────────────────────────┘
 packages/protocol: TraceEvent types + reduceTrace(): shared by extension, server, and both UI views.
 tasks/:    Python task suite (repo, prompt, hidden tests, seeded failures) + grading script.
 analysis/: Python analysis of traces and study data.
```

**Why the SDK host rather than pi's TUI or RPC mode.** The study needs one controlled web UI for
both conditions, and the controller needs direct access to `navigateTree`, `abort` and `steer`. Running pi
in-process through the SDK gives us all of that with no protocol translation. The extension stays
a normal pi extension, so it also works in the stock CLI (`pi -e packages/extension/src/cli.ts`)
for debugging, writing its trace to `.vcm/trace.jsonl` and auto-continuing at boundaries.

**Where the panel runs (D6).** In the study, pi runs headless inside our host, and the web panel is
the only window and the only controller. We rejected three alternatives:

| Alternative                                     | Why not                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The panel inside pi's terminal UI               | pi's screen is a fixed vertical stack. Extension widgets are full-width bands capped at 10 lines, overlays cover the chat, and full screens are modal, so the Now bar, plan and card cannot stay on screen together. pi's chat is itself a chronological log, so the treatment would contain the baseline. |
| A web panel attached to a live terminal session | pi removed its multi-client stack in 1.2.0, so we would own the bridge. Esc and `/tree` in the terminal would race with the panel's pause and rewind.                                                                                                                                                      |
| pi rebuilt as a web app                         | There is no maintained base. It is weeks of work that do not answer the research question, and it puts a chronological chat back inside the modular view.                                                                                                                                                  |

How the browser talks to the host:
- The browser sends **intents**. The host runs them one at a time. Each intent carries the state version it was based on, so a stale click shows a conflict instead of acting on the wrong module.
- Because `bindExtensions` accepts a `uiContext`, any pi dialog becomes a card in the panel instead of a hidden terminal prompt.
- The same extension adds a small terminal layer when it runs in stock pi (§6.4).

### pi integration points

| Need                                      | pi mechanism                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Module protocol instructions              | `before_agent_start` → append a system-prompt section                                                   |
| Declare/revise plan, start/finish modules | `pi.registerTool()` ×3 (`plan_modules`, `start_module`, `finish_module`)                                |
| Attribute actions to the active module    | `tool_call` (start), `tool_result` (end, `details.diff` from `edit`/`write`), `toolCallId` as action id |
| Agent narration per module                | `message_end` (assistant text)                                                                          |
| Pause at boundaries                       | the boundary tool's `execute()` awaits the host's `BoundaryGate`                                        |
| Deliver mid-module instruction edits      | `session.steer()` (enters after the current turn)                                                       |
| Rewind conversation                       | `session.navigateTree(entryId, { summarize: false })` while idle                                        |
| Persist module state in the session       | `pi.appendEntry("vcm", event)`, so the pi session JSONL alone can rebuild the module state              |
| Omission audit                            | `session.subscribe()` raw events → `raw.jsonl`, diffed against trace actions                            |
| Deterministic tests                       | `registerFauxProvider()` from `@earendil-works/pi-ai/compat`                                            |

---

## 3. Module protocol (what the agent sees)

The extension adds this contract to the system prompt (abbreviated):

1. Orient briefly (read a few files). Then call **`plan_modules`** with 2–7 modules. Each module
   is a task-specific subgoal with `title`, `purpose`, `instructions`, `inputs`, `outputs`,
   `dependsOn` (declared prerequisites), and `validation` (how you will know it is done).
2. Work on **exactly one module at a time**: `start_module(id)` → explore/edit/test →
   `finish_module(id, status, summary, outputs, validation[])`.
3. If you learn something that changes the plan, call `plan_modules` again. Keep the ids of
   modules that persist, and add or drop the others. Earlier definitions and attempts are kept, and a
   re-plan that repeats a module unchanged keeps the user's edit to it.
4. The result of `start_module` is the **authoritative** instruction for that module. It may
   contain edits from the user. Follow them.
5. A boundary call may take a while (the user may be reviewing). Never work around it.

**Enforcement.** The extension never blocks normal tools by default. Actions taken with no active module are
recorded as **unassigned** (shown in both views, as the proposal requires). A file change outside a module
(before the plan or between modules) gets a one-line reminder appended to its result, and so does a file
change made with a shell command (redirection, heredoc, `sed -i`…) inside a module, since only `edit`/`write`
give exact diffs. `plan_modules` requires 2–7 modules (schema), and `start_module` while another module is
active returns an error that tells the agent to finish the current one first. An opt-in **light gate**
(`VCM_GATE_EDITS=1`, `npm run record -- --gate`) blocks `edit`/`write` outside a module. **Protocol
compliance** is itself reported per run (`npm run record`): the % of actions assigned after the plan, the
number of plan revisions, the mean actions per attempt, flags, the audit, cost and the grade.

_First live results (claude-sonnet-5.5, toy task, Nov 4)._ With the first prompt the model skipped the
protocol entirely and wrote every file with one bash heredoc (0 modules, 3 unattributed changes). Making the
protocol explicitly required, reminding before the plan and on shell writes, and requiring 2–7 modules
fixed it: 2 modules, 100% of actions assigned, 0 unattributed changes, 0 missing actions, with or without
the gate. The model ignored the planted `docs/CONTRIBUTING.md`, so strong models need subtler seeded failures.

**Granularity guidance.** We target 3–6 modules for a 15–30-minute task. Pilot runs will show
whether we need stronger prompting or a minimum/maximum module size.

---

## 4. Data model

All of this is defined in [`packages/protocol/src/model.ts`](../packages/protocol/src/model.ts).

- **Module** — stable `id` (`M1`, `M2`, …). Identity never changes across revisions.
- **ModuleVersion** — `(moduleId, version)` → `title, purpose, instructions, skills[], inputs[],
  outputs[], dependsOn[], validation[]`, `author: agent|user`, `reason`. A user edit or an agent
  re-plan creates a new version, and old versions are never mutated.
- **PlanVersion** — ordered list of module ids + rationale. The Metro line shows the latest plan, and
  plan diffs (added/dropped/reordered) are shown in the UI.
- **Attempt** — one execution of one module version: `attemptId, moduleId, moduleVersion, n`,
  `status: running|completed|failed|invalidated|abandoned`, `startCheckpoint`, `endCheckpoint`,
  `startEntryId` (pi session entry to rewind to), summary, outputs, and per-criterion validation results.
  A module's attempts appear on its card. After a redo, replaced attempts stay visible as slashed.
- **Action** — one tool call: `actionId (= toolCallId), attemptId | null, tool, args, result
  preview, isError, fileChanges[], test?`.
- **Dependencies**, three labeled kinds:
  - _declared_: `dependsOn` from the module definition;
  - _recorded_: attempt B read or edited a file last written by attempt A (from action records);
  - _inferred_: anything heuristic. It is always drawn differently and labeled "inferred".
- **Checkpoint** — shadow-git commit of the workspace at a boundary, linked to `(attemptId,
  sessionEntryId, planVersion)`.
- **Intervention** — `pause | resume | edit_instructions | note | revise | stop`, with target and payload.

**Trace = append-only list of `TraceEvent`s** (`seq`, `t`, `type`, payload). Both views compute
their state with the same `reduceTrace(events)`. Replay at time _t_ is simply
`reduceTrace(events.slice(0, k))`.

---

## 5. Execution capture and audit

- **Per-action capture** (extension): tool name, arguments, timing, error flag, a result preview
  (truncated), and file changes. `edit`/`write` give exact diffs through `details.diff`. `bash` can
  change files invisibly; those changes are caught at the next checkpoint.
- **Per-attempt diff**: `git diff startCheckpoint endCheckpoint` in the shadow repo. Any file changed
  in that diff but not covered by an `edit`/`write` action becomes an **unattributed change**
  (usually from `bash`, e.g. `sed -i` or a formatter).
- **Tests**: a `bash` command matching the task's `test_command` pattern (default `pytest`) is
  parsed for passed/failed counts. _Open question Q5:_ add a dedicated `run_tests` tool for exact capture.
- **Omission audit**: the host records raw pi events (`raw.jsonl`). At run end it checks that every
  `tool_execution_end` has a trace action and that every file changed between the first and last
  checkpoint is attributed or flagged. The audit is shown in both views and reported in the paper.
  Tool calls pi rejects before any extension hook runs (invalid arguments) are recorded by the host from
  the raw events, marked `source: "host"`, so failed attempts are evidence too.

---

## 6. Interfaces

The panel is a local web page served by our host (D6). Both conditions share the page, the
**Now bar** and every control. Only the area under the bar differs. The chosen design (D7) is the
clickable mockup [`design/mockups/panel.html`](../design/mockups/panel.html). Open it directly in a
browser; its floating MOCKUP pill switches the state, the view and the theme.

**Hide complexity by hierarchy.** Each level answers one question and has one primary action. Esc goes up a level.

| Level                | Answers                                | Shows                                                                                                                                                                                            | Kept one level down           |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| L0 Now bar (shared)  | What is it doing? Does it need me?     | State glyph, active module, current action (icon + object), flag count, pause-at-next-boundary, note to agent, Stop. _Treatment only:_ segmented progress and "next: Mk".                        | ids, tokens, cost             |
| L1 Metro line        | How far along? Where is trouble?       | Modules as stations in plan order (status glyph, short label), one compact evidence graphic each, dependency arcs, and the pause marker on the boundary where the agent will wait.               | instructions, full titles     |
| L2 Module card       | What does "done" mean? Is there proof? | Goal; done-when criteria with their source (agent says / tests show); files with diff bars; latest tests as pips; files looked at; activity strip; instruction version chip; one primary button. | single actions, diff contents |
| L3 Evidence          | Exactly what happened?                 | Typed action rows (routine reads fold, edits and failures never do), your notes and corrections where they reached the module, the diff, test output, instruction versions.                      | raw JSON                      |
| L4 Raw (researchers) | —                                      | Events and ids.                                                                                                                                                                                  | —                             |

**Only one thing interrupts.** When the agent waits at a boundary, the Now bar turns amber and
becomes a decision card. The card shows a waiting timer and what just happened, as a glyph and a
short phrase. It offers **Continue to Mk** (primary), **Change Mk first**, **Redo Mj** and **Stop**
(§7). Nothing else in the panel animates or changes colour to get attention.

**Graphics before words.** A graphic carries the meaning wherever it can. Every graphic and icon
button also has a text alternative (aria label or visually hidden text), so accessibility costs no
visible words. Status is always a **shape plus a colour**:

| Status                                                                                                                                                                                                                        | Glyph                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| verified (a passing test after the module's last edit, in the same attempt; a file changed only by a shell command counts that command as the edit; a module that changed nothing and ran no failing test counts as verified) | filled circle with check |
| done, unverified (claimed done; no passing test after its last edit)                                                                                                                                                          | half-filled circle       |
| working                                                                                                                                                                                                                       | ring with a moving arc   |
| waiting at a boundary                                                                                                                                                                                                         | diamond                  |
| pending                                                                                                                                                                                                                       | hollow circle            |
| failed                                                                                                                                                                                                                        | circle with ×            |
| replaced by a redo                                                                                                                                                                                                            | slashed circle           |
| stopped by you                                                                                                                                                                                                                | rounded square           |
| run finished                                                                                                                                                                                                                  | end bar (line terminus)  |

**Flags are quiet and neutral.** The Now bar has one count, hidden at zero. Five fixed rules raise it:

1. tests failing after the module's last edit (the latest test run after it);
2. claimed done without a passing test after its last edit (one flag per module: a finished module with failing tests gets this one), or never finished at all (the agent ended without `finish_module`);
3. a file changed by `bash` (an unattributed change, §5);
4. an edit outside any module (unassigned);
5. stuck: 10 actions in a row without progress in the running module. Progress is an edit, a better test
   result, or a file read or command not seen before in that attempt.

All of this (statuses, criteria sources, flags, pause slots, the decision card) is computed once in
`packages/protocol/src/derive.ts` from the shared reducer's state, so both views show the same thing.

Flags are on in both conditions. Pilots also run with them off (Q10).

The visual system follows UI-UX-Pro-Max "Minimalism & Swiss Style":
- IBM Plex Sans and JetBrains Mono;
- a dark default and a separately tuned light theme;
- text contrast ≥ 4.5:1 and meaningful non-text contrast ≥ 3:1 in both themes;
- one outline icon family;
- reduced motion honoured.

### 6.1 Modular view (treatment)

**Now bar, Metro line, module card.**
- The line starts with a small **before plan** station. It holds what the agent did before `plan_modules` (reads, `ls`), so nothing is unassigned by default.
- Selecting a station focuses its card and highlights the stations it depends on and the ones that depend on it.
- `j`/`k` move along the line. Enter opens the evidence. Esc goes back up one level (expanded step → evidence → station) and returns focus to whatever opened the level.
- The card shows the active or waiting module by default. When the run has finished and nothing is selected, it shows a run summary: run time, the flags, and the whole-run files with the modules that changed them.
- The card's primary button depends on the module's state: **Change Mk…** (not started), **Correct Mk…** (running, delivered with `steer`), **Redo from Mk…** (finished).
- While the plan can still be shaped before its work starts (the hold after the plan, and until its first module starts; also the hold after a re-plan), a **plan overview** sits between the line and the card: the agent's rationale as one lead line, then one row per module with its status on a vertical rail, id, title, purpose, what it needs first and how many done-when criteria check it (named in the row's tooltip). A row selects that module's card, like its station; its **Change Mk…** opens the card's editor. It folds away once a module starts.

**Redo from a module** opens beside the card. It has three parts:
- the module's instructions, ready to edit (the result becomes the next version);
- an optional "what went wrong" note;
- a **consequence preview** drawn as graphics: which files are restored, where the conversation is cut (also drawn on the Metro line itself), which attempts are replaced, which modules are kept, and whether the agent must be stopped first.

Replaced attempts stay visible afterwards as slashed stations or chips, so the history of revisions survives (§7).

### 6.2 Log view (baseline)

The same Now bar and controls (minus segmented progress and "next"). Under it is one chronological
list of every trace event: time, module tag, event icon, a one-line summary, and expandable details
(args, diff, test output). It has filter chips (module, event type, flagged) and search, as in a good
log viewer. Module plan, `start_module` and `finish_module` events are ordinary rows. The same
interventions are reachable from rows:
- **Change Mk** on plan rows;
- **Correct** on the active module's rows;
- **Redo from Mk…** on a module's start and finish rows, with the same consequence preview.

Your own interventions (instruction versions, corrections, notes, pauses, Stop) are rows too, in the
order you made them. While live, the log opens at its newest row.

The log adds no per-module aggregates (no plan overview, no status summary) beyond what a single row contains.

### 6.3 Equivalence contract (both conditions)

|                                                                             | Modular                                           | Log                            |
| --------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------ |
| Agent, prompt, module protocol, model, budget                               | same                                              | same                           |
| Events, diffs, test results, plan & instruction text                        | same (same reducer)                               | same                           |
| Now bar: state, active module, current action, flags                        | ✓                                                 | ✓                              |
| Decision card when waiting (Continue / Change / Redo / Stop)                | ✓                                                 | ✓                              |
| Pause at next boundary, note to agent, Stop                                 | ✓                                                 | ✓                              |
| What you sent (notes, corrections), reviewable later                        | note popover + the Steps of the module it reached | note popover + its rows        |
| Module tag on every action                                                  | station + card                                    | column                         |
| Dependencies (declared/recorded)                                            | arcs on the line                                  | fields on plan and module rows |
| Change a future module's instructions                                       | its card (also from its plan overview row)        | its plan row                   |
| Correct the running module                                                  | its card                                          | its rows                       |
| Redo from a module (rewind), with consequence preview                       | its card                                          | its start/finish row           |
| Segmented progress, "next", Metro line, module card, plan overview, summary | ✓                                                 | — (this is the manipulation)   |
| Replay scrubber (trace study)                                               | ✓                                                 | ✓                              |

The _only_ manipulated factor is organization and navigation: the Metro line and module-card
hierarchy versus a flat log.

### 6.4 Terminal layer (stock pi; not a study condition)

When the extension runs in the normal pi CLI (`pi -e packages/extension/src/cli.ts`), it adds a
small terminal layer:
- `pi.setLabel` on each module start, so `/tree`'s labeled-only filter becomes a module outline;
- a one-line status ("M3/5 · 2 verified").

It also writes the trace, which the web panel can open afterwards. This layer is for demos, our own
use and the study debrief. A live, read-only panel that tails a terminal session's trace is a cheap
later addition. A live panel with its own controls is not planned (§2).

---

## 7. Intervention controller

**Boundaries.** `after_plan`, `before_start(Mi)`, `after_finish(Mi)`. The boundary tool calls
`host.boundary(request)`, which resolves at once unless _pause at next boundary_ is armed (or
auto-pause after the plan is on). The armed pause is **one-shot**: it holds the agent at the next boundary
and disarms, so Continue goes on into the next module instead of stopping again at its start; Stop and the
end of the run also disarm it. While paused, the UI shows the pending boundary and these choices:

| Decision                      | Effect                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Continue**                  | tool returns normally                                                                                                                                          |
| **Edit & continue**           | creates new `ModuleVersion`(s) with `author: user`; `start_module` returns the edited instructions marked as user edits; a note is appended to the tool result |
| **Revise module Mk** (rewind) | see below                                                                                                                                                      |
| **Stop**                      | `session.abort()`                                                                                                                                              |

Edits to the **active** module while it is running go through `session.steer()`, labeled as a
user instruction update, and also create a new version. A **correction** for the running module (the card's
**Correct Mk…**) and a **note to agent** (both conditions) are delivered with `steer()` after the current
turn and recorded as `correct` / `note` interventions. When pi appends the steered message to the
conversation, the host records `intervention_delivered`, so the panel can show what is still queued.

In the UI's decision card these choices appear as:
- **Continue to Mk**;
- **Change Mk first** (edit & continue);
- **Redo Mj** (revise);
- **Stop**.

Each module card and log row offers the same edit and revise actions outside a pause (§6).

**Revise (rewind) semantics.** This is the proposal's "conservative rerun."

1. The boundary tool returns `terminate: true`, and the host waits for `agent_settled`. If the user
   asks for a redo while the agent is running, the host first calls `session.abort()` and waits
   for idle. The confirm button then reads **Stop & redo**, so the order is always the same:
   stop → idle → restore → rewind → prompt.
2. Every attempt that _started after_ Mk's target attempt is marked `invalidated`, whether or not it
   declared a dependency. Being conservative here keeps the restore correct; the dependency info is
   only used to explain the invalidation in the UI.
3. Workspace ← `Mk.startCheckpoint` (shadow-git `reset --hard` + `clean`, excluding `.venv` etc.).
4. Conversation ← `session.navigateTree(Mk.startEntryId, { summarize: false })`. If the redo goes back past a
   re-plan, the plan order and the module definitions are restored as they were at Mk's start checkpoint
   (later user edits are kept). This is the entry
   just before the assistant message that called `start_module(Mk)`.
5. New `ModuleVersion` for Mk with the user's revision instructions. Then the host prompts:
   *"The user revised Mk; the workspace was restored to before Mk. Call start_module(Mk)."*

The trace keeps everything. Invalidated attempts stay visible, greyed out, so the history of
revisions and repeated attempts is preserved as the proposal requires.

---

## 8. Tasks, seeded failures, grading

- **Source**: small, pinned, public Python repos (≲5k LOC, fast pytest suite, no network), plus one
  local toy task for development. Each task is a small feature addition or bug fix that naturally
  decomposes into 3–6 modules.
- **Task spec** (`tasks/<id>/task.yaml`): id, split (`pilot|eval`), source (local dir or git URL +
  commit), human-written requirements prompt, visible test command, hidden tests directory,
  selection notes, and seeded-failure variants.
- **Seeded failures, injected at runtime** so the resulting trace is a real, coherent agent run:
  - `prompt_override` — omitted or misstated requirement;
  - `file_overlay` — a plausible but wrong doc or comment in the repo (e.g. wrong units or signature);
  - `read_rewrite` — a `tool_result` rewrite of a specific file read (incorrect API assumption).
    Each variant records its **origin** (which seed), the **expected affected changes**, and a
    human-reviewed annotation of where it actually surfaced in the trace.
- **Grading**: `tasks/grade.py` runs hidden tests plus the repo's original tests (regressions) on a
  copy of the final workspace. A blinded human review covers the requirements the tests miss.
- Natural and seeded failures are analyzed separately. Pilot tasks are never used in the eval set.

---

## 9. Evaluation

### 9.1 Trace-inspection study (RQ1, RQ2)

- **Materials**: recorded traces (clean / natural failure / seeded failure) from the eval tasks.
  Each is replayed to a fixed **probe point** (the scrubber is locked to "now"), then optionally to the end.
- **Probes**: (a) what is the agent trying to do right now? (b) which changes are done, and why?
  (c) if X were wrong, which changes would be affected? (d) is there an error? If yes, where did
  it originate (module/action) and what did it affect? (e) confidence 1–5.
- **Measures**: rubric score (pre-registered, double-coded on a subset, κ reported), detection
  hit rate, localization accuracy (origin and affected set), false alarms on clean traces, and time per probe.

### 9.2 Interactive intervention study (RQ3)

- Start from a **matched state**: the same pi session file + workspace checkpoint, resumed in either
  condition, with a seeded error already in play. A fixed intervention budget (e.g. 8 min) and a
  fixed agent budget (tokens/tool calls).
- **Measures**: correction success (hidden tests pass for the target requirement, other
  requirements preserved, no regressions), time to first intervention, number of unnecessary
  interventions, and final quality (tests + blinded review).

### 9.3 Design and analysis

- Pilot with 3–4 developers. Target 12–16 participants familiar with coding agents. Within-subject
  with interface order counterbalanced, distinct matched tasks per condition, and task–interface
  pairing balanced with a Latin square.
- Mixed-effects models (logistic for accuracy/success, log-linear for time) with random intercepts
  for participant and task; paired effects with bootstrap 95% CIs. Rubrics and analysis are fixed
  before the main study, and inconclusive results are reported as such.
- Session ≈ 60–75 min: consent and tutorial (10) → trace study, both conditions (30) → intervention
  study (25) → SUS/NASA-TLX + interview (10).

---

## 10. Risks and mitigations

| Risk                                                 | Mitigation                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent ignores or misuses the module protocol         | Compliance metrics; nudges on unassigned actions; a model bake-off on pilot tasks (milestone day 3); stronger prompt or a light gate if needed |
| Module granularity varies across runs                | The trace study uses fixed recorded traces; granularity guidance in the prompt; report the distribution                                        |
| Rewind restores code and conversation inconsistently | One checkpoint per boundary, keyed to a session entry id; automated faux-provider test of the full revise path; exclude `.venv`/caches         |
| Baseline is a straw man                              | Equivalence contract (§6.3); the log gets real search/filters; pilot participants rate it                                                      |
| Recruitment / time per session                       | Pilot measures duration early; trim to the trace study if needed (RQ1–2 are the core)                                                          |
| Cost                                                 | `--budget` per run, token usage in the trace; cache replay traces rather than re-running                                                       |
| Human-subjects requirements                          | Ask course staff about IRB and consent **this week** (Q8)                                                                                      |

---

## 11. Decisions so far

- **D1** Build on pi v1.4 via the **SDK host**; the module logic is a normal pi extension.
- **D2** Models through **OpenRouter** (`OPENROUTER_API_KEY`), chosen in `config` and swappable. The exact model is picked after the day-3 bake-off.
- **D3** Task repos are **Python + pytest**.
- **D4** Baseline uses the **same module-announcing agent**; module events appear as log rows.
- **D5** Midway milestone is **~1 week out** (early Nov). See [milestone.md](milestone.md).
- **D6** The study panel is a **web page on our SDK host**, and the host is the only controller.
  Stock pi gets a small terminal layer for demos and the debrief, not a study condition (§2, §6.4).
- **D7** The panel uses the four-level hierarchy with the **Metro line** for the plan (§6). It was chosen from
  three explored directions (rail, Metro line, tiles). See [`design/mockups`](../design/mockups/README.md).
- **D8** Both conditions share a Now bar showing the **state and the active module**. Only segmented
  progress and "next" are treatment-only.
- **D9** **Note to agent** exists in both conditions.
- **D10** **Flags** (five neutral rules, §6) are on in both conditions. Pilots compare on vs. off (Q10).
- **D11** "Pause at next boundary" is one-shot (§7).
- **D12** Each run picks its agent: the configured model, or a **scripted demo agent** for the toy task
  (`packages/server/src/demo-agent.ts`). The scripted agent is a small policy over the conversation, so it
  reacts to redo, change-first, corrections and notes. It needs no API key and backs up the live demo.

## 12. Open questions (to discuss)

- **Q1 Pause granularity.** Boundaries + Stop only (proposal), or also "pause before next action"
  in both conditions? _Recommendation:_ boundaries + Stop for the study, with per-action pause as a debug-only flag.
- **Q2 Rewind context.** Pure rewind (agent forgets the abandoned attempt) or rewind plus a
  branch summary (`navigateTree(..., { summarize: true })`)? _Recommendation:_ pure rewind plus the
  user's revision note in core; the summary variant becomes a condition in extension 1.
- **Q3 Structural plan edits.** Can users add/drop/reorder modules, or only edit a module's
  instructions? _Recommendation:_ instructions + validation in core; structural edits after the milestone if pilots ask for them.
- **Q4 Invalidation scope.** Conservative (everything after Mk) vs. dependency-based.
  _Recommendation:_ conservative for correctness, with dependency-based shown only as an explanation.
- **Q5 Test capture.** Parse `pytest` from `bash`, or add a `run_tests` tool? _Recommendation:_ add
  `run_tests` (same command, structured result) and still parse bash as a fallback.
- **Q6 Probe placement in the trace study.** Fixed probe points per trace (e.g. mid-module 3) vs.
  participant-driven exploration. _Recommendation:_ fixed probes for comparability.
- **Q7 Who are participants?** CS329Z classmates vs. outside developers, and how is "familiar with coding agents" screened?
- **Q8 IRB / consent / compensation.** Confirm with course staff what's required for a class study.
- **Q9 Division of labor.** See the suggested split in [milestone.md](milestone.md).
- **Q10 Flags in the study.** Keep the five flags on in both conditions, or turn them off? With flags on, the study measures the panel's
  structure on top of shared hints. With flags off, it measures the structure alone. _Recommendation:_ pilot both, and keep them on
  unless pilots show participants just follow the flags.

## 13. Optional extensions (unchanged in spirit)

1. **Cheaper self-correction**: agent-driven module revision vs. ordinary feedback vs. full restart
   under matched budgets (task success, tokens, tool calls, recovery time). The rewind machinery is
   already the hard part.
2. **Module reuse**: save validated module procedures as pi skills and reuse them on held-out similar tasks.
