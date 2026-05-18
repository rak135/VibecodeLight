"""
scan_manifest.json must reference the new artifacts.
"""
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


def test_scan_manifest_lists_new_artifacts(tmp_path):
    out_dir = tmp_path / "scan"
    result = run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
    assert result.returncode == 0, result.stderr
    manifest = json.loads((out_dir / "scan_manifest.json").read_text(encoding="utf-8"))
    artifacts = manifest["artifacts"]
    for name in ["manifests.json", "environment.json", "commands.json", "tooling.json"]:
        assert name in artifacts, f"scan_manifest.json missing {name}"
    # Existing base artifacts must remain
    for name in [
        "repo_tree.txt",
        "file_inventory.json",
        "git_status.json",
        "git_diff_stat.txt",
        "ignore_rules.json",
        "config_snapshot.json",
    ]:
        assert name in artifacts, f"scan_manifest.json missing existing artifact {name}"
