"""
Tests for environment scan: capture locally installed tool versions.
Missing tools must produce warnings, never crashes.
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


def scan(tmp_path: Path) -> dict:
    out_dir = tmp_path / "scan"
    result = run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
    assert result.returncode == 0, result.stderr
    return json.loads((out_dir / "environment.json").read_text(encoding="utf-8"))


class TestEnvironment:
    def test_environment_has_tools_map(self, tmp_path):
        data = scan(tmp_path)
        assert "tools" in data
        assert isinstance(data["tools"], dict)
        # Each expected tool either has version (string) or null + warning recorded
        for expected in ["python", "node", "pnpm", "npm", "uv", "git"]:
            assert expected in data["tools"]
            entry = data["tools"][expected]
            assert "version" in entry  # may be None
            assert "available" in entry

    def test_warnings_list_present(self, tmp_path):
        data = scan(tmp_path)
        assert "warnings" in data
        assert isinstance(data["warnings"], list)

    def test_python_should_be_available(self, tmp_path):
        # Python is required to run the scanner so it must be available
        data = scan(tmp_path)
        assert data["tools"]["python"]["available"] is True
        assert data["tools"]["python"]["version"] is not None

    def test_missing_tool_does_not_crash(self, tmp_path):
        # If a tool is missing, the scan must still succeed and the tool's
        # entry should mark it unavailable rather than crashing.
        data = scan(tmp_path)
        for name, entry in data["tools"].items():
            if not entry["available"]:
                assert entry["version"] is None


class TestEnvironmentSeparatedFromManifests:
    def test_environment_is_separate_artifact_from_manifests(self, tmp_path):
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        # Two distinct files
        assert (out_dir / "environment.json").exists()
        assert (out_dir / "manifests.json").exists()
