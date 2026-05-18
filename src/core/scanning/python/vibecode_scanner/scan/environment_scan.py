"""
Local environment snapshot.

Records what runtimes/package managers are installed locally on the developer
machine. Records warnings for missing tools instead of crashing.

Kept strictly separate from manifests.json (which records what the repo declares).
"""
from __future__ import annotations

import platform
import subprocess
import sys
from typing import Any

# Each entry: (logical name, [command, args...], post-processor for stdout/stderr)
TOOLS: list[tuple[str, list[str]]] = [
    ("python", [sys.executable, "--version"]),
    ("node", ["node", "--version"]),
    ("pnpm", ["pnpm", "--version"]),
    ("npm", ["npm", "--version"]),
    ("uv", ["uv", "--version"]),
    ("git", ["git", "--version"]),
]


def _normalize_version(name: str, raw: str) -> str:
    text = raw.strip()
    # Many tools emit "Python 3.11.9" or "git version 2.45.0"; keep the version part.
    if name == "python" and text.lower().startswith("python "):
        return text.split(" ", 1)[1].strip()
    if name == "git" and text.lower().startswith("git version "):
        return text[len("git version ") :].strip()
    return text


def _probe(name: str, argv: list[str]) -> tuple[bool, str | None, str | None]:
    """Run argv. Return (available, version_or_None, warning_or_None)."""
    try:
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, OSError):
        return False, None, f"{name} not available on PATH"
    except subprocess.TimeoutExpired:
        return False, None, f"{name} --version timed out"
    except Exception as exc:  # noqa: BLE001 - defensive
        return False, None, f"{name} probe failed: {exc}"

    if result.returncode != 0:
        return False, None, f"{name} --version exited with code {result.returncode}"

    raw = result.stdout or result.stderr or ""
    version = _normalize_version(name, raw)
    if not version:
        return True, None, f"{name} returned no version string"
    return True, version, None


def run_environment_scan() -> dict[str, Any]:
    tools: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []

    for name, argv in TOOLS:
        available, version, warning = _probe(name, argv)
        tools[name] = {"available": available, "version": version}
        if warning:
            warnings.append(warning)

    host = {
        "platform": platform.system(),
        "platform_release": platform.release(),
        "python_executable": sys.executable,
    }

    return {"tools": tools, "host": host, "warnings": warnings}
