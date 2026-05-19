"""
Mechanical keyword-hit extraction from the user task.

This is evidence, not relevance scoring. No numeric scores are produced.

For each keyword extracted from the task we emit one hit per match site:
    {
        "keyword": "<token>",
        "match_type": "path" | "filename" | "symbol" | "heading",
        "path": "<rel>",
        "line"?: <int>,           # for symbols/headings
        "excerpt"?: "<text>"      # for symbols/headings
    }
"""
from __future__ import annotations

import re
from typing import Any, Iterable

# Common English/programming stopwords to drop from the task before matching.
# Kept short and conservative.
_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "of", "to", "for", "with",
    "without", "in", "on", "at", "by", "from", "into", "onto", "as",
    "is", "are", "was", "were", "be", "been", "being",
    "this", "that", "these", "those", "it", "its", "they", "them",
    "we", "you", "i", "he", "she",
    "do", "does", "did", "done", "doing",
    "have", "has", "had", "having",
    "can", "could", "should", "would", "will", "shall", "may", "might",
    "not", "no", "yes", "if", "then", "else",
    "make", "made", "making", "use", "uses", "used", "using",
    "add", "added", "adding", "fix", "fixed", "fixing",
    "new", "old", "any", "all", "some", "more", "less",
    "please", "ok",
}

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]+")
_MIN_LEN = 3


def _tokenize_task(task: str) -> list[str]:
    if not task:
        return []
    tokens = _TOKEN_RE.findall(task.lower())
    seen: set[str] = set()
    out: list[str] = []
    for t in tokens:
        if len(t) < _MIN_LEN:
            continue
        if t in _STOPWORDS:
            continue
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def _path_match(keyword: str, rel_path: str) -> str | None:
    """Return 'filename' if keyword appears in basename, 'path' if elsewhere, else None."""
    lower_path = rel_path.lower()
    if keyword not in lower_path:
        return None
    basename = rel_path.split("/")[-1].lower()
    if keyword in basename:
        return "filename"
    return "path"


def run_keyword_scan(
    task: str,
    file_inventory: Iterable[dict[str, Any]],
    symbols: Iterable[dict[str, Any]],
    doc_payloads: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """
    file_inventory: list of records with at least "path".
    symbols: list of symbol records with "name", "path", "line", "signature".
    doc_payloads: list of doc payload dicts (each with key like "docs"/"architecture_docs"/"repo_instructions"
        whose value is a list of entries with "path" and "headings").
    """
    keywords = _tokenize_task(task)
    hits: list[dict[str, Any]] = []
    warnings: list[str] = []

    inv_paths = [e["path"] for e in file_inventory if isinstance(e, dict) and "path" in e]
    sym_list = [s for s in symbols if isinstance(s, dict)]

    # Flatten heading entries across the supplied doc payloads
    heading_index: list[tuple[str, str, int]] = []  # (heading_text_lower, path, level/0)
    for payload in doc_payloads:
        if not isinstance(payload, dict):
            continue
        for value in payload.values():
            if not isinstance(value, list):
                continue
            for entry in value:
                if not isinstance(entry, dict):
                    continue
                path = entry.get("path")
                if not isinstance(path, str):
                    continue
                headings = entry.get("headings") or []
                if not isinstance(headings, list):
                    continue
                for h in headings:
                    if not isinstance(h, dict):
                        continue
                    text = h.get("text", "")
                    if isinstance(text, str):
                        heading_index.append((text.lower(), path, int(h.get("level") or 0)))

    for kw in keywords:
        # Path / filename
        for p in inv_paths:
            mt = _path_match(kw, p)
            if mt is None:
                continue
            hits.append({"keyword": kw, "match_type": mt, "path": p})

        # Symbols (name match, case-insensitive substring)
        for s in sym_list:
            name = s.get("name", "")
            if not isinstance(name, str):
                continue
            if kw in name.lower():
                hit: dict[str, Any] = {
                    "keyword": kw,
                    "match_type": "symbol",
                    "path": s.get("path", ""),
                }
                if "line" in s:
                    hit["line"] = s["line"]
                sig = s.get("signature")
                if isinstance(sig, str) and sig:
                    hit["excerpt"] = sig
                hits.append(hit)

        # Headings
        for text_lower, path, _level in heading_index:
            if kw in text_lower:
                hits.append(
                    {
                        "keyword": kw,
                        "match_type": "heading",
                        "path": path,
                        "excerpt": text_lower,
                    }
                )

    return {
        "task": task,
        "keywords": keywords,
        "keyword_hits": hits,
        "warnings": warnings,
    }
