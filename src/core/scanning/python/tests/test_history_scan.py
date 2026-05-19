"""
Tests for recent git history scan.

TDD: tests are written before implementation.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCANNER_DIR = Path(__file__).parent.parent


def run_scanner(args: list[str], cwd: Path = SCANNER_DIR) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "vibecode_scanner", *args],
        capture_output=True,
        text=True,
        cwd=cwd,
    )


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], check=True, capture_output=True, cwd=str(cwd))


def make_git_repo_with_commits(tmp_path: Path, n: int = 3) -> None:
    _git(["init", str(tmp_path)], cwd=tmp_path.parent)
    _git(["config", "user.email", "t@t.t"], cwd=tmp_path)
    _git(["config", "user.name", "Test"], cwd=tmp_path)
    for i in range(n):
        (tmp_path / f"f{i}.txt").write_text(f"v{i}\n", encoding="utf-8")
        _git(["add", "."], cwd=tmp_path)
        _git(["commit", "-m", f"commit {i}"], cwd=tmp_path)


class TestRecentHistory:
    def test_history_captures_commits(self, tmp_path: Path):
        make_git_repo_with_commits(tmp_path, n=3)
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "recent_history.json").read_text(encoding="utf-8"))
        history = data["recent_history"]
        assert isinstance(history, list)
        assert len(history) >= 3
        messages = [h["message"] for h in history]
        assert "commit 2" in messages
        for h in history:
            for f in ("commit", "message", "raw_line"):
                assert f in h, f"missing field {f} in {h}"
            assert h["commit"] and isinstance(h["commit"], str)

    def test_missing_git_history_does_not_crash(self, tmp_path: Path):
        # No git init -- scanner must not crash, must record a warning
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        assert (out_dir / "recent_history.json").exists()
        data = json.loads((out_dir / "recent_history.json").read_text(encoding="utf-8"))
        assert isinstance(data.get("recent_history"), list)
        # Either empty or a warning recorded
        warnings = data.get("warnings", [])
        if not data["recent_history"]:
            assert warnings, "expected a warning when no git history available"

    def test_history_limited_to_recent(self, tmp_path: Path):
        make_git_repo_with_commits(tmp_path, n=25)
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "recent_history.json").read_text(encoding="utf-8"))
        # spec uses `git log --oneline -20`
        assert len(data["recent_history"]) <= 20
