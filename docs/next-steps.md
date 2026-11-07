# Next steps after the midway check-in

Status of 2026-11-06. This records the follow-up list we agreed on, what each item means, what
already exists, the decisions made so far and the questions that are still open. Nothing here is
implemented yet unless it says so. Each item quotes the original wording.

Terms used below:

- **Host mode** (what we have today): our server embeds pi through its SDK, copies a fixed task
  repo into `runs/<id>/workspace`, sends the task prompt itself, and the web panel is the only
  window. This is the controlled setting of the user study.
- **Guest mode** (item 3): the user works in their own harness (the pi CLI, Claude Code, Codex)
  and our layer is a plugin inside it. It stays dormant during short chats; the agent switches it
  on for a long task, and then the panel opens with the same controls.

## Summary

| #   | Item                                         | Decided                                                 | Open                                                | Size   |
| --- | -------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- | ------ |
| 1   | Readable thinking blocks in the trace        | Record them and show them in both views                 | Where they sit in each view; providers without them | S      |
| 2   | Re-run only the affected range on a redo     | Borrow the idea from Alexia's repo, refine later        | How "affected" is decided; who confirms; conflicts  | M–L    |
| 3   | Ship as a skill / plugin, agent-triggered    | Own entry tool; pi first; panel opens in Modules view   | Trigger policy details; Claude Code / Codex scope   | L      |
| 4   | Evaluation                                   | Task-accuracy baseline + UX vs Claude Code / Codex      | Baseline UIs, conditions, metrics, participants     | design |
| 5   | Summary page after the task                  | High-level design first, then drill into steps          | Page vs card; what the high level shows             | M      |
| 6   | Code-block-level detail while the agent runs | Both: live diff snippets and grouping by function/class | Symbol extraction; how much fits in the card        | M      |

Suggested order: decide item 4 first, because it decides what the study needs. Then items 1, 5
and 6, which change the trace and both views and must be frozen before we record study traces.
Item 3 is a demonstration of generality and is not needed for the study. Item 2 needs real file
dependencies first (see the appendix).

## 1. Readable thinking blocks in the trace

> 完整记录可读的思考块的部分加到 raw log 里

**Now.** pi already writes thinking blocks to `runs/<id>/raw.jsonl`, because `message_end` is in
`RAW_EVENTS` (`packages/server/src/run.ts:47`). The trace does not have them:
`contentText` keeps only text blocks (`packages/extension/src/capture.ts:16-21`), and the
`message_end` handler (`packages/extension/src/index.ts:352`) emits only `assistant_text`. So no
view shows them, including the researcher's Raw view, which lists trace events
(`packages/web/src/components/RawView.tsx`). Checked on three recorded runs: 2–4 thinking blocks
in `raw.jsonl`, 0 in `trace.jsonl`.

**Decided.** Record readable thinking in the trace and show it in both the Modules and the Log
view, so both study conditions keep the same information (the equivalence contract,
`docs/design.md` §6.3).

**Plan.**

- New trace event, e.g. `assistant_thinking { attemptId, text, messageId }`, emitted from the
  `message_end` handler next to `assistant_text`.
- Keep only readable text. Drop redacted or encrypted blocks and `thinkingSignature`. Alexia's
  repo has filter rules and test cases for this that we can take over.
- Tie each tool call to the thinking block before it (same assistant message or the one just
  before), so a step can show "why" next to "what".
- Log view: a collapsed row in time order. Modules view: under the step it precedes, collapsed by
  default.

**Open.**

- Some models or providers return only summaries, or nothing. Show "no reasoning available"
  rather than leaving it out silently?
- Thinking can be long. Truncate in the view and keep the full text in the trace?
- Does showing reasoning change what participants trust? This is worth one probe question in the
  walkthroughs.

## 2. Re-run only the affected range on a redo

> 借鉴她的恢复思路，只重跑受影响的区间，冲突时让模型出一份修复计划（后续待 refine）

