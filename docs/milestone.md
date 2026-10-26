# Midway Milestone Plan

**Assumed due:** early November (≈ 1 week from Mon Oct 26, 2026). _Confirm the exact date and the
deliverable format (demo, short report, slides) with course staff, then adjust the days below._

The proposal put capture and rendering in weeks 3–5 and interventions plus a pilot in weeks 6–7.
With one week left, the milestone is a **working end-to-end vertical slice** plus the **first
evidence that the study is feasible**, not a finished system.

## Definition of done

**Must have (demo-able):**

1. **Live run, end to end.** `npm run dev` → pick a task → the pi agent runs on a Python repo,
   declares modules, and starts/finishes them. Every tool call is attributed (or visibly
   unassigned) and the trace is saved to `runs/<id>/trace.jsonl`.
2. **Modular view.** Module graph with status and declared dependencies, an attempt timeline linked
   to the graph, and a detail pane (purpose, instructions with versions, actions, diffs, test results).
3. **Log view.** The same trace as a searchable chronological log, using the same reducer.
4. **Boundary intervention.** Pause at the next boundary → edit a module's instructions → continue;
   the edit shows up as a new version and in the agent's next `start_module` result.
5. **Checkpoints + audit.** A shadow-git snapshot at every boundary; per-attempt diff; an audit
   panel listing unattributed file changes and missing actions.
6. **Replay.** Open a recorded run with a scrubber, in both views. This is the trace-study harness.
7. **Pilot task set.** 3 tasks (1 toy + 2 from public Python repos) with hidden tests and a
   grading script, plus **1 seeded-failure variant** with an annotated origin.
8. **Feasibility evidence.** Protocol-compliance numbers for 2–3 OpenRouter models on the pilot
   tasks, and **1–2 informal walkthroughs** (classmates) of the trace view, with timing and notes.

**Stretch:** revise/rewind demonstrated live on one task; recorded file-dependency edges; `run_tests` tool.

**Explicitly after the milestone:** the full studies, the comparative analysis, the extensions.

## Two parallel tracks

The work splits into two tracks of roughly equal size that meet at the trace format
(`packages/protocol`). The tracks are only a suggestion; choose who takes which.

- **Track A — agent and backend:** `packages/extension`, `packages/server`. Module protocol
  prompt, capture hooks, BoundaryGate, Checkpointer, rewind, audit, model bake-off.
- **Track B — interface, tasks and study:** `packages/web`, `tasks/`, `study/`. Graph/timeline/detail,
  log view, replay scrubber, task curation, hidden tests, seeded failures, walkthrough protocol.

## Day-by-day

| Day           | Track A (agent/backend)                                                                   | Track B (UI/tasks/study)                                                       | Joint checkpoint                                               |
| ------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **Mon 10/26** | Repo set up (done). Run the faux smoke test; get one live OpenRouter run on the toy task. | Run `npm run dev`; read the trace schema; sketch graph/timeline/detail layout. | Agree on the trace schema (`packages/protocol`) and freeze v0. |
| **Tue 10/27** | Prompt tuning for protocol compliance; capture `edit`/`write` diffs; test parsing.        | Module graph + status colors; timeline grouped by attempt; selection linking.  | First live trace visible in the modular view.                  |
| **Wed 10/28** | Model bake-off (2–3 models × toy + 1 task × 2 runs): compliance, cost, success.           | Pick 2 public Python repos and write the task specs + hidden tests.            | Pick the model; email course staff re: IRB (Q8).               |
| **Thu 10/29** | Checkpointer + per-attempt diffs + audit; pause/edit/continue end to end.                 | Detail pane (instruction versions, diffs, tests); log view with search/filter. | Intervention demo works on the toy task.                       |
| **Fri 10/30** | Seeded-failure injection (`file_overlay`, `read_rewrite`); record pilot traces.           | Replay mode + scrubber in both views; walkthrough script + probe questions.    | Freeze the demo traces.                                        |
| **Sat–Sun**   | Stretch: live rewind; `run_tests` tool. Bug fixes.                                        | 1–2 walkthroughs with classmates; collect timing and notes.                    | Write the milestone report draft.                              |
| **Mon 11/2**  | Polish + record a backup demo video.                                                      | Polish + figures/screenshots.                                                  | Rehearse the demo; submit.                                     |

**If you fall behind,** cut in this order: stretch items → second public repo task →
log-view filters → audit panel UI (keep the JSON). Never cut items 1, 2, 4 or 6.

## Midpoint demo script (≈5 min)

1. _(30 s)_ Problem: long agent runs are hard to follow; show 60 lines of raw log.
2. _(90 s)_ Start the toy task live; the agent declares modules and the graph appears; click
   through the timeline to see actions and diffs for a module.
3. _(60 s)_ Arm "pause at next boundary"; at `start_module(M3)` edit its instructions; continue;
   show v2 of the instructions and the agent following them.
4. _(60 s)_ Replay a recorded seeded-failure trace in the modular view, then the log view, to show the
   study conditions and the equivalence contract.
5. _(60 s)_ Feasibility so far: compliance numbers, pilot walkthrough notes, next steps.

## Milestone report outline

1. Progress against the proposal timeline (what was cut or moved and why).
2. System architecture + the pi integration points (adapted from `design.md` §2).
3. Module protocol, plus compliance results from the bake-off.
4. Screenshots: modular view, log view, intervention flow.
5. Task set + seeded-failure method.
6. Pilot walkthrough observations; changes they triggered.
7. Revised plan to the final: study protocol, recruitment status, IRB status, analysis plan.
8. Risks.
