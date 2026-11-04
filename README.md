# Visible and Controllable Modules for Human Oversight of Coding Agents

CS329Z project by Alexia Huang & Qi Wu. A single [pi](https://github.com/earendil-works/pi) coding agent
organizes its work into **modules** (task-specific subgoals) that a developer can inspect, pause, edit
and revise. We compare a modular interface against a conventional chronological log.

- **Proposal:** [docs/proposal.pdf](docs/proposal.pdf)
- **Refined design** (architecture, data model, protocol, evaluation, open questions): [docs/design.md](docs/design.md)
- **Midway milestone plan:** [docs/milestone.md](docs/milestone.md)
- **Panel design** (clickable mockup; open it in a browser): [design/mockups/panel.html](design/mockups/panel.html)

This is **starter code**: the structure, tooling, trace schema and pi wiring are in place, and the
project work is marked `TODO` with pointers to the design doc.

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
same `reduceTrace()`, which keeps the comparison fair (design §6.3).

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

| Command                                              | What it does                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                                        | Server on :8787 and UI on http://localhost:5173               |
| `npm test`                                           | Offline tests (pi's scripted faux model; no API key, no cost) |
| `npm run typecheck`                                  | Type-check every package                                      |
| `npm run check`                                      | Lint/format check (Biome) + typecheck                         |
| `npm run format`                                     | Apply Biome formatting                                        |
| `npm run grade -- tasks/<task> runs/<run>/workspace` | Hidden + visible tests on a finished workspace                |

To try the extension in the stock pi CLI without the server, run `pi -e packages/extension/src/cli.ts`
inside a task repo. The trace is written to `.vcm/trace.jsonl`.

## Where to start

The milestone plan splits the work into two tracks (docs/milestone.md):

- **Track A — agent & backend:** `packages/extension/src/index.ts` (module store, tools, capture hooks),
  `packages/server/src/{boundary-gate,checkpointer,run}.ts` (pause/edit/revise, snapshots, audit).
- **Track B — UI, tasks & study:** `packages/protocol/src/reduce.ts` (the reducer both views share),
  `packages/web/src/App.tsx` (modular view, log view, controls, replay), `tasks/` (curate tasks), `study/`.

Agree on the trace schema in `packages/protocol/src/{model,events}.ts` first; both tracks build on it.

## Conventions

- TypeScript runs directly under Node's type stripping (no build step for server/extension): use `.ts`
  import extensions and erasable syntax only (no enums, namespaces or constructor parameter properties).
- Tests that need an agent use `createFauxSession()` from `@vcm/extension/testing` with scripted responses.
- Never commit `.env` or `runs/`.
