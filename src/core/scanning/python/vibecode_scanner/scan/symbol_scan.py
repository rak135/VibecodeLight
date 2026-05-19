"""
Regex-based symbol extraction.

This is intentionally not a compiler-grade parser. It produces an orientation
map of declared classes, functions, interfaces, types, and top-level constants.

Each record:
    {
        "path": "<rel>",
        "name": "<symbol>",
        "kind": "class" | "function" | "async-function"
                 | "interface" | "type" | "const",
        "signature": "<one-line excerpt>",
        "line": <int>,
        "language_guess": "python" | "typescript" | "javascript",
        "extraction_method": "regex",
        "decorators": [<str>...]   # optional
    }
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable

PY_LANG = "python"
TS_LANG = "typescript"
JS_LANG = "javascript"

PY_EXT = {".py"}
TS_EXT = {".ts", ".tsx"}
JS_EXT = {".js", ".jsx", ".mjs", ".cjs"}


def _classify_language(rel_path: Path) -> str | None:
    ext = rel_path.suffix.lower()
    if ext in PY_EXT:
        return PY_LANG
    if ext in TS_EXT:
        return TS_LANG
    if ext in JS_EXT:
        return JS_LANG
    return None


# ---------------------------------------------------------------------------
# Python regexes
# ---------------------------------------------------------------------------

_PY_CLASS_RE = re.compile(r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[\(:]")
_PY_DEF_RE = re.compile(r"^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")
_PY_ASYNC_DEF_RE = re.compile(r"^\s*async\s+def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")
_PY_DECORATOR_RE = re.compile(r"^\s*@(\S+?)(?:\s*\(|\s*$)")


def _scan_python(rel: str, text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    pending_decorators: list[str] = []
    for i, raw in enumerate(text.splitlines(), start=1):
        line = raw.rstrip()
        m_dec = _PY_DECORATOR_RE.match(line)
        if m_dec:
            pending_decorators.append(m_dec.group(1))
            continue

        m_async = _PY_ASYNC_DEF_RE.match(line)
        if m_async:
            out.append(
                {
                    "path": rel,
                    "name": m_async.group(1),
                    "kind": "async-function",
                    "signature": line.strip(),
                    "line": i,
                    "language_guess": PY_LANG,
                    "extraction_method": "regex",
                    "decorators": list(pending_decorators),
                }
            )
            pending_decorators = []
            continue

        m_def = _PY_DEF_RE.match(line)
        if m_def:
            out.append(
                {
                    "path": rel,
                    "name": m_def.group(1),
                    "kind": "function",
                    "signature": line.strip(),
                    "line": i,
                    "language_guess": PY_LANG,
                    "extraction_method": "regex",
                    "decorators": list(pending_decorators),
                }
            )
            pending_decorators = []
            continue

        m_cls = _PY_CLASS_RE.match(line)
        if m_cls:
            out.append(
                {
                    "path": rel,
                    "name": m_cls.group(1),
                    "kind": "class",
                    "signature": line.strip(),
                    "line": i,
                    "language_guess": PY_LANG,
                    "extraction_method": "regex",
                    "decorators": list(pending_decorators),
                }
            )
            pending_decorators = []
            continue

        # Any non-blank, non-comment, non-decorator line clears pending decorators
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            pending_decorators = []
    return out


# ---------------------------------------------------------------------------
# TS / JS regexes
# ---------------------------------------------------------------------------

_TS_EXPORT_FUNCTION_RE = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\("
)
_TS_EXPORT_CLASS_RE = re.compile(r"^\s*export\s+(?:default\s+|abstract\s+)*class\s+([A-Za-z_$][A-Za-z0-9_$]*)")
_TS_EXPORT_INTERFACE_RE = re.compile(r"^\s*export\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)")
_TS_EXPORT_TYPE_RE = re.compile(r"^\s*export\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=")
_TS_FUNCTION_RE = re.compile(r"^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(")
_TS_CLASS_RE = re.compile(r"^\s*(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)")
_TS_EXPORT_CONST_RE = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]"
)
_TS_CONST_RE = re.compile(r"^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]")


def _scan_ts_or_js(rel: str, text: str, language: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, raw in enumerate(text.splitlines(), start=1):
        line = raw.rstrip()

        m = _TS_EXPORT_FUNCTION_RE.match(line)
        if m:
            out.append(_record(rel, m.group(1), "function", line, i, language))
            continue

        m = _TS_EXPORT_CLASS_RE.match(line)
        if m:
            out.append(_record(rel, m.group(1), "class", line, i, language))
            continue

        m = _TS_EXPORT_INTERFACE_RE.match(line)
        if m:
            out.append(_record(rel, m.group(1), "interface", line, i, language))
            continue

        m = _TS_EXPORT_TYPE_RE.match(line)
        if m:
            out.append(_record(rel, m.group(1), "type", line, i, language))
            continue

        m = _TS_EXPORT_CONST_RE.match(line)
        if m:
            out.append(_record(rel, m.group(1), "const", line, i, language))
            continue

        m = _TS_FUNCTION_RE.match(line)
        if m:
            out.append(_record(rel, m.group(1), "function", line, i, language))
            continue

        m = _TS_CLASS_RE.match(line)
        if m:
            out.append(_record(rel, m.group(1), "class", line, i, language))
            continue

        m = _TS_CONST_RE.match(line)
        if m:
            out.append(_record(rel, m.group(1), "const", line, i, language))
            continue

    return out


def _record(rel: str, name: str, kind: str, line: str, lineno: int, language: str) -> dict[str, Any]:
    return {
        "path": rel,
        "name": name,
        "kind": kind,
        "signature": line.strip(),
        "line": lineno,
        "language_guess": language,
        "extraction_method": "regex",
    }


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def run_symbol_scan(repo_root: Path, paths: Iterable[Path]) -> dict[str, Any]:
    symbols: list[dict[str, Any]] = []
    warnings: list[str] = []

    for rel_path in paths:
        lang = _classify_language(rel_path)
        if lang is None:
            continue
        rel_str = str(rel_path).replace("\\", "/")
        abs_path = repo_root / rel_path
        try:
            text = abs_path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            warnings.append(f"failed to decode {rel_str} as utf-8: {exc}")
            continue
        except OSError as exc:
            warnings.append(f"failed to read {rel_str}: {exc}")
            continue

        if lang == PY_LANG:
            symbols.extend(_scan_python(rel_str, text))
        else:
            symbols.extend(_scan_ts_or_js(rel_str, text, lang))

    return {"symbols": symbols, "warnings": warnings}
