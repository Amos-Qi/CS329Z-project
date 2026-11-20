# Visible and Controllable Modules for Human Oversight of Coding Agents

CS329Z project by Alexia Huang & Qi Wu. A single [pi](https://github.com/earendil-works/pi) coding agent
organizes its work into **modules** (task-specific subgoals) that a developer can inspect, pause, edit
and revise. We compare a modular interface against a conventional chronological log.

- **Proposal:** [docs/proposal.pdf](docs/proposal.pdf)
- **Refined design** (architecture, data model, protocol, evaluation, open questions): [docs/design.md](docs/design.md)
- **Midway milestone plan:** [docs/milestone.md](docs/milestone.md)
- **Panel design** (clickable mockup; open it in a browser): [design/mockups/panel.html](design/mockups/panel.html)

The panel is **wired to pi end to end**: a live run (OpenRouter model or the scripted demo agent) streams
its trace into the modular view and the log view, and every intervention in the mockup works against the
real session (pause at the next boundary, continue, change a module first, correct the running module, note
to the agent, redo from a module with rewind, stop), plus replay of recorded runs.

## Layout

```
packages/
  protocol/    Trace schema (TraceEvent), module data model, shared reducer reduceTrace()   [TS]
  extension/   pi extension: plan_modules / start_module / finish_module tools + capture hooks [TS]
  server/      Node host: runs pi sessions (SDK) on tasks, HTTP + WebSocket API              [TS]
  web/         React UI: modular view (treatment) and log view (baseline)                     [TS]
tasks/         Python task suite: repo, prompt, hidden tests, seeded-failure variants; grade.py
analysis/      Trace and study analysis (Python)
study/         Study protocol, probes, rubrics, consent
docs/          Proposal, design, milestone plan
design/        Panel mockups (design/mockups/panel.html is the chosen design)
runs/          Agent runs: workspace, trace.jsonl, pi session (git-ignored)
```

How the pieces connect: the server creates a pi `AgentSession` with the modules extension loaded inline.
The extension reports everything as `TraceEvent`s through a `ModulesHost`; the server appends them to
`runs/<id>/trace.jsonl` and streams them to the UI over `/ws`. Both UI views derive their state from the
same `reduceTrace()` and the same derivations in `packages/protocol/src/derive.ts` (statuses, flags,
boundaries), which keeps the comparison fair (design §6.3). The UI turns that state into a view model
(`packages/web/src/model/panel.ts`) that mirrors the mockup's data, so the components port it 1:1.

## Setup

Requirements: Node ≥ 22.19, [uv](https://docs.astral.sh/uv/), git.

```bash
npm install
```

```bash
uv sync --project tasks
```

```bash
cp .env.example .env
```

Then put your `OPENROUTER_API_KEY` in `.env` and pick `VCM_MODEL`.
`uv sync` creates `tasks/.venv`; the server puts it on the agent's `PATH` so it can run `pytest`.

## Commands

| Command                                              | What it does                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run dev`                                        | Server on :8787 and UI on http://localhost:5173                     |
| `npm test`                                           | Offline tests (pi's scripted faux model; no API key, no cost)       |
| `npm run record -- [--variant <id>] [--model <id>]`  | Record one live run headless; prints compliance, flags, cost, grade |
| `npm run demo:record [-- --variant misleading-doc]`  | Same with the scripted demo agent (no API key)                      |
| `npm run typecheck`                                  | Type-check every package                                            |
| `npm run check`                                      | Lint/format check (Biome) + typecheck                               |
| `npm run format`                                     | Apply Biome formatting                                              |
| `npm run grade -- tasks/<task> runs/<run>/workspace` | Hidden + visible tests on a finished workspace                      |

To try the extension in the stock pi CLI without the server, run `pi -e packages/extension/src/cli.ts`
inside a task repo. The trace is written to `.vcm/trace.jsonl`.

## Running a demo

`npm run dev`, open http://localhost:5173, pick the task, a variant (`misleading-doc` plants the seeded
error), the agent and "Pause after plan", then Start. The **scripted agent** needs no API key and is paced
for a live demo. It is a small policy over the conversation, so it reacts to the controls: with
`misleading-doc` it truncates cents in M3 and claims done without a passing test (1 flag); a redo of M3, a
"Change M3 first" or a correction that asks for rounding half up fixes it, and the grade turns to PASS. The
harness bar at the bottom (researcher chrome, not part of either condition) switches Modules / Log / Raw,
the theme, and scrubs any run for replay. `?view=log&study=1` fixes the condition for a participant.

For a live run with a real model, pick `snake-game` (a browser Snake game with a small Node.js server,
built from a near-empty repo) and the configured OpenRouter model; it needs `OPENROUTER_API_KEY` in `.env`.
With a key set, it is the default task on the Home page.

## What is done, and what is next

Done (docs/milestone.md items 1–6): the module protocol with reminders and a 2–7 module plan, capture of
every action (including calls pi rejects), shadow-git checkpoints with per-attempt diffs and the omission
audit, the boundary gate (one-shot pause), edit / correct / note / redo (rewind) / stop, the five flags,
the modular view (Now bar, Metro line, module card, evidence), the log view, replay, and seeded failures
(`prompt_override`, `file_overlay`, `read_rewrite`).

Next: the pilot task set from public repos and a subtler seeded failure (claude-sonnet-5.5 ignores the
planted guide), the model bake-off (`npm run record -- --model <id>` across 2–3 models), walkthroughs.

## Conventions

- TypeScript runs directly under Node's type stripping (no build step for server/extension): use `.ts`
  import extensions and erasable syntax only (no enums, namespaces or constructor parameter properties).
- Tests that need an agent use `createFauxSession()` from `@vcm/extension/testing` with scripted responses.
- Never commit `.env` or `runs/`.
