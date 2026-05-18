"""
Manifest discovery and dependency summary.

Detects common project manifests and lockfiles, summarizes declared dependencies
and important sections. Records parse warnings rather than crashing.
"""
from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import Any

MANIFEST_KIND: dict[str, str] = {
    "package.json": "node-project",
    "pnpm-lock.yaml": "lockfile",
    "yarn.lock": "lockfile",
    "package-lock.json": "lockfile",
    "pyproject.toml": "python-project",
    "requirements.txt": "python-requirements",
    "poetry.lock": "lockfile",
    "uv.lock": "lockfile",
    "Cargo.toml": "rust-project",
    "Cargo.lock": "lockfile",
    "go.mod": "go-module",
    "go.sum": "lockfile",
    "pom.xml": "maven-project",
    "build.gradle": "gradle-project",
    "Dockerfile": "dockerfile",
    "docker-compose.yml": "docker-compose",
    "Makefile": "makefile",
    "justfile": "justfile",
    "tox.ini": "tox-config",
    "noxfile.py": "nox-config",
}

# Names checked at repo root (case-insensitive on match)
ROOT_MANIFEST_NAMES = list(MANIFEST_KIND.keys())


def _rel(p: Path, root: Path) -> str:
    return str(p.relative_to(root)).replace("\\", "/")


def _find_root_manifests(repo_root: Path) -> list[Path]:
    found: list[Path] = []
    for name in ROOT_MANIFEST_NAMES:
        candidate = repo_root / name
        if candidate.is_file():
            found.append(candidate)
    return found


def _find_workflows(repo_root: Path) -> list[Path]:
    wf_dir = repo_root / ".github" / "workflows"
    if not wf_dir.is_dir():
        return []
    return sorted(
        [p for p in wf_dir.iterdir() if p.is_file() and p.suffix.lower() in (".yml", ".yaml")]
    )


def _summarize_package_json(path: Path, repo_root: Path, warnings: list[str]) -> dict[str, Any]:
    rel = _rel(path, repo_root)
    entry: dict[str, Any] = {
        "path": rel,
        "kind": MANIFEST_KIND[path.name],
        "languages": ["javascript", "typescript"],
        "package_managers": [],
        "dependencies": [],
        "dev_dependencies": [],
        "important_sections": [],
    }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        warnings.append(f"failed to parse {rel}: {exc}")
        return entry

    if not isinstance(data, dict):
        warnings.append(f"{rel} is not a JSON object")
        return entry

    deps = data.get("dependencies") or {}
    dev = data.get("devDependencies") or {}
    if isinstance(deps, dict):
        entry["dependencies"] = sorted(deps.keys())
    if isinstance(dev, dict):
        entry["dev_dependencies"] = sorted(dev.keys())

    sections = []
    for key in ("scripts", "dependencies", "devDependencies", "bin", "engines", "workspaces", "type"):
        if key in data:
            sections.append(key)
    entry["important_sections"] = sections

    # Package manager hint from packageManager field or sibling lockfiles is added later
    pm = data.get("packageManager")
    if isinstance(pm, str):
        if pm.startswith("pnpm"):
            entry["package_managers"].append("pnpm")
        elif pm.startswith("yarn"):
            entry["package_managers"].append("yarn")
        elif pm.startswith("npm"):
            entry["package_managers"].append("npm")
    return entry


def _summarize_pyproject(path: Path, repo_root: Path, warnings: list[str]) -> dict[str, Any]:
    rel = _rel(path, repo_root)
    entry: dict[str, Any] = {
        "path": rel,
        "kind": MANIFEST_KIND[path.name],
        "languages": ["python"],
        "package_managers": [],
        "dependencies": [],
        "dev_dependencies": [],
        "important_sections": [],
    }
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, OSError) as exc:
        warnings.append(f"failed to parse {rel}: {exc}")
        return entry

    project = data.get("project", {})
    if isinstance(project, dict):
        deps = project.get("dependencies", [])
        if isinstance(deps, list):
            entry["dependencies"] = sorted(_strip_requirement(d) for d in deps if isinstance(d, str))
        opt = project.get("optional-dependencies", {})
        if isinstance(opt, dict):
            dev_names: set[str] = set()
            for key in ("dev", "test", "lint"):
                items = opt.get(key, [])
                if isinstance(items, list):
                    for it in items:
                        if isinstance(it, str):
                            dev_names.add(_strip_requirement(it))
            entry["dev_dependencies"] = sorted(dev_names)

    # Dependency-groups (uv / pep 735 style)
    groups = data.get("dependency-groups", {})
    if isinstance(groups, dict):
        dev_names = set(entry["dev_dependencies"])
        for key in ("dev", "test", "lint"):
            items = groups.get(key, [])
            if isinstance(items, list):
                for it in items:
                    if isinstance(it, str):
                        dev_names.add(_strip_requirement(it))
        entry["dev_dependencies"] = sorted(dev_names)

    sections: list[str] = []
    if "project" in data:
        sections.append("project")
    tool = data.get("tool", {})
    if isinstance(tool, dict):
        for key in sorted(tool.keys()):
            sub = tool[key]
            sections.append(f"tool.{key}")
            if isinstance(sub, dict):
                for subkey in sub:
                    sections.append(f"tool.{key}.{subkey}")
    entry["important_sections"] = sections

    # Package manager inference from build-system or tool.uv/poetry sections
    build = data.get("build-system", {})
    if isinstance(build, dict):
        requires = build.get("requires", [])
        if isinstance(requires, list):
            joined = " ".join(str(r).lower() for r in requires)
            if "poetry" in joined:
                entry["package_managers"].append("poetry")
            if "hatch" in joined:
                entry["package_managers"].append("hatch")
            if "setuptools" in joined:
                entry["package_managers"].append("setuptools")

    if isinstance(tool, dict) and "uv" in tool:
        entry["package_managers"].append("uv")
    if isinstance(tool, dict) and "poetry" in tool and "poetry" not in entry["package_managers"]:
        entry["package_managers"].append("poetry")

    return entry


