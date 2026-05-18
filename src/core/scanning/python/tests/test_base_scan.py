"""
Tests for base deterministic scan artifacts.
TDD: these tests are written before implementation.
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


def make_git_repo(tmp_path: Path) -> Path:
    """Create a minimal git repo fixture."""
    import subprocess as sp
    sp.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
    sp.run(["git", "config", "user.email", "test@test.com"], check=True, capture_output=True, cwd=str(tmp_path))
    sp.run(["git", "config", "user.name", "Test"], check=True, capture_output=True, cwd=str(tmp_path))
    (tmp_path / "hello.py").write_text('print("hello")\n')
    (tmp_path / "README.md").write_text("# Test repo\n")
    (tmp_path / ".gitignore").write_text("*.pyc\n__pycache__/\n.env\n")
    sp.run(["git", "add", "."], check=True, capture_output=True, cwd=str(tmp_path))
    sp.run(["git", "commit", "-m", "init"], check=True, capture_output=True, cwd=str(tmp_path))
    return tmp_path


class TestAllRequiredArtifactsProduced:
    def test_scanner_writes_all_required_artifacts(self, tmp_path):
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr

        required = [
            "scan_manifest.json",
            "repo_tree.txt",
            "file_inventory.json",
            "git_status.json",
            "git_diff_stat.txt",
            "ignore_rules.json",
            "config_snapshot.json",
        ]
        for name in required:
            assert (out_dir / name).exists(), f"Missing artifact: {name}"

    def test_scanner_does_not_write_scan_config_json(self, tmp_path):
        """config_snapshot.json yes, scan/config.json no."""
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        assert not (out_dir / "config.json").exists(), "scan/config.json must not be created"

    def test_scanner_does_not_write_outside_out(self, tmp_path):
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        # out/ is fine; nothing else should be written to tmp_path directly (other than scan/)
        written = [p.name for p in tmp_path.iterdir() if p.is_file()]
        assert written == [], f"Scanner wrote files outside --out: {written}"


class TestRepoTree:
    def test_repo_tree_excludes_git_dir(self, tmp_path):
        (tmp_path / "hello.txt").write_text("hi")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        tree = (out_dir / "repo_tree.txt").read_text()
        assert ".git" not in tree, ".git/ must be excluded from repo_tree.txt"

    def test_repo_tree_excludes_vibecode_dir(self, tmp_path):
        vibecode_dir = tmp_path / ".vibecode"
        vibecode_dir.mkdir()
        (vibecode_dir / "run.json").write_text("{}")
        (tmp_path / "src.py").write_text("x=1")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        tree = (out_dir / "repo_tree.txt").read_text()
        assert ".vibecode" not in tree, ".vibecode/ must be excluded from repo_tree.txt"

    def test_repo_tree_respects_gitignore(self, tmp_path):
        (tmp_path / ".gitignore").write_text("ignored_file.txt\n")
        (tmp_path / "ignored_file.txt").write_text("secret")
        (tmp_path / "visible.py").write_text("x=1")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        tree = (out_dir / "repo_tree.txt").read_text()
        assert "ignored_file.txt" not in tree, "gitignored files must not appear in repo_tree.txt"
        assert "visible.py" in tree, "visible.py must appear in repo_tree.txt"


class TestFileInventory:
    def test_file_inventory_contains_expected_fields(self, tmp_path):
        (tmp_path / "hello.py").write_text('print("hello")\n')
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        inv = json.loads((out_dir / "file_inventory.json").read_text())
        assert isinstance(inv, list)
        assert len(inv) >= 1
        entry = inv[0]
        required_fields = ["path", "extension", "language_guess", "kind", "bytes", "is_test", "is_doc", "is_config", "is_manifest"]
        for field in required_fields:
            assert field in entry, f"Missing field in file_inventory.json entry: {field}"

    def test_file_inventory_includes_lines_for_text_files(self, tmp_path):
        (tmp_path / "hello.py").write_text("line1\nline2\nline3\n")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        inv = json.loads((out_dir / "file_inventory.json").read_text())
        py_entry = next((e for e in inv if e["path"].endswith("hello.py")), None)
        assert py_entry is not None
        assert "lines" in py_entry
        assert py_entry["lines"] == 3


class TestGitStatus:
    def test_git_status_works_in_git_repo(self, tmp_path):
        make_git_repo(tmp_path)
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        status = json.loads((out_dir / "git_status.json").read_text())
        assert "branch" in status
        assert "head_commit" in status
        assert "dirty" in status
        assert "git_available" in status
        assert status["git_available"] is True

    def test_git_status_handles_non_git_repo(self, tmp_path):
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        status = json.loads((out_dir / "git_status.json").read_text())
        assert "git_available" in status


class TestConfigSnapshot:
    def test_config_snapshot_is_written(self, tmp_path):
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "my task", "--out", str(out_dir)])
        snap = json.loads((out_dir / "config_snapshot.json").read_text())
        assert "repo_root" in snap
        assert "task" in snap
        assert snap["task"] == "my task"


class TestScanManifest:
    def test_scan_manifest_ok_field(self, tmp_path):
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        manifest = json.loads((out_dir / "scan_manifest.json").read_text())
        assert "ok" in manifest
        assert manifest["ok"] is True

    def test_scan_manifest_lists_produced_artifacts(self, tmp_path):
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        manifest = json.loads((out_dir / "scan_manifest.json").read_text())
        assert "artifacts" in manifest
        assert isinstance(manifest["artifacts"], dict)
        # All required artifacts should be listed
        assert "scan_manifest.json" in manifest["artifacts"]
        assert "repo_tree.txt" in manifest["artifacts"]
        assert "file_inventory.json" in manifest["artifacts"]

    def test_scan_manifest_has_scanner_version(self, tmp_path):
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        manifest = json.loads((out_dir / "scan_manifest.json").read_text())
        assert "scanner_version" in manifest


class TestIgnoreRules:
    def test_ignore_rules_written(self, tmp_path):
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
        rules = json.loads((out_dir / "ignore_rules.json").read_text())
        assert "always_excluded" in rules
        assert "gitignore_respected" in rules


class TestIntegrationFixture:
    def test_fixture_repo_produces_expected_artifacts(self, tmp_path):
        """Integration: git repo with .gitignore produces expected tree and inventory."""
        (tmp_path / ".gitignore").write_text("secret.txt\n")
        (tmp_path / "main.py").write_text("x = 1\n")
        (tmp_path / "secret.txt").write_text("do not include")
        (tmp_path / ".vibecode").mkdir()
        (tmp_path / ".vibecode" / "run.json").write_text("{}")

        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "integration test", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr

        tree = (out_dir / "repo_tree.txt").read_text()
        assert "main.py" in tree
        assert "secret.txt" not in tree
        assert ".vibecode" not in tree
        # .gitignore is fine; we just want .git/ directory excluded
        # Check no .git directory line appears (not substring of .gitignore)
        tree_lines = set(tree.splitlines())
        assert ".git" not in tree_lines, ".git directory must not appear as its own entry"

        inv = json.loads((out_dir / "file_inventory.json").read_text())
        paths = [e["path"] for e in inv]
        assert any("main.py" in p for p in paths)
        assert not any("secret.txt" in p for p in paths)
