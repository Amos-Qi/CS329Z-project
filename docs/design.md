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

- **Modular view** (treatment): a module graph with status, a linked timeline of attempts, and a
  detail pane with purpose, versioned instructions, actions, diffs and checks.
- **Log view** (baseline): a searchable chronological log of the _same_ events, with the _same_ controls.

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
   modules that persist, and add or drop the others. Earlier definitions and attempts are kept.
4. The result of `start_module` is the **authoritative** instruction for that module. It may
   contain edits from the user. Follow them.
5. A boundary call may take a while (the user may be reviewing). Never work around it.

**Enforcement.** The extension never blocks normal tools. Actions taken with no active module are
recorded as **unassigned** (shown in both views, as the proposal requires) and the tool result gets a
one-line reminder appended. `start_module` while another module is active returns an error that
tells the agent to finish the current one first. **Protocol compliance** is itself reported per run:
the % of actions assigned, the number of plan revisions, and the mean actions per module.

**Granularity guidance.** We target 3–6 modules for a 15–30-minute task. Pilot runs will show
whether we need stronger prompting or a minimum/maximum module size.

---

## 4. Data model

All of this is defined in [`packages/protocol/src/model.ts`](../packages/protocol/src/model.ts).

- **Module** — stable `id` (`M1`, `M2`, …). Identity never changes across revisions.
- **ModuleVersion** — `(moduleId, version)` → `title, purpose, instructions, skills[], inputs[],
  outputs[], dependsOn[], validation[]`, `author: agent|user`, `reason`. A user edit or an agent
  re-plan creates a new version, and old versions are never mutated.
- **PlanVersion** — ordered list of module ids + rationale. The graph shows the latest plan, and
  plan diffs (added/dropped/reordered) are shown in the UI.
- **Attempt** — one execution of one module version: `attemptId, moduleId, moduleVersion, n`,
  `status: running|completed|failed|invalidated|abandoned`, `startCheckpoint`, `endCheckpoint`,
  `startEntryId` (pi session entry to rewind to), summary, outputs, and per-criterion validation results.
  The **timeline** is the list of attempts; the **graph** is the current plan.
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

---

## 6. Interfaces

### 6.1 Modular view (treatment)

- **Graph** (React Flow): nodes are modules from the latest plan, colored by status (pending, active,
  paused, completed, failed, needs-revision, invalidated). Solid edges are declared dependencies;
  dashed edges are recorded file dependencies; "inferred" edges are labeled.
- **Timeline**: attempts in execution order. Each attempt expands to its actions. Unassigned
  actions sit in their own lane. Selecting an attempt highlights its node, and selecting a node
  filters the timeline.
- **Detail pane**: purpose, instructions (a version selector, with diffs between versions),
  inputs/outputs, validation criteria and results, actions, the attempt's diff, and test runs.
- **Plan vs. execution**: plan-version history (added/dropped/reordered modules) and modules
  that were planned but never attempted, or attempted out of order.

### 6.2 Log view (baseline)

One searchable, filterable chronological table of every trace event: time, module tag, event type,
summary, and an expandable payload (args, results, diffs, test output). Module plan and
`start_module`/`finish_module` events appear as ordinary rows. Text search and filtering by
type/module are available, as in a good log viewer.

### 6.3 Equivalence contract (both conditions)

|                                                       | Modular             | Log                         |
| ----------------------------------------------------- | ------------------- | --------------------------- |
| Agent, prompt, module protocol, model, budget         | same                | same                        |
| Events, diffs, test results, plan & instructions text | same (same reducer) | same                        |
| Module tag on every action                            | node/lane           | column                      |
| Dependencies (declared/recorded)                      | edges               | fields on the module rows   |
| Pause at next boundary / Stop                         | ✓                   | ✓                           |
| Edit a module's instructions                          | from node           | from plan row               |
| Revise (rewind to before a module)                    | from attempt        | from its `start_module` row |
| Replay scrubber (trace study)                         | ✓                   | ✓                           |

The _only_ manipulated factor is organization and navigation: graph + linked timeline + detail versus flat log.

---

## 7. Intervention controller

**Boundaries.** `after_plan`, `before_start(Mi)`, `after_finish(Mi)`. The boundary tool calls
`host.boundary(request)`, which resolves at once unless _pause at next boundary_ is armed (or
auto-pause after the plan is on). While paused, the UI shows the pending boundary and these choices:

| Decision                      | Effect                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Continue**                  | tool returns normally                                                                                                                                          |
| **Edit & continue**           | creates new `ModuleVersion`(s) with `author: user`; `start_module` returns the edited instructions marked as user edits; a note is appended to the tool result |
| **Revise module Mk** (rewind) | see below                                                                                                                                                      |
| **Stop**                      | `session.abort()`                                                                                                                                              |

Edits to the **active** module while it is running go through `session.steer()`, labeled as a
user instruction update, and also create a new version.

**Revise (rewind) semantics.** This is the proposal's "conservative rerun."

1. The boundary tool returns `terminate: true`, and the host waits for `agent_settled`.
2. Every attempt that _started after_ Mk's target attempt is marked `invalidated`, whether or not it
   declared a dependency. Being conservative here keeps the restore correct; the dependency info is
   only used to explain the invalidation in the UI.
3. Workspace ← `Mk.startCheckpoint` (shadow-git `reset --hard` + `clean`, excluding `.venv` etc.).
4. Conversation ← `session.navigateTree(Mk.startEntryId, { summarize: false })`. This is the entry
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

## 13. Optional extensions (unchanged in spirit)

1. **Cheaper self-correction**: agent-driven module revision vs. ordinary feedback vs. full restart
   under matched budgets (task success, tokens, tool calls, recovery time). The rewind machinery is
   already the hard part.
2. **Module reuse**: save validated module procedures as pi skills and reuse them on held-out similar tasks.
