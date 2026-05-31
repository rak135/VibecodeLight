"""Deterministic exact-text evidence extraction from the raw user task.

This module intentionally does not score relevance or use fuzzy/semantic matching.
It extracts high-confidence pasted strings from the raw task and scans the already
considered repository text files for exact or normalized-whitespace occurrences.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable

MIN_EXACT_PHRASE_LEN = 20
MAX_EXACT_PHRASES = 10
MAX_FILE_BYTES = 1_000_000
MAX_EXCERPT_CHARS = 240

_QUOTED_RE = re.compile(r'"([^"\n]{20,})"')
_SINGLE_QUOTED_RE = re.compile(r"'([^'\n]{20,})'")
_PAREN_RE = re.compile(r"\(([^()]{20,})\)")
_ERROR_PREFIX_RE = re.compile(
    r"\b(?:error|exception|traceback|warning|failed|failure)\s*[:\-]\s*(.{20,})",
    re.IGNORECASE,
)
_DASH_OR_COLON_RE = re.compile(r"(?:^|\s)[\-–—:]\s*(.{35,})")
_WHITESPACE_RE = re.compile(r"\s+")
_WORD_RE = re.compile(r"[A-Za-zÀ-ž0-9]+")

_GENERIC_PHRASES = {
    "task normalizer",
    "context selection",
    "selected files",
    "files to inspect",
    "relevant files",
}

_TEXTUAL_LANGUAGES = {
    "python",
    "typescript",
    "javascript",
    "json",
    "yaml",
    "toml",
    "markdown",
    "text",
    "shell",
    "powershell",
    "rust",
    "go",
    "java",
    "kotlin",
    "ruby",
    "php",
    "c",
    "cpp",
    "csharp",
    "swift",
    "html",
    "css",
    "scss",
    "sass",
    "sql",
    "lua",
    "dart",
    "elixir",
    "haskell",
    "ocaml",
    "gitignore",
    "dockerfile",
    "makefile",
    "env",
}

_TEXTUAL_EXTENSIONS = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".md",
    ".txt",
    ".rst",
    ".adoc",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".sh",
    ".bash",
    ".zsh",
    ".ps1",
    ".sql",
    ".ini",
    ".cfg",
    ".conf",
    ".env",
}


def normalize_whitespace(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text.strip())


def _is_generic_phrase(text: str) -> bool:
    normalized = normalize_whitespace(text).lower()
    if normalized in _GENERIC_PHRASES:
        return True
    words = _WORD_RE.findall(normalized)
    return len(words) < 4


def _clean_candidate(text: str) -> str:
    return text.strip().strip("`*_ ()")


def _natural_language_enough(text: str) -> bool:
    words = _WORD_RE.findall(text)
    if len(words) < 4:
        return False
    return any(len(word) >= 5 for word in words) and " " in text


def _append_candidate(
    out: list[dict[str, str]],
    seen: set[str],
    text: str,
    source: str,
) -> None:
    if len(out) >= MAX_EXACT_PHRASES:
        return
    cleaned = _clean_candidate(text)
    if len(cleaned) < MIN_EXACT_PHRASE_LEN:
        return
    if _is_generic_phrase(cleaned):
        return
    if not _natural_language_enough(cleaned):
        return
    key = normalize_whitespace(cleaned).lower()
    if key in seen:
        return
    seen.add(key)
    out.append({"text": cleaned, "normalized_text": normalize_whitespace(cleaned), "source": source})


def extract_exact_phrases(task: str) -> list[dict[str, str]]:
    """Extract high-confidence pasted phrases from the raw user task.

    Sources are intentionally conservative: quotes, parentheses, explicit
    error/log prefixes, long natural-language line fragments, and long text
    after a dash/colon. Returns at most MAX_EXACT_PHRASES records.
    """
    if not task:
        return []

    phrases: list[dict[str, str]] = []
    seen: set[str] = set()

    for match in _QUOTED_RE.finditer(task):
        _append_candidate(phrases, seen, match.group(1), "double_quoted")
    for match in _SINGLE_QUOTED_RE.finditer(task):
        _append_candidate(phrases, seen, match.group(1), "single_quoted")
    for match in _PAREN_RE.finditer(task):
        _append_candidate(phrases, seen, match.group(1), "parenthesized")

    for line in task.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        error_match = _ERROR_PREFIX_RE.search(stripped)
        if error_match:
            _append_candidate(phrases, seen, error_match.group(1), "error_or_log")
        dash_match = _DASH_OR_COLON_RE.search(stripped)
        if dash_match:
            _append_candidate(phrases, seen, dash_match.group(1), "dash_or_colon_suffix")
        if len(stripped) >= 80:
            stripped_normalized = normalize_whitespace(stripped).lower()
            if not any(phrase["normalized_text"].lower() in stripped_normalized for phrase in phrases):
                _append_candidate(phrases, seen, stripped, "long_line")
        if len(phrases) >= MAX_EXACT_PHRASES:
            break

    return phrases[:MAX_EXACT_PHRASES]


def _is_text_inventory_entry(entry: dict[str, Any]) -> bool:
    if not isinstance(entry.get("path"), str):
        return False
    bytes_value = entry.get("bytes", entry.get("size_bytes", 0))
    if isinstance(bytes_value, int) and bytes_value > MAX_FILE_BYTES:
        return False
    language = entry.get("language_guess", entry.get("language", ""))
    if isinstance(language, str) and language.lower() in _TEXTUAL_LANGUAGES:
        return True
    extension = entry.get("extension")
    if isinstance(extension, str) and extension.lower() in _TEXTUAL_EXTENSIONS:
        return True
    if isinstance(entry.get("lines"), int):
        return True
    return False


def _line_excerpt(line: str) -> str:
    text = line.strip()
    if len(text) <= MAX_EXCERPT_CHARS:
        return text
    return f"{text[:MAX_EXCERPT_CHARS].rstrip()}…"


def _hit_for_line(
    phrase: dict[str, str],
    rel_path: str,
    line_no: int,
    line: str,
    match_type: str,
) -> dict[str, Any]:
    return {
        "term": phrase["text"],
        "normalized_term": phrase["normalized_text"],
        "provenance": "exact_phrase",
        "source": phrase["source"],
        "match_type": match_type,
        "path": rel_path,
        "line": line_no,
        "excerpt": _line_excerpt(line),
    }


def _find_phrase_in_text(phrase: dict[str, str], rel_path: str, text: str) -> list[dict[str, Any]]:
    term = phrase["text"]
    normalized_term = phrase["normalized_text"]
    hits: list[dict[str, Any]] = []
    seen_lines: set[tuple[int, str]] = set()

    for line_no, line in enumerate(text.splitlines(), start=1):
        if term in line:
            key = (line_no, "exact_text")
            if key not in seen_lines:
                seen_lines.add(key)
                hits.append(_hit_for_line(phrase, rel_path, line_no, line, "exact_text"))
            continue

        normalized_line = normalize_whitespace(line)
        if normalized_term in normalized_line:
            key = (line_no, "normalized_whitespace")
            if key not in seen_lines:
                seen_lines.add(key)
                hits.append(_hit_for_line(phrase, rel_path, line_no, line, "normalized_whitespace"))

    return hits


def run_exact_text_scan(
    repo_root: Path,
    task: str,
    file_inventory: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    exact_phrases = extract_exact_phrases(task)
    hits: list[dict[str, Any]] = []
    warnings: list[str] = []

    if not exact_phrases:
        return {"task": task, "exact_phrases": [], "exact_text_hits": [], "warnings": warnings}

    for entry in file_inventory:
        if not isinstance(entry, dict) or not _is_text_inventory_entry(entry):
            continue
        rel_path = entry.get("path")
        if not isinstance(rel_path, str) or not rel_path:
            continue
        abs_path = repo_root / rel_path
        try:
            text = abs_path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            warnings.append(f"exact text scan skipped {rel_path}: {exc}")
            continue
        for phrase in exact_phrases:
            hits.extend(_find_phrase_in_text(phrase, rel_path, text))

    return {
        "task": task,
        "exact_phrases": exact_phrases,
        "exact_text_hits": hits,
        "warnings": warnings,
    }
