# Analysis

Python analysis of agent traces and study data. Planned contents:

- `load.py`: read `runs/<id>/trace.jsonl` into tables (attempts, actions, interventions).
- Protocol compliance per run: % actions assigned to a module, plan revisions, actions per module (milestone bake-off).
- Study analysis (docs/design.md §9.3): mixed-effects models with participant and task random intercepts,
  paired effects with bootstrap CIs. Fix the analysis plan before the main study.

Use `uv` for dependencies (e.g. `uv init --bare` here, then `uv add pandas statsmodels`).
