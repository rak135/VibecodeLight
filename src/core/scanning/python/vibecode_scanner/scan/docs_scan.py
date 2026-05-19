"""
Documentation and instruction discovery.

Produces three artifact payloads:

- repo_instructions: AGENTS.md, CLAUDE.md, GEMINI.md, CONTRIBUTING.md,
  docs/CONTRIBUTING.md, .github/pull_request_template.md, .github/ISSUE_TEMPLATE/*

- docs: README.md, CHANGELOG.md, ROADMAP.md, DESIGN.md, docs/**/*.md
  (architecture/decision docs are excluded here; they live in architecture_docs)

- architecture_docs: docs/VISION.md, docs/CONTEXT.md, docs/ARCHITECTURE.md,
  docs/ARCHITECTURE_DECISIONS.md, docs/IMPLEMENTATION_MAP.md, docs/DESIGN.md,
  docs/ADR/*, docs/DECISIONS/*

Generated `.vibecode/` content is excluded.

Unreadable files (e.g., invalid UTF-8) do not crash; a warning is recorded
and the entry is still emitted with empty content.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

ALWAYS_EXCLUDED_DIRS = {".git", ".vibecode", "node_modules", ".venv", "__pycache__"}

# Repo-root level instruction files and their classification
ROOT_INSTRUCTION_FILES: dict[str, str] = {
    "AGENTS.md": "agent-instructions",
    "CLAUDE.md": "agent-instructions",
    "GEMINI.md": "agent-instructions",
    "CONTRIBUTING.md": "contributor-rules",
}

# Files under docs/ that count as instructions
DOCS_INSTRUCTION_FILES: dict[str, str] = {
    "CONTRIBUTING.md": "contributor-rules",
}

# Root-level docs that always count as documentation
ROOT_DOC_FILES = {
    "README.md",
    "CHANGELOG.md",
    "ROADMAP.md",
    "DESIGN.md",
}

# docs/<name>.md files that are architecture documents
ARCHITECTURE_DOC_NAMES = {
    "VISION.md": "vision",
    "CONTEXT.md": "context",
    "ARCHITECTURE.md": "architecture",
    "ARCHITECTURE_DECISIONS.md": "architecture-decisions",
    "IMPLEMENTATION_MAP.md": "implementation-map",
    "DESIGN.md": "design",
}

# Directories under docs/ whose markdown files are decision documents
DECISION_DIRS = {"ADR", "DECISIONS"}


def _rel(p: Path, root: Path) -> str:
    return str(p.relative_to(root)).replace("\\", "/")


def _in_excluded_dir(rel_str: str) -> bool:
    parts = rel_str.split("/")
    return any(part in ALWAYS_EXCLUDED_DIRS for part in parts[:-1])


def _read_text_safely(path: Path, rel_str: str, warnings: list[str]) -> tuple[str, int]:
    """Return (content, bytes). On decode failure, record a warning and return ('', size)."""
    try:
        byte_size = path.stat().st_size
    except OSError as exc:
        warnings.append(f"failed to stat {rel_str}: {exc}")
        return "", 0
    try:
        return path.read_text(encoding="utf-8"), byte_size
    except UnicodeDecodeError as exc:
        warnings.append(f"failed to decode {rel_str} as utf-8: {exc}")
        return "", byte_size
    except OSError as exc:
        warnings.append(f"failed to read {rel_str}: {exc}")
        return "", byte_size


_FENCE_RE = re.compile(r"^```")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")


def _extract_markdown_headings(content: str, source_path: str) -> list[dict[str, Any]]:
    """Extract ATX headings (#..######) outside fenced code blocks.

    Each entry includes the source path so headings preserve provenance.
    """
    if not content:
        return []
    headings: list[dict[str, Any]] = []
    in_fence = False
    for line in content.splitlines():
        stripped = line.lstrip()
        if _FENCE_RE.match(stripped):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING_RE.match(stripped)
        if not m:
            continue
        level = len(m.group(1))
        text = m.group(2).strip()
        headings.append({"text": text, "level": level, "path": source_path})
    return headings


def _markdown_entry(repo_root: Path, path: Path, warnings: list[str]) -> dict[str, Any]:
    rel = _rel(path, repo_root)
    content, byte_size = _read_text_safely(path, rel, warnings)
    return {
        "path": rel,
        "content": content,
        "headings": _extract_markdown_headings(content, rel),
        "bytes": byte_size,
    }


# ---------------------------------------------------------------------------
# repo_instructions
# ---------------------------------------------------------------------------


def _collect_repo_instructions(repo_root: Path, warnings: list[str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    for name, source_type in ROOT_INSTRUCTION_FILES.items():
        p = repo_root / name
        if p.is_file():
            entry = _markdown_entry(repo_root, p, warnings)
            entry["source_type"] = source_type
            entries.append(entry)

    docs_dir = repo_root / "docs"
    if docs_dir.is_dir():
        for name, source_type in DOCS_INSTRUCTION_FILES.items():
            p = docs_dir / name
            if p.is_file():
                entry = _markdown_entry(repo_root, p, warnings)
                entry["source_type"] = source_type
                entries.append(entry)

    github_dir = repo_root / ".github"
    pr_template = github_dir / "pull_request_template.md"
    if pr_template.is_file():
        entry = _markdown_entry(repo_root, pr_template, warnings)
        entry["source_type"] = "pull-request-template"
        entries.append(entry)

    issue_template_dir = github_dir / "ISSUE_TEMPLATE"
    if issue_template_dir.is_dir():
        for p in sorted(issue_template_dir.iterdir()):
            if p.is_file() and p.suffix.lower() in (".md", ".yml", ".yaml"):
                entry = _markdown_entry(repo_root, p, warnings)
                entry["source_type"] = "issue-template"
                entries.append(entry)

    entries.sort(key=lambda e: e["path"])
    return entries


def run_repo_instructions_scan(repo_root: Path) -> dict[str, Any]:
    warnings: list[str] = []
    entries = _collect_repo_instructions(repo_root, warnings)
    return {"repo_instructions": entries, "warnings": warnings}


# ---------------------------------------------------------------------------
# architecture_docs
# ---------------------------------------------------------------------------


def _is_architecture_doc(rel_str: str) -> str | None:
    """Return doc_type if rel_str is an architecture/decision doc, else None."""
    if not rel_str.startswith("docs/"):
        return None
    parts = rel_str.split("/")
    if len(parts) == 2:
        name = parts[1]
        return ARCHITECTURE_DOC_NAMES.get(name)
    if len(parts) >= 3 and parts[1] in DECISION_DIRS and parts[-1].lower().endswith(".md"):
        return "decision"
    return None


def _collect_architecture_docs(repo_root: Path, warnings: list[str]) -> list[dict[str, Any]]:
    docs_dir = repo_root / "docs"
    if not docs_dir.is_dir():
        return []

    entries: list[dict[str, Any]] = []

    # Top-level architecture docs in docs/
    for name, doc_type in ARCHITECTURE_DOC_NAMES.items():
        p = docs_dir / name
        if p.is_file():
            entry = _markdown_entry(repo_root, p, warnings)
            entry["doc_type"] = doc_type
            entries.append(entry)

    # Decision dirs (ADR, DECISIONS)
    for dec_name in DECISION_DIRS:
        dec_dir = docs_dir / dec_name
        if not dec_dir.is_dir():
            continue
        for p in sorted(dec_dir.rglob("*")):
            if not p.is_file():
                continue
            if p.suffix.lower() != ".md":
                continue
            rel = _rel(p, repo_root)
            if _in_excluded_dir(rel):
                continue
            entry = _markdown_entry(repo_root, p, warnings)
            entry["doc_type"] = "decision"
            entries.append(entry)

    entries.sort(key=lambda e: e["path"])
    return entries


def run_architecture_docs_scan(repo_root: Path) -> dict[str, Any]:
    warnings: list[str] = []
    entries = _collect_architecture_docs(repo_root, warnings)
    return {"architecture_docs": entries, "warnings": warnings}


# ---------------------------------------------------------------------------
# docs
# ---------------------------------------------------------------------------


def _collect_docs(repo_root: Path, warnings: list[str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()

    # Root-level top docs
    for name in sorted(ROOT_DOC_FILES):
        p = repo_root / name
        if p.is_file():
            rel = _rel(p, repo_root)
            if rel in seen:
                continue
            entries.append(_markdown_entry(repo_root, p, warnings))
            seen.add(rel)

    # docs/**/*.md
    docs_dir = repo_root / "docs"
    if docs_dir.is_dir():
        for p in sorted(docs_dir.rglob("*.md")):
            if not p.is_file():
                continue
            rel = _rel(p, repo_root)
            if _in_excluded_dir(rel):
                continue
            # Skip architecture/decision documents (categorized separately)
            if _is_architecture_doc(rel) is not None:
                continue
            # Skip CONTRIBUTING.md under docs/ (categorized as instructions)
            if Path(rel).name in DOCS_INSTRUCTION_FILES:
                continue
            if rel in seen:
                continue
            entries.append(_markdown_entry(repo_root, p, warnings))
            seen.add(rel)

    entries.sort(key=lambda e: e["path"])
    return entries


def run_docs_scan(repo_root: Path) -> dict[str, Any]:
    warnings: list[str] = []
    entries = _collect_docs(repo_root, warnings)
    return {"docs": entries, "warnings": warnings}
