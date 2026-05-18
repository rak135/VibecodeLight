import json
import subprocess
import sys
from pathlib import Path


def test_help_exits_zero():
    result = subprocess.run(
        [sys.executable, "-m", "vibecode_scanner", "--help"],
        capture_output=True,
        text=True,
        cwd=Path(__file__).parent.parent,
    )
    assert result.returncode == 0
    assert "vibecode" in result.stdout.lower() or "scanner" in result.stdout.lower()


def test_writes_scan_manifest_when_out_provided(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "vibecode_scanner",
            "--repo",
            str(tmp_path),
            "--task",
            "test task",
            "--out",
            str(tmp_path / "scan"),
        ],
        capture_output=True,
        text=True,
        cwd=Path(__file__).parent.parent,
    )
    assert result.returncode == 0
    manifest = json.loads((tmp_path / "scan" / "scan_manifest.json").read_text())
    assert manifest["ok"] is True
