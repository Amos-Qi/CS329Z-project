"""Grade a finished workspace against a task's hidden tests and its visible tests.

    uv run --project tasks python tasks/grade.py tasks/<task-id> runs/<run-id>/workspace [--json]

The workspace is copied to a temporary directory first, so grading never changes it.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

IGNORE = shutil.ignore_patterns(".venv", "__pycache__", ".pytest_cache", ".git")


def load_task(task_dir: Path) -> dict:
    import re

    text = (task_dir / "task.yaml").read_text()
    hidden = re.search(r"^hidden_tests:\s*(\S+)", text, re.M)
    return {"hidden_tests": task_dir / hidden.group(1) if hidden else None}


def run_pytest(cwd: Path, target: str, label: str) -> dict:
    report = cwd / f".{label}-junit.xml"
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", f"--junitxml={report}", target],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    result = {"exit_code": proc.returncode, "passed": 0, "failed": 0, "errors": 0, "skipped": 0, "failures": []}
    if report.exists():
        for case in ET.parse(report).getroot().iter("testcase"):
            name = f"{case.get('classname')}::{case.get('name')}"
            if case.find("failure") is not None:
                result["failed"] += 1
                result["failures"].append(name)
            elif case.find("error") is not None:
                result["errors"] += 1
                result["failures"].append(name)
            elif case.find("skipped") is not None:
                result["skipped"] += 1
            else:
                result["passed"] += 1
    if proc.returncode not in (0, 1) and not result["passed"] + result["failed"]:
        result["output"] = (proc.stdout + proc.stderr)[-2000:]
    return result


def grade(task_dir: Path, workspace: Path) -> dict:
    task = load_task(task_dir)
    with tempfile.TemporaryDirectory(prefix="vcm-grade-") as tmp:
        work = Path(tmp) / "ws"
        shutil.copytree(workspace, work, ignore=IGNORE)
        visible = run_pytest(work, ".", "visible")
        hidden = None
        if task["hidden_tests"] and task["hidden_tests"].exists():
            shutil.copytree(task["hidden_tests"], work / "_hidden_tests")
            hidden = run_pytest(work, "_hidden_tests", "hidden")
    ok = visible["failed"] == visible["errors"] == 0 and (hidden is None or hidden["failed"] == hidden["errors"] == 0)
    return {"task": task_dir.name, "workspace": str(workspace), "ok": ok, "visible": visible, "hidden": hidden}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("task_dir", type=Path)
    parser.add_argument("workspace", type=Path)
    parser.add_argument("--json", action="store_true", help="print the full JSON result")
    args = parser.parse_args()
    result = grade(args.task_dir, args.workspace)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        h = result["hidden"]
        v = result["visible"]
        print(f"{result['task']}: {'PASS' if result['ok'] else 'FAIL'}")
        print(f"  visible tests: {v['passed']} passed, {v['failed'] + v['errors']} failed")
        if h:
            print(f"  hidden tests:  {h['passed']} passed, {h['failed'] + h['errors']} failed")
            for name in h["failures"]:
                print(f"    ✗ {name}")
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