def _strip_requirement(req: str) -> str:
    # "pytest>=8" -> "pytest"; "package[extra]" -> "package"
    name = req.strip()
    for sep in ("<", ">", "=", "!", "~", ";", " "):
        idx = name.find(sep)
        if idx >= 0:
            name = name[:idx]
    if "[" in name:
        name = name.split("[", 1)[0]
    return name.strip()


def _summarize_requirements_txt(path: Path, repo_root: Path, warnings: list[str]) -> dict[str, Any]:
    rel = _rel(path, repo_root)
    entry: dict[str, Any] = {
        "path": rel,
        "kind": MANIFEST_KIND[path.name],
        "languages": ["python"],
        "package_managers": ["pip"],
        "dependencies": [],
        "dev_dependencies": [],
        "important_sections": [],
    }
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        warnings.append(f"failed to read {rel}: {exc}")
        return entry

    names: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        name = _strip_requirement(line)
        if name:
            names.append(name)
    entry["dependencies"] = sorted(set(names))
    return entry


def _summarize_lockfile(path: Path, repo_root: Path) -> dict[str, Any]:
    rel = _rel(path, repo_root)
    # Intentionally do NOT dump content; just record presence.
    entry: dict[str, Any] = {
        "path": rel,
        "kind": MANIFEST_KIND.get(path.name, "lockfile"),
        "languages": [],
        "package_managers": [],
        "dependencies": [],
        "dev_dependencies": [],
        "important_sections": [],
    }
    # Heuristic for js package managers
    if path.name == "pnpm-lock.yaml":
        entry["package_managers"] = ["pnpm"]
        entry["languages"] = ["javascript", "typescript"]
    elif path.name == "yarn.lock":
        entry["package_managers"] = ["yarn"]
        entry["languages"] = ["javascript", "typescript"]
    elif path.name == "package-lock.json":
        entry["package_managers"] = ["npm"]
        entry["languages"] = ["javascript", "typescript"]
    elif path.name == "poetry.lock":
        entry["package_managers"] = ["poetry"]
        entry["languages"] = ["python"]
    elif path.name == "uv.lock":
        entry["package_managers"] = ["uv"]
        entry["languages"] = ["python"]
    elif path.name == "Cargo.lock":
        entry["languages"] = ["rust"]
    elif path.name == "go.sum":
        entry["languages"] = ["go"]
    return entry


def _summarize_generic(path: Path, repo_root: Path) -> dict[str, Any]:
    rel = _rel(path, repo_root)
    kind = MANIFEST_KIND.get(path.name, "unknown")
    languages: list[str] = []
    package_managers: list[str] = []
    if path.name == "Cargo.toml":
        languages = ["rust"]
        package_managers = ["cargo"]
    elif path.name == "go.mod":
        languages = ["go"]
        package_managers = ["go"]
    elif path.name in ("pom.xml", "build.gradle"):
        languages = ["java"]
        package_managers = ["maven"] if path.name == "pom.xml" else ["gradle"]
    elif path.name in ("Dockerfile", "docker-compose.yml"):
        languages = []
    return {
        "path": rel,
        "kind": kind,
        "languages": languages,
        "package_managers": package_managers,
        "dependencies": [],
        "dev_dependencies": [],
        "important_sections": [],
    }


def _summarize_workflow(path: Path, repo_root: Path) -> dict[str, Any]:
    return {
        "path": _rel(path, repo_root),
        "kind": "github-workflow",
        "languages": [],
        "package_managers": [],
        "dependencies": [],
        "dev_dependencies": [],
        "important_sections": [],
    }


def run_manifest_scan(repo_root: Path) -> dict[str, Any]:
    """Discover manifests under repo_root and produce a summary dict."""
    warnings: list[str] = []
    manifests: list[dict[str, Any]] = []

    root_manifests = _find_root_manifests(repo_root)
    for p in root_manifests:
        name = p.name
        if name == "package.json":
            manifests.append(_summarize_package_json(p, repo_root, warnings))
        elif name == "pyproject.toml":
            manifests.append(_summarize_pyproject(p, repo_root, warnings))
        elif name == "requirements.txt":
            manifests.append(_summarize_requirements_txt(p, repo_root, warnings))
        elif name in ("pnpm-lock.yaml", "yarn.lock", "package-lock.json",
                      "poetry.lock", "uv.lock", "Cargo.lock", "go.sum"):
            manifests.append(_summarize_lockfile(p, repo_root))
        else:
            manifests.append(_summarize_generic(p, repo_root))

    for wf in _find_workflows(repo_root):
        manifests.append(_summarize_workflow(wf, repo_root))

    # Cross-link: enrich package.json package_managers from sibling lockfiles
    found_names = {m["path"] for m in manifests}
    for m in manifests:
        if m["path"] == "package.json":
            extra: list[str] = []
            if "pnpm-lock.yaml" in found_names:
                extra.append("pnpm")
            if "yarn.lock" in found_names:
                extra.append("yarn")
            if "package-lock.json" in found_names:
                extra.append("npm")
            for pm in extra:
                if pm not in m["package_managers"]:
                    m["package_managers"].append(pm)

    languages: set[str] = set()
    package_managers: set[str] = set()
    for m in manifests:
        for lang in m.get("languages", []):
            languages.add(lang)
        for pm in m.get("package_managers", []):
            package_managers.add(pm)

    return {
        "manifests": manifests,
        "languages": sorted(languages),
        "package_managers": sorted(package_managers),
        "warnings": warnings,
    }
