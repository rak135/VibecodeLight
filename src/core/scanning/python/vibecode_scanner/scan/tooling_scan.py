"""
Tooling and config file detection.

Detects formatters, linters, typecheckers, test frameworks, and their config files.
"""
from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any


CONFIG_FILES = {
    # TypeScript / Node
    "tsconfig.json": ("typechecker", "tsc"),
    "tsconfig.base.json": ("typechecker", "tsc"),
    "vitest.config.ts": ("test_framework", "vitest"),
    "vitest.config.js": ("test_framework", "vitest"),
    "vitest.config.mjs": ("test_framework", "vitest"),
    "jest.config.js": ("test_framework", "jest"),
    "jest.config.ts": ("test_framework", "jest"),
    "eslint.config.js": ("linter", "eslint"),
    "eslint.config.mjs": ("linter", "eslint"),
    "eslint.config.cjs": ("linter", "eslint"),
    ".eslintrc": ("linter", "eslint"),
    ".eslintrc.js": ("linter", "eslint"),
    ".eslintrc.cjs": ("linter", "eslint"),
    ".eslintrc.json": ("linter", "eslint"),
    ".eslintrc.yml": ("linter", "eslint"),
    ".eslintrc.yaml": ("linter", "eslint"),
    ".prettierrc": ("formatter", "prettier"),
    ".prettierrc.js": ("formatter", "prettier"),
    ".prettierrc.json": ("formatter", "prettier"),
    ".prettierrc.yml": ("formatter", "prettier"),
    ".prettierrc.yaml": ("formatter", "prettier"),
    "prettier.config.js": ("formatter", "prettier"),
    # Python
    "ruff.toml": ("linter", "ruff"),
    ".ruff.toml": ("linter", "ruff"),
    "mypy.ini": ("typechecker", "mypy"),
    ".mypy.ini": ("typechecker", "mypy"),
    "pytest.ini": ("test_framework", "pytest"),
    # Vite / electron
    "vite.config.ts": ("config", "vite"),
    "vite.config.js": ("config", "vite"),
    "vite.config.mjs": ("config", "vite"),
    "electron.vite.config.ts": ("config", "electron-vite"),
    "electron.vite.config.js": ("config", "electron-vite"),
    # Editor
    ".editorconfig": ("config", "editorconfig"),
}


def _rel(p: Path, root: Path) -> str:
    return str(p.relative_to(root)).replace("\\", "/")


def _scan_pyproject_tooling(path: Path, formatters: set[str], linters: set[str],
                             typecheckers: set[str], test_frameworks: set[str],
                             warnings: list[str]) -> None:
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, OSError) as exc:
        warnings.append(f"failed to parse pyproject.toml for tooling: {exc}")
        return
    tool = data.get("tool", {}) if isinstance(data, dict) else {}
    if not isinstance(tool, dict):
        return
    if "ruff" in tool:
        linters.add("ruff")
        formatters.add("ruff")
    if "pytest" in tool:
        test_frameworks.add("pytest")
    if "mypy" in tool:
        typecheckers.add("mypy")
    if "black" in tool:
        formatters.add("black")
    if "isort" in tool:
        formatters.add("isort")


def run_tooling_scan(repo_root: Path) -> dict[str, Any]:
    formatters: set[str] = set()
    linters: set[str] = set()
    typecheckers: set[str] = set()
    test_frameworks: set[str] = set()
    configs: list[str] = []
    warnings: list[str] = []

    for name, (kind, tool_name) in CONFIG_FILES.items():
        p = repo_root / name
        if not p.is_file():
            continue
        rel = _rel(p, repo_root)
        if rel not in configs:
            configs.append(rel)
        if kind == "formatter":
            formatters.add(tool_name)
        elif kind == "linter":
            linters.add(tool_name)
        elif kind == "typechecker":
            typecheckers.add(tool_name)
        elif kind == "test_framework":
            test_frameworks.add(tool_name)

    # pyproject.toml tool sections (counted as a config when relevant signals present)
    pyproject = repo_root / "pyproject.toml"
    if pyproject.is_file():
        before = (len(formatters), len(linters), len(typecheckers), len(test_frameworks))
        _scan_pyproject_tooling(pyproject, formatters, linters, typecheckers, test_frameworks, warnings)
        after = (len(formatters), len(linters), len(typecheckers), len(test_frameworks))
        if after != before and "pyproject.toml" not in configs:
            configs.append("pyproject.toml")

    # package.json: presence of tooling-related dev deps adds light signal,
    # but we already detect by config file. Skip noisy package.json parsing.

    return {
        "formatters": sorted(formatters),
        "linters": sorted(linters),
        "typecheckers": sorted(typecheckers),
        "test_frameworks": sorted(test_frameworks),
        "configs": configs,
        "warnings": warnings,
    }