**Now.** Redo is conservative (`packages/server/src/run.ts:350`, `revise`). It restores the
checkpoint from before the module, rewinds the conversation to just before its `start_module`,
invalidates that attempt and everything after it, and re-runs from there.

**Idea, from Alexia's repo.** Re-run only the modules the change affects and keep the rest. When
kept work conflicts with the new result, the model writes a repair plan instead of silently
redoing everything.

**Caution, from the comparison of the two repos.** Her dependency information does not see
bash writes or imports, so kept work can quietly depend on code that was rolled back. Do not port
the mechanism as it is.

**Prerequisites.**

- Real file dependencies from checkpoint diffs, including files changed through bash, with
  evidence per path. This is item 5 of the appendix and a gap listed in the midway report.
- Conversation rewind that keeps the kept modules' messages, or a summary of them. Today the
  rewind is linear: everything after the target is dropped.

**Open.**

- What decides "affected": the agent's `dependsOn`, file overlap from diffs, or both (union, to
  stay conservative)?
- After keeping a module, how do we check it still holds? Re-run its validation and tests
  automatically?
- What counts as a conflict, and who approves the repair plan: the overseer at a boundary, or the
  agent alone?
- Is it an option next to conservative redo, or the new default? A change of redo semantics
  applies to both study conditions.

## 3. Ship as a skill / plugin that the agent triggers

> 变成 skill，trigger plan tool 的时候自动 trigger 这个，扩展到 pi, Claude Code, Codex etc.

**Decided.** The trigger is our own entry tool. A small `enter_module_mode` tool is always
present; the agent calls it when it judges the task long. We do not hook the harness's built-in
plan feature. Build pi first.

**How it works in pi** (checked against pi 1.4.0 sources and with faux-model probes):

1. Dormant: only `enter_module_mode` is active, about 100–150 tokens. The module tools are
   registered with `defaultActive: false`, and no protocol text goes into the system prompt.
2. The agent calls it: `pi.setActiveTools` turns on `plan_modules` / `start_module` /
   `finish_module`, the active protocol comes back as the tool result, and the extension starts the
   panel server (127.0.0.1 with a token) and opens the browser.
3. `plan_modules` holds at the after-plan boundary. This is where the plan overview (branch
   `claude/plan-overview-43da76`) comes in.
4. Controls: a correction is `pi.sendUserMessage(..., { deliverAs: "steer" })` and Stop is
   `ctx.abort()`. Redo dispatches our own `/vcm-redo` command with
   `sendUserMessage(cmd, { expandPromptTemplates: true })`, because `navigateTree` is only
   available in a command context. That makes it a true rewind.
5. Install with `pi install` (a pi package). The user can force or forbid the mode with
   `/modules`, `--modules` or a shortcut.

**Panel entry in guest mode (decided).**

- The panel opens straight into the Modules view of the run the agent just started.
- The Home page's "Start a run" box is not shown (task, variant, agent, Pause after plan;
  `packages/web/src/components/Home.tsx`), because the run starts from the user's own session.
- Past runs stay reachable from a **Runs** entry in the bottom harness bar, next to Modules /
  Log / Raw (`packages/web/src/components/Harness.tsx:52`).
- Host mode keeps the Home page and the start box for the study.

**Other harnesses** (guest mode; ✅ native, 🟡 limited, 🔧 workaround):

| Capability     | pi                          | Claude Code (plugin + mod)              | Codex (plugin: skill + MCP + hooks)   |
| -------------- | --------------------------- | --------------------------------------- | ------------------------------------- |
| Agent trigger  | 🟡 `enter_module_mode` tool | 🟡 mod tool or skill                    | 🟡 skill, judged again every turn     |
| Boundary pause | ✅ no timeout               | 🟡 2-minute auto-background not settled | ✅ raise `tool_timeout_sec`           |
| Correction     | ✅ steer                    | 🔧 appended to the next tool result     | 🟡 needs the shared app-server daemon |
| Stop           | ✅                          | ✅                                      | 🟡 needs the daemon                   |
| Redo           | ✅ true rewind              | 🔧 soft: files restored, chat kept      | 🟡 `thread/revert`, whole turns only  |
| Prototype      | about 7–8 days              | about 7 days (mods need ≥ 2.1.287)      | about 8–9 days                        |

