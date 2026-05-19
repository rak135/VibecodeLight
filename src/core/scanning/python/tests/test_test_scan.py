"""
Tests for test inventory scan.

TDD: tests are written before implementation.

Covers:
- tests/, test_*.py, *_test.py
- *.test.ts / *.spec.ts
- __tests__/
- pytest config (pyproject.toml [tool.pytest], pytest.ini)
- vitest/jest config
- Test names extracted from def test_* and Jest/Vitest test()/it() calls
- Simple likely_target pairing
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


def _by_path(entries: list[dict], path: str) -> dict | None:
    for e in entries:
        if e.get("path") == path:
            return e
    return None


class TestPythonTests:
    def test_test_files_detected(self, tmp_path: Path):
        tdir = tmp_path / "tests"
        tdir.mkdir()
        (tdir / "test_things.py").write_text(
            "def test_one():\n    assert True\n\n"
            "def test_two():\n    assert 1 == 1\n",
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "tests.json").read_text(encoding="utf-8"))
        entries = data["tests"]
        entry = _by_path(entries, "tests/test_things.py")
        assert entry is not None
        assert entry["language_guess"] == "python"
        assert entry["test_framework_guess"] == "pytest"
        names = entry["test_names"]
        assert "test_one" in names
        assert "test_two" in names

    def test_underscore_test_suffix_detected(self, tmp_path: Path):
        (tmp_path / "thing_test.py").write_text(
            "def test_alpha():\n    pass\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "tests.json").read_text(encoding="utf-8"))["tests"]
        assert _by_path(entries, "thing_test.py") is not None

    def test_pairing_test_to_source(self, tmp_path: Path):
        (tmp_path / "base_scan.py").write_text("def f():\n    pass\n", encoding="utf-8")
        tdir = tmp_path / "tests"
        tdir.mkdir()
        (tdir / "test_base_scan.py").write_text(
            "def test_x():\n    pass\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "tests.json").read_text(encoding="utf-8"))["tests"]
        entry = _by_path(entries, "tests/test_base_scan.py")
        assert entry is not None
        targets = entry["likely_targets"]
        assert "base_scan.py" in targets, f"expected pairing to base_scan.py, got {targets}"


class TestTypeScriptTests:
    def test_dot_test_ts_detected(self, tmp_path: Path):
        (tmp_path / "store.ts").write_text("export const x = 1;\n", encoding="utf-8")
        (tmp_path / "store.test.ts").write_text(
            "import { describe, it } from 'vitest';\n"
            "describe('store', () => {\n"
            "  it('works', () => {});\n"
            "});\n",
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "tests.json").read_text(encoding="utf-8"))["tests"]
        entry = _by_path(entries, "store.test.ts")
        assert entry is not None
        assert entry["language_guess"] == "typescript"
        # vitest or jest, given test_framework_guess heuristic
        assert entry["test_framework_guess"] in ("vitest", "jest", "unknown")
        assert "store.ts" in entry["likely_targets"]

    def test_dot_spec_ts_detected(self, tmp_path: Path):
        (tmp_path / "thing.spec.ts").write_text(
            "it('x', () => {});\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "tests.json").read_text(encoding="utf-8"))["tests"]
        assert _by_path(entries, "thing.spec.ts") is not None

    def test_tests_directory_ts(self, tmp_path: Path):
        tdir = tmp_path / "__tests__"
        tdir.mkdir()
        (tdir / "Component.tsx").write_text(
            "describe('c', () => { it('x', () => {}); });\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "tests.json").read_text(encoding="utf-8"))["tests"]
        assert _by_path(entries, "__tests__/Component.tsx") is not None


class TestFrameworkConfigDetection:
    def test_pytest_config_in_pyproject(self, tmp_path: Path):
        (tmp_path / "pyproject.toml").write_text(
            "[tool.pytest.ini_options]\ntestpaths = ['tests']\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "tests.json").read_text(encoding="utf-8"))
        cfg = data.get("test_configs", [])
        names = [c.get("path") for c in cfg]
        assert "pyproject.toml" in names

    def test_vitest_config_detected(self, tmp_path: Path):
        (tmp_path / "vitest.config.ts").write_text("export default {};\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "tests.json").read_text(encoding="utf-8"))
        cfg_paths = [c.get("path") for c in data.get("test_configs", [])]
        assert "vitest.config.ts" in cfg_paths
