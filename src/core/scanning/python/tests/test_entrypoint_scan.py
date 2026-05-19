"""
Tests for entrypoint detection.

TDD: tests are written before implementation.

Covers:
- package.json bin/scripts
- pyproject.toml project.scripts
- __main__.py / main.py
- src/app/cli/* and obvious server/app startup files
- Each record has path or command, type, source, evidence-based confidence string
- No numeric relevance scores
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


class TestPackageJsonEntrypoints:
    def test_package_json_bin_produces_entrypoint(self, tmp_path: Path):
        (tmp_path / "package.json").write_text(
            '{"name": "x", "bin": {"mytool": "./bin/mytool.js"}}\n',
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "entrypoints.json").read_text(encoding="utf-8"))
        entries = data["entrypoints"]
        bin_entries = [e for e in entries if e["source"].startswith("package.json:bin")]
        assert bin_entries, f"expected bin entrypoint, got: {entries}"
        for e in bin_entries:
            assert e["type"] in ("cli", "script", "module", "app", "unknown")
            assert e["confidence"] == "declared"
            # never numeric
            assert not isinstance(e["confidence"], (int, float))

    def test_package_json_scripts_produces_entrypoints(self, tmp_path: Path):
        (tmp_path / "package.json").write_text(
            '{"scripts": {"start": "node server.js", "build": "tsc"}}\n',
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "entrypoints.json").read_text(encoding="utf-8"))[
            "entrypoints"
        ]
        script_entries = [e for e in entries if "scripts" in e["source"]]
        assert script_entries, f"expected script entries: {entries}"
        names = {e.get("name") for e in script_entries}
        assert "start" in names
        assert "build" in names


class TestPyprojectEntrypoints:
    def test_pyproject_project_scripts_produces_entrypoints(self, tmp_path: Path):
        (tmp_path / "pyproject.toml").write_text(
            "[project]\nname = 'p'\n[project.scripts]\nmycli = 'pkg.mod:main'\n",
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "entrypoints.json").read_text(encoding="utf-8"))[
            "entrypoints"
        ]
        names = {e.get("name") for e in entries}
        assert "mycli" in names, f"expected mycli in {entries}"
        for e in entries:
            if e.get("name") == "mycli":
                assert e["type"] == "cli"
                assert e["source"].startswith("pyproject.toml")
                assert e["confidence"] == "declared"


class TestConventionalEntrypoints:
    def test_main_py_is_detected(self, tmp_path: Path):
        (tmp_path / "main.py").write_text("print('hi')\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "entrypoints.json").read_text(encoding="utf-8"))[
            "entrypoints"
        ]
        paths = [e.get("path") for e in entries]
        assert "main.py" in paths
        rec = next(e for e in entries if e.get("path") == "main.py")
        assert rec["confidence"] == "conventional"

    def test_dunder_main_py_is_detected(self, tmp_path: Path):
        pkg = tmp_path / "pkg"
        pkg.mkdir()
        (pkg / "__main__.py").write_text("print('hi')\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "entrypoints.json").read_text(encoding="utf-8"))[
            "entrypoints"
        ]
        paths = [e.get("path") for e in entries]
        assert "pkg/__main__.py" in paths
        rec = next(e for e in entries if e.get("path") == "pkg/__main__.py")
        assert rec["type"] in ("module", "cli")

    def test_src_app_cli_files_detected(self, tmp_path: Path):
        cli_dir = tmp_path / "src" / "app" / "cli"
        cli_dir.mkdir(parents=True)
        (cli_dir / "index.ts").write_text("export {};\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "entrypoints.json").read_text(encoding="utf-8"))[
            "entrypoints"
        ]
        paths = [e.get("path") for e in entries]
        assert "src/app/cli/index.ts" in paths


class TestEntrypointBoundaries:
    def test_no_numeric_relevance_score(self, tmp_path: Path):
        (tmp_path / "main.py").write_text("print('hi')\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "entrypoints.json").read_text(encoding="utf-8"))
        for e in data["entrypoints"]:
            for k, v in e.items():
                # No numeric relevance/confidence scores anywhere
                if k in ("relevance", "score", "confidence_score"):
                    raise AssertionError(f"unexpected numeric field {k}={v}")
            # Confidence must be a string label
            assert isinstance(e["confidence"], str)