**Trigger policy** (recommended by the design review):

- Entering is easy and needs no approval. This is the same as Claude Code's `EnterPlanMode`.
- Only the user can leave the mode.
- A harness-side tripwire the agent does not control: when a second file is edited outside module
  mode, suggest the mode.
- The reason: oversight matters most exactly where the agent is likely not to trigger. A
  misleading doc can make the task look easy. Our first live run skipped the protocol, and in
  Vercel's evals the skill was never invoked in 56% of cases.

**Must change for guest mode.**

- `Checkpointer.restore` runs `git reset --hard` + `git clean -fd`
  (`packages/server/src/checkpointer.ts:73-74`). In guest mode the workspace is the user's real
  repo, so this would delete their own changes. Restore has to be limited to the paths the agent
  changed, and ask first when the user changed them too.
- Split `packages/extension/src/prompt.ts` into a short trigger text and the active protocol.
  Drop "required for every task".
- Work done before the mode was entered: show it as its own "before module mode" segment,
  backfilled from the session, with a baseline snapshot taken at the first edit of the session.
- Two control surfaces (terminal and panel): the extension is the only arbiter. Stop wins from
  either side; the first boundary decision wins. `/modules continue|stop|status` works without
  the panel. Terminal input is recorded as interventions.
- The server listens on all interfaces and checks no origin (`packages/server/src/main.ts:112`).
  Bind to 127.0.0.1 and check Host/Origin before it runs inside someone's session.

**Open.** For Claude Code and Codex: build them, or only describe the mapping in the report? The
design review suggests the mapping only, given the timeline.

## 4. Evaluation

> evaluation, how it differs from current project

**Decided, two parts.**

1. **Task-accuracy baseline.** Does the module protocol help or hurt the agent itself? Run the
   same model on the same tasks with and without the protocol. Measure hidden-test pass rate,
   regressions, cost, tokens and time (`tasks/grade.py`, `npm run record`).
2. **User experience compared with real products.** Does our panel help people find bugs faster
   and understand what the agent is doing, compared with the observability of Claude Code and
   Codex?

**How it differs from the current plan.** `docs/design.md` §9 compares our Modules view with our
own Log view. The Log view is built from the same trace, under an equivalence contract, so only
the presentation differs. Comparing with Claude Code and Codex instead gives a baseline people
know, but it brings in differences we do not control: another agent, another model, other
behaviour, and seeded failures that cannot be injected the same way (`read_rewrite` needs pi's
`tool_result` hook).

**Options for part 2.**

- (A) Replay the same recorded pi traces in our panel and in transcript views styled like
  Claude Code and Codex. Controlled, but the baselines are our re-creations of their UIs.
- (B) Run the real Claude Code and Codex live on the same tasks. Realistic, but confounded by
  model and agent, and hard to seed the same failures.
- (C) Both: (A) for the measured trace study (RQ1, RQ2), and a few live (B) sessions for
  qualitative comparison.

**Metrics.** Time to detect and localize a seeded bug, detection rate, comprehension questions
(what is the agent doing, why, what changed), intervention success for RQ3, workload (NASA-TLX),
and trust calibration.

**Open.**

- Choose A, B or C. Keep our Log view as a third, controlled condition?
- Number of participants and design (within or between subjects), given the course timeline:
  Thanksgiving recess Nov 23–27, last day of classes Dec 4.
- IRB status (milestone item: email course staff).
- If guest mode is evaluated: an offline trigger evaluation of about 40 long, short and adversarial
  tasks, measuring precision and recall of entering the mode. It needs no participants and costs
  tens of dollars.

## 5. Summary page after the task

> summary page after task done, for user to check the high level design and get into detailed steps

