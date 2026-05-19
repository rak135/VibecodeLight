"""
Base deterministic scan artifacts for VibecodeLight.

Implements:
- repo_tree.txt: complete non-ignored path tree, no .git, no .vibecode
- file_inventory.json: per-file metadata
- git_status.json: git state
- git_diff_stat.txt: git diff --stat output
- ignore_rules.json: ignore source summary
- config_snapshot.json: resolved scanner config snapshot
- scan_manifest.json: artifact index and status
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from .command_scan import run_command_scan
from .docs_scan import (
    run_architecture_docs_scan,
    run_docs_scan,
    run_repo_instructions_scan,
)
from .environment_scan import run_environment_scan
from .manifest_scan import run_manifest_scan
from .tooling_scan import run_tooling_scan

SCANNER_VERSION = "0.4.0"

ALWAYS_EXCLUDED = [".git", ".vibecode"]

# Language detection map by extension
LANGUAGE_MAP: dict[str, str] = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".md": "markdown",
    ".txt": "text",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".ps1": "powershell",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".sql": "sql",
    ".r": "r",
    ".lua": "lua",
    ".dart": "dart",
    ".ex": "elixir",
    ".exs": "elixir",
    ".hs": "haskell",
    ".ml": "ocaml",
    ".lock": "lockfile",
    ".env": "env",
    ".gitignore": "gitignore",
    ".dockerignore": "dockerignore",
}

DOC_EXTENSIONS = {".md", ".rst", ".txt", ".adoc", ".asciidoc"}
CONFIG_EXTENSIONS = {".yaml", ".yml", ".toml", ".json", ".ini", ".cfg", ".conf", ".env"}
MANIFEST_NAMES = {
    "package.json", "pyproject.toml", "setup.py", "setup.cfg",
    "cargo.toml", "go.mod", "pom.xml", "build.gradle", "composer.json",
    "gemfile", "requirements.txt", "pipfile", "poetry.lock", "uv.lock",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
}
TEST_PATTERNS = ["test_", "_test", ".test.", ".spec.", "/tests/", "/test/", "__tests__"]


def _load_gitignore_patterns(repo_root: Path) -> list[str]:
    """Load patterns from .gitignore at repo root."""
    gitignore_path = repo_root / ".gitignore"
    if not gitignore_path.exists():
        return []
    patterns = []
    for line in gitignore_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            patterns.append(line)
    return patterns


def _matches_gitignore(rel_path_str: str, patterns: list[str]) -> bool:
    """Simple gitignore matching (covers common cases)."""
    import fnmatch

    rel_path_str = rel_path_str.replace("\\", "/")
    name = rel_path_str.split("/")[-1]

    for pat in patterns:
        pat = pat.lstrip("/")
        # Match by name
        if fnmatch.fnmatch(name, pat):
            return True
        # Match full relative path
        if fnmatch.fnmatch(rel_path_str, pat):
            return True
        # Directory pattern
        if pat.endswith("/"):
            dir_pat = pat.rstrip("/")
            if fnmatch.fnmatch(name, dir_pat):
                return True
            for segment in rel_path_str.split("/"):
                if fnmatch.fnmatch(segment, dir_pat):
                    return True
    return False


def _collect_non_ignored_paths(repo_root: Path, gitignore_patterns: list[str]) -> list[Path]:
    """Walk repo_root and collect non-ignored paths."""
    result: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(repo_root):
        dir_path = Path(dirpath)
        rel_dir = dir_path.relative_to(repo_root)

        # Prune always-excluded directories
        dirnames[:] = [
            d for d in dirnames
            if d not in ALWAYS_EXCLUDED
            and not _matches_gitignore(
                (str(rel_dir / d)).replace("\\", "/") if str(rel_dir) != "." else d,
                gitignore_patterns,
            )
        ]

        for filename in filenames:
            rel_file = rel_dir / filename if str(rel_dir) != "." else Path(filename)
            rel_str = str(rel_file).replace("\\", "/")
            if not _matches_gitignore(rel_str, gitignore_patterns):
                result.append(rel_file)

    result.sort(key=lambda p: str(p))
    return result


def _build_repo_tree(paths: list[Path]) -> str:
    """Build a tree-style text representation of the paths."""
    lines = []
    for p in paths:
        depth = len(p.parts) - 1
        indent = "  " * depth
        lines.append(f"{indent}{p.name}")
    return "\n".join(lines) + "\n" if lines else "(empty)\n"


def _classify_file(rel_path: Path) -> dict[str, Any]:
    """Classify a file and return metadata fields."""
    ext = rel_path.suffix.lower()
    name_lower = rel_path.name.lower()
    rel_str = str(rel_path).replace("\\", "/")

    language_guess = LANGUAGE_MAP.get(ext, "unknown")
    # Special cases
    if name_lower in (".gitignore", ".dockerignore", ".gitattributes"):
        language_guess = "gitignore"
    elif name_lower in ("makefile", "dockerfile", "containerfile"):
        language_guess = name_lower

    is_test = any(p in rel_str for p in TEST_PATTERNS)
    is_doc = ext in DOC_EXTENSIONS or name_lower in ("readme", "license", "changelog", "authors", "contributing")
    is_config = ext in CONFIG_EXTENSIONS or name_lower in ("makefile", ".env", ".env.example")
    is_manifest = name_lower in MANIFEST_NAMES

    kind = "source"
    if is_test:
        kind = "test"
    elif is_doc:
        kind = "doc"
    elif is_manifest:
        kind = "manifest"
    elif is_config:
        kind = "config"

    return {
        "language_guess": language_guess,
        "kind": kind,
        "is_test": is_test,
        "is_doc": is_doc,
        "is_config": is_config,
        "is_manifest": is_manifest,
    }


def _file_inventory_entry(repo_root: Path, rel_path: Path) -> dict[str, Any]:
    abs_path = repo_root / rel_path
    ext = rel_path.suffix.lower()
    classification = _classify_file(rel_path)

    try:
        byte_size = abs_path.stat().st_size
    except OSError:
        byte_size = 0

    entry: dict[str, Any] = {
        "path": str(rel_path).replace("\\", "/"),
        "extension": ext,
        "bytes": byte_size,
        **classification,
    }

    # Try reading lines for text files
    try:
        text = abs_path.read_text(encoding="utf-8", errors="strict")
        entry["lines"] = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
        if text.endswith("\n") and text:
            entry["lines"] = text.count("\n")
    except (UnicodeDecodeError, OSError):
        pass  # Binary or unreadable; no 'lines' key

    return entry


def _run_git(args: list[str], cwd: Path) -> tuple[bool, str]:
    """Run a git command; return (success, output)."""
    try:
        result = subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            cwd=str(cwd),
            timeout=15,
        )
        return result.returncode == 0, result.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False, ""


def _gather_git_status(repo_root: Path) -> dict[str, Any]:
    ok, branch_out = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], repo_root)
    if not ok:
        return {
            "git_available": False,
            "branch": None,
            "head_commit": None,
            "dirty": None,
            "modified": [],
            "untracked": [],
            "staged": [],
            "diagnostic": "git not available or not a git repo",
        }

    branch = branch_out.strip()
    _, head_out = _run_git(["rev-parse", "HEAD"], repo_root)
    head_commit = head_out.strip() or None

    _, status_out = _run_git(["status", "--porcelain"], repo_root)
    modified = []
    untracked = []
    staged = []
    for line in status_out.splitlines():
        if len(line) < 2:
            continue
        xy = line[:2]
        fname = line[3:]
        if xy[0] in ("M", "A", "D", "R", "C") and xy[0] != " ":
            staged.append(fname)
        if xy[1] in ("M", "D"):
            modified.append(fname)
        if xy == "??":
            untracked.append(fname)

    dirty = bool(status_out.strip())

    return {
        "git_available": True,
        "branch": branch,
        "head_commit": head_commit,
        "dirty": dirty,
        "modified": modified,
        "untracked": untracked,
        "staged": staged,
    }


def _gather_git_diff_stat(repo_root: Path) -> tuple[str, str | None]:
    """Return (diff_stat_text, warning_or_none)."""
    ok, out = _run_git(["diff", "--stat"], repo_root)
    if not ok:
        warning = "git diff --stat unavailable: git not available or not a git repo"
        return f"[diagnostic] {warning}\n", warning
    return out or "(no changes)\n", None


def run_base_scan(
    repo_root: Path,
    task: str,
    out_dir: Path,
    run_id: str | None = None,
    scanner_config_path: Path | None = None,
) -> dict[str, Any]:
    """
    Run all base scan steps and write artifacts to out_dir.
    Returns a summary dict.
    """
    out_dir.mkdir(parents=True, exist_ok=True)

    warnings: list[str] = []
    errors: list[str] = []

    # 1. Load gitignore
    gitignore_patterns = _load_gitignore_patterns(repo_root)
    gitignore_found = (repo_root / ".gitignore").exists()

    # 2. Collect non-ignored paths
    paths = _collect_non_ignored_paths(repo_root, gitignore_patterns)

    # 3. repo_tree.txt
    tree_text = _build_repo_tree(paths)
    (out_dir / "repo_tree.txt").write_text(tree_text, encoding="utf-8")

    # 4. file_inventory.json
    inventory = [_file_inventory_entry(repo_root, p) for p in paths]
    (out_dir / "file_inventory.json").write_text(
        json.dumps(inventory, indent=2), encoding="utf-8"
    )

    # 5. git_status.json
    git_status = _gather_git_status(repo_root)
    (out_dir / "git_status.json").write_text(
        json.dumps(git_status, indent=2), encoding="utf-8"
    )

    # 6. git_diff_stat.txt
    diff_stat_text, diff_warning = _gather_git_diff_stat(repo_root)
    if diff_warning:
        warnings.append(diff_warning)
    (out_dir / "git_diff_stat.txt").write_text(diff_stat_text, encoding="utf-8")

    # 7. ignore_rules.json
    ignore_rules = {
        "always_excluded": ALWAYS_EXCLUDED,
        "ignore_sources_found": [".gitignore"] if gitignore_found else [],
        "gitignore_respected": True,
        "gitignore_pattern_count": len(gitignore_patterns),
    }
    (out_dir / "ignore_rules.json").write_text(
        json.dumps(ignore_rules, indent=2), encoding="utf-8"
    )

    # 8. config_snapshot.json
    config_snapshot: dict[str, Any] = {
        "scanner_version": SCANNER_VERSION,
        "repo_root": str(repo_root),
        "task": task,
        "run_id": run_id,
        "scanner_config_path": str(scanner_config_path) if scanner_config_path else None,
    }
    (out_dir / "config_snapshot.json").write_text(
        json.dumps(config_snapshot, indent=2), encoding="utf-8"
    )

    # 9. manifests.json
    manifest_result = run_manifest_scan(repo_root)
    warnings.extend(manifest_result.get("warnings", []))
    (out_dir / "manifests.json").write_text(
        json.dumps(manifest_result, indent=2), encoding="utf-8"
    )

    # 10. commands.json
    command_result = run_command_scan(repo_root)
    warnings.extend(command_result.get("warnings", []))
    (out_dir / "commands.json").write_text(
        json.dumps(command_result, indent=2), encoding="utf-8"
    )

    # 11. tooling.json
    tooling_result = run_tooling_scan(repo_root)
    warnings.extend(tooling_result.get("warnings", []))
    (out_dir / "tooling.json").write_text(
        json.dumps(tooling_result, indent=2), encoding="utf-8"
    )

    # 12. environment.json (local runtime facts, separate from repo declarations)
    environment_result = run_environment_scan()
    warnings.extend(environment_result.get("warnings", []))
    (out_dir / "environment.json").write_text(
        json.dumps(environment_result, indent=2), encoding="utf-8"
    )

    # 13. repo_instructions.json
    repo_instructions_result = run_repo_instructions_scan(repo_root)
    warnings.extend(repo_instructions_result.get("warnings", []))
    (out_dir / "repo_instructions.json").write_text(
        json.dumps(repo_instructions_result, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # 14. docs.json
    docs_result = run_docs_scan(repo_root)
    warnings.extend(docs_result.get("warnings", []))
    (out_dir / "docs.json").write_text(
        json.dumps(docs_result, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # 15. architecture_docs.json
    architecture_docs_result = run_architecture_docs_scan(repo_root)
    warnings.extend(architecture_docs_result.get("warnings", []))
    (out_dir / "architecture_docs.json").write_text(
        json.dumps(architecture_docs_result, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # 16. scan_manifest.json (last - references all others)
    produced_artifacts = {
        "scan_manifest.json": str(out_dir / "scan_manifest.json"),
        "repo_tree.txt": str(out_dir / "repo_tree.txt"),
        "file_inventory.json": str(out_dir / "file_inventory.json"),
        "git_status.json": str(out_dir / "git_status.json"),
        "git_diff_stat.txt": str(out_dir / "git_diff_stat.txt"),
        "ignore_rules.json": str(out_dir / "ignore_rules.json"),
        "config_snapshot.json": str(out_dir / "config_snapshot.json"),
        "manifests.json": str(out_dir / "manifests.json"),
        "commands.json": str(out_dir / "commands.json"),
        "tooling.json": str(out_dir / "tooling.json"),
        "environment.json": str(out_dir / "environment.json"),
        "repo_instructions.json": str(out_dir / "repo_instructions.json"),
        "docs.json": str(out_dir / "docs.json"),
        "architecture_docs.json": str(out_dir / "architecture_docs.json"),
    }
    scan_manifest: dict[str, Any] = {
        "ok": True,
        "scanner_version": SCANNER_VERSION,
        "repo_root": str(repo_root),
        "task": task,
        "run_id": run_id,
        "artifacts": produced_artifacts,
        "warnings": warnings,
        "errors": errors,
    }
    (out_dir / "scan_manifest.json").write_text(
        json.dumps(scan_manifest, indent=2), encoding="utf-8"
    )

    return scan_manifest
