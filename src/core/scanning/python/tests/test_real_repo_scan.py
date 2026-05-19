"""
Integration tests: run the scanner against the real VibecodeLight repository.

These tests confirm the new code-map artifacts surface real-project material:
- tests.json includes the scanner pytest files
- symbols.json contains Python scanner symbols
- keyword_hits.json has mechanical hits for typical task words and no numeric scores
- recent_history.json captures git log
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCANNER_DIR = Path(__file__).parent.parent
REPO_ROOT = SCANNER_DIR.parents[3]  # .../VibecodeLight


def run_scanner(args: list[str], cwd: Path = SCANNER_DIR) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "vibecode_scanner", *args],
        capture_output=True,
        text=True,
        cwd=cwd,
    )


def test_real_repo_scan_produces_code_map_artifacts(tmp_path: Path):
    out_dir = tmp_path / "scan"
    result = run_scanner(
        [
            "--repo",
            str(REPO_ROOT),
            "--task",
            "add scanner docs tests",
            "--out",
            str(out_dir),
        ]
    )
    assert result.returncode == 0, result.stderr

    for name in (
        "symbols.json",
        "imports.json",
        "entrypoints.json",
        "tests.json",
        "schemas.json",
        "keyword_hits.json",
        "recent_history.json",
    ):
        assert (out_dir / name).exists(), f"missing {name}"


def test_tests_json_includes_scanner_pytest_files(tmp_path: Path):
    out_dir = tmp_path / "scan"
    run_scanner(["--repo", str(REPO_ROOT), "--task", "t", "--out", str(out_dir)])
    data = json.loads((out_dir / "tests.json").read_text(encoding="utf-8"))
    paths = [e["path"] for e in data["tests"]]
    # Scanner pytest files live under src/core/scanning/python/tests/
    expected = "src/core/scanning/python/tests/test_base_scan.py"
    assert expected in paths, f"missing {expected} in {paths}"


def test_symbols_json_includes_python_scanner_symbols(tmp_path: Path):
    out_dir = tmp_path / "scan"
    run_scanner(["--repo", str(REPO_ROOT), "--task", "t", "--out", str(out_dir)])
    data = json.loads((out_dir / "symbols.json").read_text(encoding="utf-8"))
    names = {e["name"] for e in data["symbols"]}
    # run_base_scan and run_manifest_scan are top-level functions in the scanner
    assert "run_base_scan" in names, f"expected run_base_scan in {sorted(names)[:50]}"


def test_keyword_hits_contains_mechanical_hits(tmp_path: Path):
    out_dir = tmp_path / "scan"
    run_scanner(
        [
            "--repo",
            str(REPO_ROOT),
            "--task",
            "add scanner docs tests",
            "--out",
            str(out_dir),
        ]
    )
    data = json.loads((out_dir / "keyword_hits.json").read_text(encoding="utf-8"))
    keywords = {h["keyword"] for h in data["keyword_hits"]}
    # At least one of scanner/docs/tests must have hits
    assert keywords & {"scanner", "docs", "tests"}, (
        f"expected scanner/docs/tests hits in {keywords}"
    )
    for h in data["keyword_hits"]:
        for k, v in h.items():
            assert k not in ("score", "relevance", "weight"), (
                f"unexpected numeric field {k}={v}"
            )
            if isinstance(v, float):
                raise AssertionError(f"unexpected float field {k}={v}")