**Now.** At the end of a run the card slot shows `RunSummary`
(`packages/web/src/components/ModuleCard.tsx:902`). The plan overview box on
`claude/plan-overview-43da76` stays available through the run.

**Plan.** A page that opens when the run ends, and works in replay. Top level:

- the final plan;
- each module's outcome;
- flags;
- tests, verified and claimed shown separately;
- interventions;
- the files touched and the dependencies between them.

From there, click a module to see its steps and diffs, then a step to see the exact action and
output.

**Open.**

- A separate page, or an expanded summary card?
- What goes into the "high-level design": the module graph, a file map, or both?
- The Log view needs an equivalent end summary, or the conditions differ.

## 6. Code-block-level detail while the agent runs

> fine-grained details into code block level during the agent running

**Decided: both.**

- Show each edit's diff snippet live in the running module's steps.
- Group changes by the function or class they touch, e.g. "changed `Cart.apply_code`".

**Now.** Per-action diffs exist and expand under a step (`ModuleCard.tsx`, the `.dh` call header),
and the Diff tab shows per-file diffs.

**Plan.**

- Live: stream each `edit`/`write` result's hunks into the step as it finishes.
- Grouping: map hunks to the enclosing `def`/`class`. The tasks are Python, so Python's `ast` in
  `tasks/.venv` can do it. Alternatively tree-sitter, which would also cover other languages.
- Group in the card as "symbol → hunks".

**Open.**

- Where it lives: the step list, a new tab, or both.
- How it treats bash-made edits, which have no edit hunks (diff the checkpoint instead).
- The Log view needs the same detail.

## Known issues found on the way

- **Fixed in the working tree (not committed):** after a boundary stopped the run, the other tool
  calls in the same batch still ran, and pi could ask the model again. pi ends a run after a batch
  only if every call in it returns `terminate`, so this was our extension's bug. Host mode was
  not affected, because the server aborts right after stop and redo. It would hit any host that
  does not abort, such as guest mode. The fix aborts the run from the module tool and blocks what
  is left of the batch. Tests: `packages/extension/test/modules.test.ts`, "a boundary that stops
  the run". Known side effects:
  - When the stopped batch also held a call that ran or failed, or a message was queued, pi ends
    with an empty assistant message whose stop reason is "error" ("This operation was aborted").
    The pi TUI shows it as an error. The server already did this before the fix.
  - A sibling call skipped after the stop gets pi's "No result provided" on the next run instead of
    our reason text.
  - In an SDK host, messages queued during the hold land out of place. The first one is put into
    the transcript unanswered, and the rest are injected after the next prompt. The pi TUI puts
    them back in the editor instead, as Esc does.
- **Open, also before the fix:** a note sent while a boundary is held, followed by Stop or Redo, is
  recorded as delivered although the model never answered it. pi's abort does not clear its
  steering queue (`packages/server/src/run.ts`, `stop()` / `revise()`). With two held notes and a
  redo, the first is dropped with the discarded branch and the second leaks into the redo prompt.
  Fix: clear the queue on stop and redo, then keep the notes marked undelivered or carry them into
  the redo prompt explicitly.

## Appendix: other items from the comparison with Alexia's repo

Not on the list above yet, but worth porting (from the repo comparison of 2026-11-06):

- Make `validation` (done-when) required, and require evidence per criterion on finish
  (`packages/extension/src/index.ts:66`). Real runs had empty validation.
- A plan validator: unknown or self dependencies, cycles, and her splitting rules. Put the reason
  into the error message text, since pi forwards only `error.message`.
- Checkpoint safety: snapshot before a redo, close attempts still open at the end of a run, and do
  not depend on the task's `.gitignore`.
- Real file dependency arcs from checkpoint diffs (also a prerequisite for item 2).
- Server hardening: bind to 127.0.0.1, check Host/Origin, limit request bodies, shut down cleanly.
- Later: fork a new run from a recorded state (RQ3 "matched-state" starts), and a redo preview.

Items that change the agent protocol make older runs incomparable with new ones, so finish them
before recording study traces.
