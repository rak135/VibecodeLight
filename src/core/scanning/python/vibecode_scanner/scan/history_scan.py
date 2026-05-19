"""
Recent git history.

Uses `git log --oneline -20` and parses commit hash + message per line.

If git is not available or the directory is not a git repository, returns
an empty history with a single warning. Does not crash.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any


def _run_git(args: list[str], cwd: Path) -> tuple[bool, str, str]:
    try:
        result = subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            cwd=str(cwd),
            timeout=15,
        )
        return result.returncode == 0, result.stdout, result.stderr
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        return False, "", str(exc)


def run_history_scan(repo_root: Path) -> dict[str, Any]:
    warnings: list[str] = []
    history: list[dict[str, Any]] = []

    ok, stdout, stderr = _run_git(["log", "--oneline", "-20"], repo_root)
    if not ok:
        msg = (stderr or "").strip() or "git not available or not a git repo"
        warnings.append(f"recent_history: {msg}")
        return {"recent_history": [], "warnings": warnings}

    for raw_line in stdout.splitlines():
        line = raw_line.rstrip()
        if not line:
            continue
        # `git log --oneline` format: "<short_hash> <message>"
        parts = line.split(" ", 1)
        commit = parts[0]
        message = parts[1] if len(parts) > 1 else ""
        history.append(
            {
                "commit": commit,
                "message": message,
                "raw_line": line,
            }
        )

    return {"recent_history": history, "warnings": warnings}
