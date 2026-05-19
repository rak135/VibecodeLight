"""
Entrypoint detection.

Sources:
- package.json: bin (declared) and scripts (declared)
- pyproject.toml: project.scripts (declared)
- conventional files: main.py, __main__.py, src/app/cli/* (conventional)
- common app/server startup files (conventional)

Each record:
    {
        "path"? : "<rel>",          # for file-based entrypoints
        "command"? : "<text>",      # for declared script commands
        "name"? : "<script name>",  # for declared scripts
        "type": "cli" | "script" | "module" | "app" | "unknown",
        "source": "<provenance>",
        "confidence": "declared" | "conventional" | "guessed"
    }

No numeric scores are produced.
"""
from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import Any, Iterable


CONVENTIONAL_ROOT_FILES: dict[str, str] = {
    "main.py": "cli",
    "manage.py": "cli",
    "app.py": "app",
    "server.py": "app",
    "wsgi.py": "app",
    "asgi.py": "app",
}

# Common server/app startup paths to flag as conventional entrypoints
CONVENTIONAL_APP_PATTERNS = (
    "src/main.py",
    "src/app.py",
    "src/server.py",
    "src/index.ts",
    "src/index.js",
    "src/app/main.ts",
    "src/app/main.js",
    "src/app/index.ts",
    "src/app/index.js",
)


def _rel(p: Path, root: Path) -> str:
    return str(p.relative_to(root)).replace("\\", "/")


def _read_package_json(repo_root: Path, warnings: list[str]) -> dict[str, Any] | None:
    p = repo_root / "package.json"
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        warnings.append(f"failed to parse package.json for entrypoints: {exc}")
        return None
    return data if isinstance(data, dict) else None


def _from_package_json(repo_root: Path, warnings: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    data = _read_package_json(repo_root, warnings)
    if data is None:
        return out

    # bin: string OR dict
    bin_field = data.get("bin")
    if isinstance(bin_field, str):
        out.append(
            {
                "path": bin_field,
                "type": "cli",
                "source": "package.json:bin",
                "confidence": "declared",
            }
        )
    elif isinstance(bin_field, dict):
        for name, target in bin_field.items():
            if not isinstance(name, str):
                continue
            entry: dict[str, Any] = {
                "name": name,
                "type": "cli",
                "source": f"package.json:bin.{name}",
                "confidence": "declared",
            }
            if isinstance(target, str):
                entry["path"] = target
            out.append(entry)

    scripts = data.get("scripts")
    if isinstance(scripts, dict):
        for name, command in scripts.items():
            if not isinstance(name, str):
                continue
            entry = {
                "name": name,
                "type": "script",
                "source": f"package.json:scripts.{name}",
                "confidence": "declared",
            }
            if isinstance(command, str):
                entry["command"] = command
            out.append(entry)

    return out


def _from_pyproject(repo_root: Path, warnings: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    p = repo_root / "pyproject.toml"
    if not p.is_file():
        return out
    try:
        data = tomllib.loads(p.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, OSError) as exc:
        warnings.append(f"failed to parse pyproject.toml for entrypoints: {exc}")
        return out

    project = data.get("project") if isinstance(data, dict) else None
    if isinstance(project, dict):
        scripts = project.get("scripts")
        if isinstance(scripts, dict):
            for name, target in scripts.items():
                if not isinstance(name, str):
                    continue
                entry: dict[str, Any] = {
                    "name": name,
                    "type": "cli",
                    "source": f"pyproject.toml:project.scripts.{name}",
                    "confidence": "declared",
                }
                if isinstance(target, str):
                    entry["command"] = target
                out.append(entry)
        # GUI scripts
        gui = project.get("gui-scripts")
        if isinstance(gui, dict):
            for name, target in gui.items():
                if not isinstance(name, str):
                    continue
                entry = {
                    "name": name,
                    "type": "app",
                    "source": f"pyproject.toml:project.gui-scripts.{name}",
                    "confidence": "declared",
                }
                if isinstance(target, str):
                    entry["command"] = target
                out.append(entry)

    # tool.poetry.scripts
    tool = data.get("tool") if isinstance(data, dict) else None
    if isinstance(tool, dict):
        poetry = tool.get("poetry")
        if isinstance(poetry, dict):
            poetry_scripts = poetry.get("scripts")
            if isinstance(poetry_scripts, dict):
                for name, target in poetry_scripts.items():
                    if not isinstance(name, str):
                        continue
                    entry = {
                        "name": name,
                        "type": "cli",
                        "source": f"pyproject.toml:tool.poetry.scripts.{name}",
                        "confidence": "declared",
                    }
                    if isinstance(target, str):
                        entry["command"] = target
                    out.append(entry)

    return out


def _from_conventional_files(repo_root: Path, paths: Iterable[Path]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    paths_set = {str(p).replace("\\", "/") for p in paths}

    for name, ep_type in CONVENTIONAL_ROOT_FILES.items():
        if name in paths_set:
            out.append(
                {
                    "path": name,
                    "type": ep_type,
                    "source": "conventional-filename",
                    "confidence": "conventional",
                }
            )

    # __main__.py anywhere
    for p in paths_set:
        if p.endswith("__main__.py"):
            out.append(
                {
                    "path": p,
                    "type": "module",
                    "source": "conventional-dunder-main",
                    "confidence": "conventional",
                }
            )

    # src/app/cli/* (any file)
    for p in paths_set:
        if p.startswith("src/app/cli/") and p.count("/") >= 3:
            out.append(
                {
                    "path": p,
                    "type": "cli",
                    "source": "conventional-cli-dir",
                    "confidence": "conventional",
                }
            )

    # Common app/server startup files
    for pattern in CONVENTIONAL_APP_PATTERNS:
        if pattern in paths_set and not any(
            e.get("path") == pattern for e in out
        ):
            out.append(
                {
                    "path": pattern,
                    "type": "app",
                    "source": "conventional-app-file",
                    "confidence": "conventional",
                }
            )

    return out


def run_entrypoint_scan(repo_root: Path, paths: Iterable[Path]) -> dict[str, Any]:
    warnings: list[str] = []
    entries: list[dict[str, Any]] = []

    entries.extend(_from_package_json(repo_root, warnings))
    entries.extend(_from_pyproject(repo_root, warnings))
    entries.extend(_from_conventional_files(repo_root, list(paths)))

    # Stable order: declared first (by source), then conventional (by path/name)
    def sort_key(e: dict[str, Any]) -> tuple[int, str, str]:
        order = 0 if e["confidence"] == "declared" else 1 if e["confidence"] == "conventional" else 2
        return (order, e.get("source", ""), e.get("path") or e.get("name") or "")

    entries.sort(key=sort_key)

    return {"entrypoints": entries, "warnings": warnings}
