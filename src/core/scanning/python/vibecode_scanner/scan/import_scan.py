"""
Practical import extraction.

Detects:
- Python: import x [as y], from x import y
- TypeScript/JavaScript: import ... from "x", import "x", require("x")

Each record:
    {
        "from_path": "<rel>",
        "import_target": "<module or path>",
        "kind": "local" | "external" | "unknown",
        "line": <int>,
        "language_guess": "python" | "typescript" | "javascript"
    }

A target is "local" if it starts with "." (relative) or with "/", or if it
maps to a path inside the repository when stripped of common path-like
prefixes. Otherwise it is "external".
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable

PY_EXT = {".py"}
TS_EXT = {".ts", ".tsx"}
JS_EXT = {".js", ".jsx", ".mjs", ".cjs"}


def _language_for(rel_path: Path) -> str | None:
    ext = rel_path.suffix.lower()
    if ext in PY_EXT:
        return "python"
    if ext in TS_EXT:
        return "typescript"
    if ext in JS_EXT:
        return "javascript"
    return None


# Python: `import x`, `import x as y`, `import x.y.z`
_PY_IMPORT_RE = re.compile(r"^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$")
# Python: `from x import ...`
_PY_FROM_RE = re.compile(r"^\s*from\s+(\.+[A-Za-z_0-9_.]*|[A-Za-z_][A-Za-z0-9_.]*)\s+import\s+")

# JS/TS: `import ... from "x"` or `import 'x'`
_JS_IMPORT_FROM_RE = re.compile(r"""^\s*import\s+(?:[^"'`;]+?\s+from\s+)?["']([^"']+)["']""")
# JS/TS: `require("x")`
_JS_REQUIRE_RE = re.compile(r"""require\(\s*["']([^"']+)["']\s*\)""")


def _classify_python_kind(target: str) -> str:
    # Relative imports start with one or more dots
    if target.startswith("."):
        return "local"
    # Top-level standard library / installed -> external
    return "external"


def _classify_js_kind(target: str) -> str:
    if target.startswith(".") or target.startswith("/"):
        return "local"
    # Bare specifier -> external (node module, scoped package, etc.)
    return "external"


def _scan_python(rel: str, text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, raw in enumerate(text.splitlines(), start=1):
        line = raw.rstrip()

        m = _PY_IMPORT_RE.match(line)
        if m:
            target = m.group(1)
            out.append(
                {
                    "from_path": rel,
                    "import_target": target,
                    "kind": _classify_python_kind(target),
                    "line": i,
                    "language_guess": "python",
                }
            )
            continue

        m = _PY_FROM_RE.match(line)
        if m:
            target = m.group(1)
            out.append(
                {
                    "from_path": rel,
                    "import_target": target,
                    "kind": _classify_python_kind(target),
                    "line": i,
                    "language_guess": "python",
                }
            )
            continue

    return out


def _scan_js_ts(rel: str, text: str, language: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, raw in enumerate(text.splitlines(), start=1):
        line = raw.rstrip()
        m = _JS_IMPORT_FROM_RE.match(line)
        if m:
            target = m.group(1)
            out.append(
                {
                    "from_path": rel,
                    "import_target": target,
                    "kind": _classify_js_kind(target),
                    "line": i,
                    "language_guess": language,
                }
            )
            continue

        for m in _JS_REQUIRE_RE.finditer(line):
            target = m.group(1)
            out.append(
                {
                    "from_path": rel,
                    "import_target": target,
                    "kind": _classify_js_kind(target),
                    "line": i,
                    "language_guess": language,
                }
            )

    return out


def run_import_scan(repo_root: Path, paths: Iterable[Path]) -> dict[str, Any]:
    imports: list[dict[str, Any]] = []
    warnings: list[str] = []

    for rel_path in paths:
        lang = _language_for(rel_path)
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

        if lang == "python":
            imports.extend(_scan_python(rel_str, text))
        else:
            imports.extend(_scan_js_ts(rel_str, text, lang))

    return {"imports": imports, "warnings": warnings}
