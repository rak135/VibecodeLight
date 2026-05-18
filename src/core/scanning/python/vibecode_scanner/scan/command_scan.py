"""
Command extraction with source provenance.

Categories: install, run, test, lint, format, typecheck, build.
"""
from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path
from typing import Any

CATEGORIES = ["install", "run", "test", "lint", "format", "typecheck", "build"]


def _rel(p: Path, root: Path) -> str:
    return str(p.relative_to(root)).replace("\\", "/")


def _classify_script_name(name: str) -> str | None:
    """Map a package.json script name to a category, if known."""
    n = name.lower()
    if n in ("install", "preinstall", "postinstall"):
        return "install"
    if n in ("test", "tests", "unit", "test:unit", "test:run", "vitest"):
        return "test"
    if n.startswith("test"):
        return "test"
    if n in ("lint", "lint:check", "eslint"):
        return "lint"
    if n.startswith("lint"):
        return "lint"
    if n in ("format", "fmt", "prettier"):
        return "format"
    if n.startswith("format") or n.startswith("fmt"):
        return "format"
    if n in ("typecheck", "type-check", "tsc"):
        return "typecheck"
    if n.startswith("typecheck") or n.startswith("type-check"):
        return "typecheck"
    if n in ("build",):
        return "build"
    if n.startswith("build"):
        return "build"
    if n in ("start", "serve", "dev", "preview", "run"):
        return "run"
    return None


_PM_PREFIXES = ("pnpm ", "npm run ", "npm ", "yarn ", "bun ", "uv run ", "uv ", "poetry run ", "poetry ")


def _classify_by_command(cmd: str) -> str | None:
    """Fallback: classify a raw command string by its first token / contents."""
    c = cmd.strip().lower()
    if not c:
        return None

    # Strip package-manager prefix and reclassify by remainder (e.g. "pnpm test" -> "test")
    for prefix in _PM_PREFIXES:
        if c.startswith(prefix):
            remainder = c[len(prefix):].strip()
            if not remainder:
                return None
            # Direct subcommand maps for common pm verbs
            first = remainder.split()[0]
            if first in ("install", "i", "add", "ci"):
                return "install"
            if first in ("test", "tests"):
                return "test"
            if first == "lint":
                return "lint"
            if first in ("format", "fmt"):
                return "format"
            if first in ("typecheck", "type-check"):
                return "typecheck"
            if first == "build":
                return "build"
            if first in ("run", "exec"):
                # e.g. "uv run pytest" -> classify by next token
                rest = " ".join(remainder.split()[1:])
                return _classify_by_command(rest)
            # Otherwise fall through to the recursive classification on remainder
            return _classify_by_command(remainder)

    if "tsc --noemit" in c or c.endswith("tsc --noemit"):
        return "typecheck"
    if c.startswith("tsc") and "--noemit" in c:
        return "typecheck"
    if c.startswith("eslint") or " eslint " in f" {c} ":
        return "lint"
    if c.startswith("ruff check") or " ruff check" in c:
        return "lint"
    if c.startswith("ruff format") or " ruff format" in c:
        return "format"
    if c.startswith("prettier"):
        return "format"
    if c.startswith("mypy"):
        return "typecheck"
    if c.startswith("pytest") or c.startswith("vitest") or c.startswith("jest"):
        return "test"
    if c.startswith("tsc"):
        return "build"
    if c.startswith("vite build") or c.startswith("webpack"):
        return "build"
    if c.startswith("vite") or c.startswith("next dev") or c.startswith("astro dev"):
        return "run"
    return None


def _add(commands: dict[str, list[dict[str, str]]], category: str, command: str, source: str) -> None:
    if not command:
        return
    bucket = commands.setdefault(category, [])
    # Deduplicate by (command, source)
    for existing in bucket:
        if existing["command"] == command and existing["source"] == source:
            return
    bucket.append({"command": command, "source": source})


def _scan_package_json(path: Path, repo_root: Path, commands: dict[str, list[dict[str, str]]], warnings: list[str]) -> None:
    rel = _rel(path, repo_root)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        warnings.append(f"failed to parse {rel} for commands: {exc}")
        return
    if not isinstance(data, dict):
        return
    scripts = data.get("scripts") or {}
    if not isinstance(scripts, dict):
        return

    # Decide pm prefix for the run command. Default to pnpm if pnpm-lock.yaml exists,
    # otherwise npm. We do not invoke shell here; this is just provenance text.
    pm_prefix = "pnpm"
    if (repo_root / "yarn.lock").exists():
        pm_prefix = "yarn"
    elif (repo_root / "package-lock.json").exists() and not (repo_root / "pnpm-lock.yaml").exists():
        pm_prefix = "npm run"

    for name, raw in scripts.items():
        if not isinstance(name, str) or not isinstance(raw, str):
            continue
        category = _classify_script_name(name) or _classify_by_command(raw)
        if category is None:
            continue
        # Recorded command: invoke via the package manager (more reproducible)
        if pm_prefix == "npm run":
            cmd = f"npm run {name}"
        elif pm_prefix == "yarn":
            cmd = f"yarn {name}"
        else:
            cmd = f"pnpm {name}"
        source = f"{rel}:scripts.{name}"
        _add(commands, category, cmd, source)

    # Implicit install command from package manager
    if pm_prefix == "npm run":
        _add(commands, "install", "npm install", f"{rel}:packageManager")
    elif pm_prefix == "yarn":
        _add(commands, "install", "yarn install", f"{rel}:packageManager")
    else:
        _add(commands, "install", "pnpm install", f"{rel}:packageManager")


