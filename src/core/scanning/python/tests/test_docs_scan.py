"""
Tests for documentation and instruction scan artifacts.

TDD: tests are written before implementation.

Covers:
- repo_instructions.json: AGENTS.md, CONTRIBUTING.md, .github/pull_request_template.md, .github/ISSUE_TEMPLATE/*
- docs.json: README.md, docs/**/*.md, CHANGELOG.md, ROADMAP.md, DESIGN.md
- architecture_docs.json: docs/VISION.md, docs/CONTEXT.md, docs/ARCHITECTURE.md,
  docs/ARCHITECTURE_DECISIONS.md, docs/IMPLEMENTATION_MAP.md, docs/ADR/*, docs/DECISIONS/*
- Markdown headings are extracted
- Unicode is preserved
- Unreadable files do not crash; warnings are recorded
- .vibecode/ docs are excluded
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


def _entry_by_path(entries: list[dict], path: str) -> dict | None:
    for e in entries:
        if e.get("path") == path:
            return e
    return None


# ---------------------------------------------------------------------------
# repo_instructions.json
# ---------------------------------------------------------------------------


class TestRepoInstructions:
    def test_agents_md_is_captured(self, tmp_path: Path):
        (tmp_path / "AGENTS.md").write_text(
            "# Agents\n\nGuide for agents.\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "repo_instructions.json").read_text(encoding="utf-8"))
        entries = data["repo_instructions"]
        entry = _entry_by_path(entries, "AGENTS.md")
        assert entry is not None, f"AGENTS.md not captured: {entries}"
        assert entry["source_type"] == "agent-instructions"
        assert "Guide for agents" in entry["content"]
        assert entry["bytes"] > 0

    def test_contributing_md_is_captured(self, tmp_path: Path):
        (tmp_path / "CONTRIBUTING.md").write_text(
            "# Contributing\n\nRules.\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "repo_instructions.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["repo_instructions"], "CONTRIBUTING.md")
        assert entry is not None
        assert entry["source_type"] == "contributor-rules"
        assert "Rules" in entry["content"]

    def test_docs_contributing_md_is_captured(self, tmp_path: Path):
        docs = tmp_path / "docs"
        docs.mkdir()
        (docs / "CONTRIBUTING.md").write_text("# Docs Contributing\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "repo_instructions.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["repo_instructions"], "docs/CONTRIBUTING.md")
        assert entry is not None

    def test_pull_request_template_is_captured(self, tmp_path: Path):
        gh = tmp_path / ".github"
        gh.mkdir()
        (gh / "pull_request_template.md").write_text(
            "## PR Template\n\nChecklist.\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "repo_instructions.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["repo_instructions"], ".github/pull_request_template.md")
        assert entry is not None
        assert entry["source_type"] == "pull-request-template"

    def test_issue_templates_are_captured(self, tmp_path: Path):
        tdir = tmp_path / ".github" / "ISSUE_TEMPLATE"
        tdir.mkdir(parents=True)
        (tdir / "bug.md").write_text("# Bug\n", encoding="utf-8")
        (tdir / "feature.md").write_text("# Feature\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "repo_instructions.json").read_text(encoding="utf-8"))
        paths = [e["path"] for e in data["repo_instructions"]]
        assert ".github/ISSUE_TEMPLATE/bug.md" in paths
        assert ".github/ISSUE_TEMPLATE/feature.md" in paths

    def test_claude_and_gemini_files_are_captured(self, tmp_path: Path):
        (tmp_path / "CLAUDE.md").write_text("# Claude rules\n", encoding="utf-8")
        (tmp_path / "GEMINI.md").write_text("# Gemini rules\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "repo_instructions.json").read_text(encoding="utf-8"))
        paths = [e["path"] for e in data["repo_instructions"]]
        assert "CLAUDE.md" in paths
        assert "GEMINI.md" in paths

    def test_repo_instructions_includes_headings(self, tmp_path: Path):
        (tmp_path / "AGENTS.md").write_text(
            "# Top\n\n## Section A\n\n### Subsection\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "repo_instructions.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["repo_instructions"], "AGENTS.md")
        assert entry is not None
        headings = entry["headings"]
        heading_texts = [h["text"] for h in headings]
        assert "Top" in heading_texts
        assert "Section A" in heading_texts
        assert "Subsection" in heading_texts


# ---------------------------------------------------------------------------
# docs.json
# ---------------------------------------------------------------------------


class TestDocs:
    def test_readme_md_is_captured(self, tmp_path: Path):
        (tmp_path / "README.md").write_text(
            "# Readme\n\nIntro.\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "docs.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["docs"], "README.md")
        assert entry is not None
        assert "Intro" in entry["content"]
        assert entry["bytes"] > 0

    def test_docs_top_level_md_is_captured(self, tmp_path: Path):
        docs = tmp_path / "docs"
        docs.mkdir()
        (docs / "GUIDE.md").write_text("# Guide\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "docs.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["docs"], "docs/GUIDE.md")
        assert entry is not None

    def test_docs_nested_md_is_captured(self, tmp_path: Path):
        nested = tmp_path / "docs" / "nested"
        nested.mkdir(parents=True)
        (nested / "page.md").write_text("# Nested\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "docs.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["docs"], "docs/nested/page.md")
        assert entry is not None

    def test_changelog_roadmap_design_are_captured(self, tmp_path: Path):
        (tmp_path / "CHANGELOG.md").write_text("# Changelog\n", encoding="utf-8")
        (tmp_path / "ROADMAP.md").write_text("# Roadmap\n", encoding="utf-8")
        (tmp_path / "DESIGN.md").write_text("# Design\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "docs.json").read_text(encoding="utf-8"))
        paths = [e["path"] for e in data["docs"]]
        assert "CHANGELOG.md" in paths
        assert "ROADMAP.md" in paths
        assert "DESIGN.md" in paths

    def test_docs_headings_are_extracted(self, tmp_path: Path):
        (tmp_path / "README.md").write_text(
            "# Project\n\n## Install\n\n## Usage\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "docs.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["docs"], "README.md")
        assert entry is not None
        heading_texts = [h["text"] for h in entry["headings"]]
        assert heading_texts == ["Project", "Install", "Usage"]

    def test_unicode_content_is_preserved(self, tmp_path: Path):
        content = "# Příklad\n\nText čeština: ěščřžýáíé 中文 🚀.\n"
        (tmp_path / "README.md").write_text(content, encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "docs.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["docs"], "README.md")
        assert entry is not None
        assert "Příklad" in entry["content"]
        assert "中文" in entry["content"]
        assert "🚀" in entry["content"]

    def test_vibecode_docs_are_excluded(self, tmp_path: Path):
        vibe = tmp_path / ".vibecode" / "runs" / "x" / "scan"
        vibe.mkdir(parents=True)
        (vibe / "notes.md").write_text("# Internal\n", encoding="utf-8")
        (tmp_path / "README.md").write_text("# Real\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "docs.json").read_text(encoding="utf-8"))
        paths = [e["path"] for e in data["docs"]]
        assert "README.md" in paths
        for p in paths:
            assert not p.startswith(".vibecode"), f"unexpected .vibecode entry: {p}"

    def test_binary_or_unreadable_doc_records_warning_and_does_not_crash(self, tmp_path: Path):
        docs = tmp_path / "docs"
        docs.mkdir()
        # Write a file with invalid UTF-8 bytes to force a decode failure
        (docs / "broken.md").write_bytes(b"\xff\xfe\x00\x00\xff broken \xff")
        (docs / "good.md").write_text("# Good\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "docs.json").read_text(encoding="utf-8"))
        warnings = data.get("warnings", [])
        # broken.md should appear with a warning, not crash the scan
        broken_warnings = [w for w in warnings if "broken.md" in w]
        assert broken_warnings, f"expected warning for broken.md, got: {warnings}"
        # good.md must still be captured
        paths = [e["path"] for e in data["docs"]]
        assert "docs/good.md" in paths


# ---------------------------------------------------------------------------
# architecture_docs.json
# ---------------------------------------------------------------------------


class TestArchitectureDocs:
    def test_canonical_architecture_docs_are_captured(self, tmp_path: Path):
        docs = tmp_path / "docs"
        docs.mkdir()
        (docs / "VISION.md").write_text("# Vision\n", encoding="utf-8")
        (docs / "CONTEXT.md").write_text("# Context\n", encoding="utf-8")
        (docs / "ARCHITECTURE.md").write_text("# Architecture\n", encoding="utf-8")
        (docs / "ARCHITECTURE_DECISIONS.md").write_text("# Decisions\n", encoding="utf-8")
        (docs / "IMPLEMENTATION_MAP.md").write_text("# Map\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "architecture_docs.json").read_text(encoding="utf-8"))
        paths = [e["path"] for e in data["architecture_docs"]]
        for expected in [
            "docs/VISION.md",
            "docs/CONTEXT.md",
            "docs/ARCHITECTURE.md",
            "docs/ARCHITECTURE_DECISIONS.md",
            "docs/IMPLEMENTATION_MAP.md",
        ]:
            assert expected in paths, f"missing {expected} in {paths}"

    def test_architecture_doc_entry_has_required_fields(self, tmp_path: Path):
        docs = tmp_path / "docs"
        docs.mkdir()
        (docs / "ARCHITECTURE.md").write_text(
            "# Arch\n\n## Layers\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "architecture_docs.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["architecture_docs"], "docs/ARCHITECTURE.md")
        assert entry is not None
        for field in ("path", "doc_type", "content", "headings", "bytes"):
            assert field in entry, f"missing field {field}"
        assert entry["doc_type"] == "architecture"
        assert entry["bytes"] > 0
        heading_texts = [h["text"] for h in entry["headings"]]
        assert "Arch" in heading_texts
        assert "Layers" in heading_texts

    def test_adr_directory_files_are_captured(self, tmp_path: Path):
        adr = tmp_path / "docs" / "ADR"
        adr.mkdir(parents=True)
        (adr / "0001-use-typescript.md").write_text("# ADR 1\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "architecture_docs.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["architecture_docs"], "docs/ADR/0001-use-typescript.md")
        assert entry is not None
        assert entry["doc_type"] == "decision"

    def test_decisions_directory_files_are_captured(self, tmp_path: Path):
        dec = tmp_path / "docs" / "DECISIONS"
        dec.mkdir(parents=True)
        (dec / "001-naming.md").write_text("# Decision 001\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        data = json.loads((out_dir / "architecture_docs.json").read_text(encoding="utf-8"))
        entry = _entry_by_path(data["architecture_docs"], "docs/DECISIONS/001-naming.md")
        assert entry is not None
        assert entry["doc_type"] == "decision"

    def test_architecture_docs_are_not_in_docs_json(self, tmp_path: Path):
        """
        Architecture/decision docs are categorized in architecture_docs.json.
        They must not also appear as plain docs entries to avoid duplication.
        """
        docs = tmp_path / "docs"
        docs.mkdir()
        (docs / "ARCHITECTURE.md").write_text("# A\n", encoding="utf-8")
        (docs / "GUIDE.md").write_text("# G\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        docs_data = json.loads((out_dir / "docs.json").read_text(encoding="utf-8"))
        docs_paths = [e["path"] for e in docs_data["docs"]]
        assert "docs/ARCHITECTURE.md" not in docs_paths
        assert "docs/GUIDE.md" in docs_paths


# ---------------------------------------------------------------------------
# scan_manifest integration
# ---------------------------------------------------------------------------


class TestScanManifest:
    def test_scan_manifest_lists_new_doc_artifacts(self, tmp_path: Path):
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        manifest = json.loads((out_dir / "scan_manifest.json").read_text(encoding="utf-8"))
        for name in ("repo_instructions.json", "docs.json", "architecture_docs.json"):
            assert name in manifest["artifacts"], f"missing {name} in artifacts"

    def test_existing_base_artifacts_remain(self, tmp_path: Path):
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        manifest = json.loads((out_dir / "scan_manifest.json").read_text(encoding="utf-8"))
        artifacts = manifest["artifacts"]
        for name in (
            "scan_manifest.json",
            "repo_tree.txt",
            "file_inventory.json",
            "git_status.json",
            "git_diff_stat.txt",
            "ignore_rules.json",
            "config_snapshot.json",
            "manifests.json",
            "environment.json",
            "commands.json",
            "tooling.json",
        ):
            assert name in artifacts, f"existing artifact missing: {name}"
