# Tasks

Each task lives in `tasks/<id>/`:

```
task.yaml        spec (below)
repo/            the repository the agent works on (or `source: { git, commit }` in task.yaml)
hidden_tests/    behavioral tests the agent never sees; used by grade.py
```

`task.yaml` fields: `id`, `title`, `split` (`dev` | `pilot` | `eval`), `source`, `prompt` (human-written
requirements), `test_command`, `hidden_tests`, `setup` (optional shell commands run in the workspace), `notes`
(task source and selection criteria), and `variants` (seeded failures).

Seeded-failure variant kinds (docs/design.md §8):

| kind              | what it does                                                                            |
| ----------------- | --------------------------------------------------------------------------------------- |
| `prompt_override` | replaces the prompt (omitted or misstated requirement)                                  |
| `file_overlay`    | writes plausible but wrong files into the workspace (docs, comments)                    |
| `read_rewrite`    | rewrites the result of reading a file (incorrect API assumption) — _TODO in the server_ |

Each variant records its `origin` and `expected_affected` changes for analysis.

`toy-shop-discounts` is a self-contained **dev** task for building the system. It is never used in a study.
Pilot and eval tasks come from small, pinned public Python repos (milestone day 3).

## Python environment and grading

`uv sync --project tasks` creates `tasks/.venv` with pytest. The server prepends it to the agent's `PATH`.

```bash
npm run grade -- tasks/toy-shop-discounts runs/<run-id>/workspace
```

`grade.py` copies the workspace to a temp directory, runs the visible tests (regressions) and the hidden
tests, and prints a summary (`--json` for the full result). Before using a task, check that the untouched
repo fails the hidden tests and that a reference solution passes them.
