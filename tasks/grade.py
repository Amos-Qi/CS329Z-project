"""Grade a finished workspace against a task's hidden tests and its visible tests.

    uv run --project tasks python tasks/grade.py tasks/<task-id> runs/<run-id>/workspace [--json]

The workspace is copied to a temporary directory first, so grading never changes it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

IGNORE = shutil.ignore_patterns(".venv", "__pycache__", ".pytest_cache", ".git", "node_modules")


def load_task(task_dir: Path) -> dict:
    text = (task_dir / "task.yaml").read_text()
    hidden = re.search(r"^hidden_tests:\s*(\S+)", text, re.M)
    command = re.search(r"^test_command:\s*(.+?)\s*$", text, re.M)
    return {
        "hidden_tests": task_dir / hidden.group(1) if hidden else None,
        "test_command": command.group(1).strip("'\"") if command else "python -m pytest -q",
    }


def uses_pytest(command: str) -> bool:
    return re.search(r"\bpy\.?test\b", command) is not None


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


def run_command(cwd: Path, command: str, timeout: int = 180) -> dict:
    """Runs a non-pytest test command (e.g. `npm test`) and reads Node's test-runner summary."""
    env = {key: value for key, value in os.environ.items() if key != "FORCE_COLOR"} | {"NO_COLOR": "1"}
    # its own process group, so a test that leaves a server running can be stopped with everything it started
    proc = subprocess.Popen(
        command,
        shell=True,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        output, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        output, _ = proc.communicate()
        return {
            "exit_code": None,
            "passed": 0,
            "failed": 0,
            "errors": 1,
            "skipped": 0,
            "failures": [],
            "output": f"timed out after {timeout} s (a server or timer left running?)\n{(output or '')[-2000:]}",
        }

    def count(node_word: str, word: str) -> int:
        # Node's anchored summary first, then counts such as "3 passed" printed by another runner
        found = re.findall(rf"^(?:ℹ|#) {node_word} (\d+)\s*$", output, re.M) or re.findall(rf"(\d+) {word}\b", output)
        return int(found[-1]) if found else 0

    result = {
        "exit_code": proc.returncode,
        "passed": count("pass", "passed"),
        "failed": count("fail", "failed"),
        "errors": count("cancelled", "errors?"),
        "skipped": count("skipped", "skipped"),
        "failures": [],
    }
    # Node lists each failing test after its summary as "test at <file>" then "✖ <name>" (suites are not
    # in that list); other runners: top-level "✖ <name>" lines
    lines = output.splitlines()
    listed = [line for i, line in enumerate(lines) if line.startswith("✖ ") and i and lines[i - 1].startswith("test at ")]
    named = listed or [line for line in lines if line.startswith("✖ ") and line != "✖ failing tests:"]
    for line in named:
        name = re.sub(r"\s*\([\d.]+m?s\)$", "", line[2:].strip())
        if name not in result["failures"]:
            result["failures"].append(name)
    # a failing command with no failing test (missing script, syntax error, no tests found) still fails
    if proc.returncode != 0 and not result["failed"] + result["errors"]:
        result["errors"] = 1
    if proc.returncode != 0 or not result["passed"]:
        result["output"] = output[-2000:]
    return result


def grade(task_dir: Path, workspace: Path) -> dict:
    task = load_task(task_dir)
    with tempfile.TemporaryDirectory(prefix="vcm-grade-") as tmp:
        work = Path(tmp) / "ws"
        shutil.copytree(workspace, work, ignore=IGNORE)
        pytest = uses_pytest(task["test_command"])
        visible = run_pytest(work, ".", "visible") if pytest else run_command(work, task["test_command"])
        hidden = None
        # hidden tests are pytest suites; tasks with another runner have none yet
        if pytest and task["hidden_tests"] and task["hidden_tests"].exists():
            shutil.copytree(task["hidden_tests"], work / "_hidden_tests")
            hidden = run_pytest(work, "_hidden_tests", "hidden")
    ok = visible["failed"] == visible["errors"] == 0 and (hidden is None or hidden["failed"] == hidden["errors"] == 0)
    # a task without hidden tests has to show at least one passing test of its own
    ok = ok and (hidden is not None or visible["passed"] > 0)
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
        else:
            print("  hidden tests:  none for this task")
            for name in v["failures"]:
                print(f"    ✗ {name}")
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
