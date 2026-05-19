"""
Test inventory scan.

Detects test files based on patterns:
- tests/, test_*.py, *_test.py
- *.test.ts, *.spec.ts (also .tsx/.js/.jsx variants)
- __tests__/

Also surfaces test framework config files:
- pyproject.toml [tool.pytest], pytest.ini, conftest.py
- vitest.config.{ts,js,mjs}, jest.config.{ts,js,json}

Each entry:
    {
        "path": "<rel>",
        "language_guess": "python" | "typescript" | "javascript",
        "test_framework_guess": "pytest" | "vitest" | "jest" | "unknown",
        "test_names": [<str>...],
        "likely_targets": [<rel>...]
    }
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable


def _to_rel_str(p: Path) -> str:
    return str(p).replace("\\", "/")


def _looks_like_python_test(rel: str) -> bool:
    name = Path(rel).name
    if name.startswith("test_") and name.endswith(".py"):
        return True
    if name.endswith("_test.py"):
        return True
    if "/tests/" in f"/{rel}" and name.endswith(".py"):
        return True
    if rel.startswith("tests/") and name.endswith(".py"):
        return True
    return False


_JS_TEST_SUFFIXES = (
    ".test.ts",
    ".test.tsx",
    ".test.js",
    ".test.jsx",
    ".spec.ts",
    ".spec.tsx",
    ".spec.js",
    ".spec.jsx",
)


def _looks_like_js_test(rel: str) -> bool:
    name = Path(rel).name
    if any(name.endswith(suffix) for suffix in _JS_TEST_SUFFIXES):
        return True
    if "/__tests__/" in f"/{rel}":
        return True
    return False


def _language_for(rel: str) -> str:
    ext = Path(rel).suffix.lower()
    if ext == ".py":
        return "python"
    if ext in (".ts", ".tsx"):
        return "typescript"
    if ext in (".js", ".jsx", ".mjs", ".cjs"):
        return "javascript"
    return "unknown"


_PY_TEST_NAME_RE = re.compile(r"^\s*(?:async\s+)?def\s+(test_[A-Za-z_0-9]+)\s*\(")
_JS_TEST_NAME_RE = re.compile(
    r"""\b(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]"""
)


def _extract_test_names(rel: str, text: str) -> list[str]:
    lang = _language_for(rel)
    names: list[str] = []
    if lang == "python":
        for line in text.splitlines():
            m = _PY_TEST_NAME_RE.match(line)
            if m:
                names.append(m.group(1))
    elif lang in ("typescript", "javascript"):
        for m in _JS_TEST_NAME_RE.finditer(text):
            names.append(m.group(1))
    return names


def _guess_framework(rel: str, text: str) -> str:
    lang = _language_for(rel)
    if lang == "python":
        return "pytest"
    if lang in ("typescript", "javascript"):
        if "vitest" in text:
            return "vitest"
        if "@jest" in text or "jest" in text:
            return "jest"
        return "unknown"
    return "unknown"


def _python_likely_targets(rel: str, all_paths: set[str]) -> list[str]:
    """Map tests/test_thing.py -> thing.py (search anywhere in the repo)."""
    name = Path(rel).name
    base = None
    if name.startswith("test_") and name.endswith(".py"):
        base = name[len("test_"):]
    elif name.endswith("_test.py"):
        base = name[: -len("_test.py")] + ".py"
    if not base:
        return []
    matches: list[str] = []
    for p in sorted(all_paths):
        if p == rel:
            continue
        if Path(p).name == base:
            matches.append(p)
    return matches


def _js_likely_targets(rel: str, all_paths: set[str]) -> list[str]:
    """Map foo.test.ts -> foo.ts (or foo.tsx/.js/.jsx)."""
    name = Path(rel).name
    base = None
    for suffix in _JS_TEST_SUFFIXES:
        if name.endswith(suffix):
            base = name[: -len(suffix)]
            break
    if not base:
        return []
    candidates = [f"{base}.ts", f"{base}.tsx", f"{base}.js", f"{base}.jsx"]
    matches: list[str] = []
    for p in sorted(all_paths):
        if p == rel:
            continue
        if Path(p).name in candidates:
            matches.append(p)
    return matches


def _likely_targets(rel: str, all_paths: set[str]) -> list[str]:
    if rel.endswith(".py"):
        return _python_likely_targets(rel, all_paths)
    return _js_likely_targets(rel, all_paths)


CONFIG_FILES = (
    "pytest.ini",
    "pyproject.toml",
    "conftest.py",
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mjs",
    "jest.config.ts",
    "jest.config.js",
    "jest.config.json",
    "jest.config.mjs",
)


def _detect_test_configs(repo_root: Path, paths: Iterable[Path]) -> list[dict[str, Any]]:
    paths_set = {_to_rel_str(p) for p in paths}
    configs: list[dict[str, Any]] = []

    for name in CONFIG_FILES:
        if name not in paths_set:
            continue
        # pyproject.toml only counts as a test config when it actually mentions pytest
        if name == "pyproject.toml":
            p = repo_root / name
            try:
                text = p.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if "[tool.pytest" not in text:
                continue
            configs.append({"path": name, "framework": "pytest"})
        elif name == "pytest.ini":
            configs.append({"path": name, "framework": "pytest"})
        elif name == "conftest.py":
            configs.append({"path": name, "framework": "pytest"})
        elif name.startswith("vitest.config"):
            configs.append({"path": name, "framework": "vitest"})
        elif name.startswith("jest.config"):
            configs.append({"path": name, "framework": "jest"})
    return configs


def run_test_scan(repo_root: Path, paths: Iterable[Path]) -> dict[str, Any]:
    paths_list = [Path(p) for p in paths]
    rel_paths = [_to_rel_str(p) for p in paths_list]
    paths_set = set(rel_paths)
    warnings: list[str] = []
    entries: list[dict[str, Any]] = []

    for rel in rel_paths:
        is_py = _looks_like_python_test(rel)
        is_js = _looks_like_js_test(rel)
        if not (is_py or is_js):
            continue

        abs_path = repo_root / rel
        text = ""
        try:
            text = abs_path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            warnings.append(f"failed to decode {rel} as utf-8: {exc}")
        except OSError as exc:
            warnings.append(f"failed to read {rel}: {exc}")

        entries.append(
            {
                "path": rel,
                "language_guess": _language_for(rel),
                "test_framework_guess": _guess_framework(rel, text),
                "test_names": _extract_test_names(rel, text),
                "likely_targets": _likely_targets(rel, paths_set),
            }
        )

    entries.sort(key=lambda e: e["path"])
    test_configs = _detect_test_configs(repo_root, paths_list)

    return {"tests": entries, "test_configs": test_configs, "warnings": warnings}