def _scan_pyproject(path: Path, repo_root: Path, commands: dict[str, list[dict[str, str]]], warnings: list[str]) -> None:
    rel = _rel(path, repo_root)
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, OSError) as exc:
        warnings.append(f"failed to parse {rel} for commands: {exc}")
        return

    tool = data.get("tool", {}) if isinstance(data, dict) else {}
    if isinstance(tool, dict):
        if "pytest" in tool:
            _add(commands, "test", "pytest", f"{rel}:tool.pytest")
        if "ruff" in tool:
            _add(commands, "lint", "ruff check .", f"{rel}:tool.ruff")
            _add(commands, "format", "ruff format .", f"{rel}:tool.ruff")
        if "mypy" in tool:
            _add(commands, "typecheck", "mypy .", f"{rel}:tool.mypy")
        if "black" in tool:
            _add(commands, "format", "black .", f"{rel}:tool.black")

    # uv-style dependency-groups: if [dependency-groups].dev includes pytest/ruff, treat as available.
    groups = data.get("dependency-groups", {}) if isinstance(data, dict) else {}
    if isinstance(groups, dict):
        dev = groups.get("dev", [])
        if isinstance(dev, list):
            joined = " ".join(str(d).lower() for d in dev)
            if "pytest" in joined and not any("pytest" in e["command"] for e in commands.get("test", [])):
                _add(commands, "test", "pytest", f"{rel}:dependency-groups.dev")
            if "ruff" in joined and not any("ruff" in e["command"] for e in commands.get("lint", [])):
                _add(commands, "lint", "ruff check .", f"{rel}:dependency-groups.dev")

    # Project scripts (console_scripts)
    project = data.get("project", {}) if isinstance(data, dict) else {}
    if isinstance(project, dict):
        scripts = project.get("scripts", {})
        if isinstance(scripts, dict):
            for name in scripts:
                _add(commands, "run", str(name), f"{rel}:project.scripts.{name}")


def _scan_makefile(path: Path, repo_root: Path, commands: dict[str, list[dict[str, str]]]) -> None:
    rel = _rel(path, repo_root)
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    target_re = re.compile(r"^([a-zA-Z0-9_.\-]+)\s*:")
    for line in text.splitlines():
        if line.startswith("\t") or line.startswith(" "):
            continue
        m = target_re.match(line)
        if not m:
            continue
        target = m.group(1)
        if target.lower() in ("phony", ".phony", "default"):
            continue
        category = _classify_script_name(target) or _classify_by_command(target)
        if category is None:
            continue
        _add(commands, category, f"make {target}", f"{rel}:{target}")


def _scan_justfile(path: Path, repo_root: Path, commands: dict[str, list[dict[str, str]]]) -> None:
    rel = _rel(path, repo_root)
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    # `name:` or `name arg arg:`
    recipe_re = re.compile(r"^([a-zA-Z0-9_\-]+)(?:\s[^:]*)?:\s*$")
    for line in text.splitlines():
        m = recipe_re.match(line)
        if not m:
            continue
        name = m.group(1)
        category = _classify_script_name(name) or _classify_by_command(name)
        if category is None:
            continue
        _add(commands, category, f"just {name}", f"{rel}:{name}")


def _scan_tox(path: Path, repo_root: Path, commands: dict[str, list[dict[str, str]]]) -> None:
    rel = _rel(path, repo_root)
    _add(commands, "test", "tox", f"{rel}")


def _scan_noxfile(path: Path, repo_root: Path, commands: dict[str, list[dict[str, str]]]) -> None:
    rel = _rel(path, repo_root)
    _add(commands, "test", "nox", f"{rel}")


_WORKFLOW_RUN_RE = re.compile(r"^\s*-\s*run\s*:\s*(.+?)\s*$", re.MULTILINE)


def _scan_workflow(path: Path, repo_root: Path, commands: dict[str, list[dict[str, str]]]) -> None:
    rel = _rel(path, repo_root)
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    for match in _WORKFLOW_RUN_RE.finditer(text):
        raw_cmd = match.group(1).strip()
        # Strip surrounding quotes
        if (raw_cmd.startswith('"') and raw_cmd.endswith('"')) or (
            raw_cmd.startswith("'") and raw_cmd.endswith("'")
        ):
            raw_cmd = raw_cmd[1:-1]
        # Only take the first line if multi-line continuation
        first_line = raw_cmd.splitlines()[0].strip() if raw_cmd else ""
        category = _classify_by_command(first_line)
        if category is None:
            continue
        _add(commands, category, first_line, rel)


def run_command_scan(repo_root: Path) -> dict[str, Any]:
    commands: dict[str, list[dict[str, str]]] = {cat: [] for cat in CATEGORIES}
    warnings: list[str] = []

    pkg = repo_root / "package.json"
    if pkg.is_file():
        _scan_package_json(pkg, repo_root, commands, warnings)

    py = repo_root / "pyproject.toml"
    if py.is_file():
        _scan_pyproject(py, repo_root, commands, warnings)

    mk = repo_root / "Makefile"
    if mk.is_file():
        _scan_makefile(mk, repo_root, commands)

    jf = repo_root / "justfile"
    if jf.is_file():
        _scan_justfile(jf, repo_root, commands)

    tox = repo_root / "tox.ini"
    if tox.is_file():
        _scan_tox(tox, repo_root, commands)

    nox = repo_root / "noxfile.py"
    if nox.is_file():
        _scan_noxfile(nox, repo_root, commands)

    wf_dir = repo_root / ".github" / "workflows"
    if wf_dir.is_dir():
        for wf in sorted(wf_dir.iterdir()):
            if wf.is_file() and wf.suffix.lower() in (".yml", ".yaml"):
                _scan_workflow(wf, repo_root, commands)

    return {"commands": commands, "warnings": warnings}
