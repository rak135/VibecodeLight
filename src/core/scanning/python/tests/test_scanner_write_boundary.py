"""
P0 contract test: Python scanner writes only inside the authorized --out scan directory.

Snapshots the fixture repo before and after scanner execution.
Asserts all new/modified files are under the provided --out directory.
Asserts sentinel files outside --out are byte-identical.
"""
import hashlib
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


def snapshot_files(root: Path) -> dict[str, bytes]:
    """Return {relative_path: content_hash} for all files under root, ignoring .git/."""
    result: dict[str, bytes] = {}
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        # Ignore .git/ internals to avoid false failures
        if rel.startswith(".git/"):
            continue
        result[rel] = hashlib.sha256(p.read_bytes()).digest()
    return result


def make_fixture_repo(tmp_path: Path) -> Path:
    """Create a fixture git repo with sentinel files in source, config, and .vibecode/."""
    import subprocess as sp

    repo = tmp_path / "repo"
    repo.mkdir()

    # git init
    sp.run(["git", "init", str(repo)], check=True, capture_output=True)
    sp.run(["git", "config", "user.email", "test@test.com"], check=True, capture_output=True, cwd=str(repo))
    sp.run(["git", "config", "user.name", "Test"], check=True, capture_output=True, cwd=str(repo))

    # Source sentinel
    src = repo / "src"
    src.mkdir()
    (src / "main.py").write_text('def hello():\n    return "world"\n')

    # Config sentinel
    (repo / "config.yaml").write_text("name: fixture-repo\nversion: 1\n")
    (repo / ".gitignore").write_text("*.pyc\n__pycache__/\n.env\n.vibecode/\n")

    # .vibecode/ sentinels (pre-existing run state that must not be touched)
    vibecode = repo / ".vibecode"
    current = vibecode / "current"
    current.mkdir(parents=True)
    (current / "run_manifest.json").write_text('{"run_id": "r1", "status": "done"}\n')

    run_dir = vibecode / "runs" / "r1"
    (run_dir / "output").mkdir(parents=True)
    (run_dir / "output" / "final_prompt.md").write_text("# Final Prompt\nDo the thing.\n")

    (run_dir / "flash").mkdir(parents=True)
    (run_dir / "flash" / "flash_output.md").write_text("# Task Summary\nFixture.\n")

    (run_dir / "skills").mkdir(parents=True)
    (run_dir / "skills" / "selected_skills.json").write_text('{"selected": []}\n')

    (run_dir / "terminal").mkdir(parents=True)
    (run_dir / "terminal" / "send_metadata.json").write_text('{"sent": true}\n')

    (run_dir / "after").mkdir(parents=True)
    (run_dir / "after" / "git_status_after.json").write_text('{"dirty": false}\n')

    # Scanner output directory (authorized --out target)
    scan_dir = run_dir / "scan"
    scan_dir.mkdir(parents=True)

    # Initial git commit so git commands work
    sp.run(["git", "add", "."], check=True, capture_output=True, cwd=str(repo))
    sp.run(["git", "commit", "-m", "init"], check=True, capture_output=True, cwd=str(repo))

    return repo


class TestScannerWriteBoundary:
    def test_scanner_writes_only_inside_out_directory(self, tmp_path):
        """
        P0: The Python scanner must write only inside the authorized --out
        scan directory. All sentinel files outside --out must be byte-identical
        before and after scanner execution.
        """
        repo = make_fixture_repo(tmp_path)
        scan_dir = repo / ".vibecode" / "runs" / "r1" / "scan"

        # Snapshot BEFORE
        before = snapshot_files(repo)

        # Run scanner
        result = run_scanner([
            "--repo", str(repo),
            "--task", "write boundary test",
            "--out", str(scan_dir),
        ])
        assert result.returncode == 0, f"Scanner failed:\nstdout: {result.stdout}\nstderr: {result.stderr}"

        # Snapshot AFTER
        after = snapshot_files(repo)

        # Identify new or modified files
        new_or_modified: list[str] = []
        for rel_path, after_hash in after.items():
            before_hash = before.get(rel_path)
            if before_hash is None:
                new_or_modified.append(rel_path)
            elif before_hash != after_hash:
                new_or_modified.append(rel_path)

        # All new/modified files must be under the scan directory
        scan_prefix = scan_dir.relative_to(repo).as_posix() + "/"
        violations = [f for f in new_or_modified if not f.startswith(scan_prefix)]
        assert violations == [], (
            f"Scanner wrote files outside --out directory:\n"
            f"  Authorized prefix: {scan_prefix}\n"
            f"  Violations: {violations}"
        )

        # Verify sentinel files are byte-identical
        sentinel_paths = [
            "config.yaml",
            ".gitignore",
            "src/main.py",
            ".vibecode/current/run_manifest.json",
            ".vibecode/runs/r1/output/final_prompt.md",
            ".vibecode/runs/r1/flash/flash_output.md",
            ".vibecode/runs/r1/skills/selected_skills.json",
            ".vibecode/runs/r1/terminal/send_metadata.json",
            ".vibecode/runs/r1/after/git_status_after.json",
        ]
        for sentinel in sentinel_paths:
            assert sentinel in before, f"Sentinel {sentinel} not found in pre-scan snapshot"
            assert sentinel in after, f"Sentinel {sentinel} missing after scan"
            assert before[sentinel] == after[sentinel], (
                f"Sentinel file modified by scanner: {sentinel}\n"
                f"  Before hash: {before[sentinel].hex()}\n"
                f"  After hash:  {after[sentinel].hex()}"
            )

        # Verify scanner actually produced artifacts in the scan directory
        scan_manifest = scan_dir / "scan_manifest.json"
        assert scan_manifest.exists(), "Scanner did not produce scan_manifest.json"
