"""
Tests for command scan: build/test/lint/run command extraction with provenance.
"""
import json
import subprocess
import sys
from pathlib import Path

SCANNER_DIR = Path(__file__).parent.parent


def run_scanner(args: list[str], cwd: Path = SCANNER_DIR) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "vibecode_scanner", *args],
        capture_output=True,
        text=True,
        cwd=cwd,
    )


def scan(tmp_path: Path) -> dict:
    out_dir = tmp_path / "scan"
    result = run_scanner(["--repo", str(tmp_path), "--task", "test", "--out", str(out_dir)])
    assert result.returncode == 0, result.stderr
    return json.loads((out_dir / "commands.json").read_text(encoding="utf-8"))


class TestPackageJsonScripts:
    def test_extracts_scripts_with_provenance(self, tmp_path):
        (tmp_path / "package.json").write_text(
            json.dumps({
                "scripts": {
                    "test": "vitest run",
                    "build": "tsc",
                    "lint": "eslint src",
                    "format": "prettier --write .",
                    "typecheck": "tsc --noEmit",
                    "dev": "vite",
                }
            }),
            encoding="utf-8",
        )
        data = scan(tmp_path)
        # commands grouped by category; package.json scripts are invoked via the package manager
        assert "test" in data["commands"]
        test_entries = data["commands"]["test"]
        # Canonical form per task spec: {"command": "pnpm test", "source": "package.json:scripts.test"}
        assert any(
            e["command"].endswith(" test") and "scripts.test" in e["source"]
            for e in test_entries
        )
        assert "build" in data["commands"]
        assert any(e["command"].endswith(" build") for e in data["commands"]["build"])
        # lint
        assert any(e["command"].endswith(" lint") for e in data["commands"].get("lint", []))
        # format
        assert any(e["command"].endswith(" format") for e in data["commands"].get("format", []))
        # typecheck
        assert any(e["command"].endswith(" typecheck") for e in data["commands"].get("typecheck", []))
        # run (dev)
        assert any(e["command"].endswith(" dev") for e in data["commands"].get("run", []))

    def test_source_field_includes_scripts_key(self, tmp_path):
        (tmp_path / "package.json").write_text(
            json.dumps({"scripts": {"test": "pnpm test"}}),
            encoding="utf-8",
        )
        data = scan(tmp_path)
        test_entries = data["commands"].get("test", [])
        assert len(test_entries) >= 1
        # Provenance should look like "package.json:scripts.test"
        assert any("scripts.test" in e["source"] for e in test_entries)


class TestPyprojectCommands:
    def test_detects_pytest_when_declared(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text(
            """
[project]
name = "x"

[tool.pytest.ini_options]
testpaths = ["tests"]
""",
            encoding="utf-8",
        )
        data = scan(tmp_path)
        assert any("pytest" in e["command"] for e in data["commands"].get("test", []))

    def test_detects_ruff_when_declared(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text(
            """
[project]
name = "x"

[tool.ruff]
line-length = 100
""",
            encoding="utf-8",
        )
        data = scan(tmp_path)
        assert any("ruff check" in e["command"] for e in data["commands"].get("lint", []))


class TestMakefile:
    def test_extracts_make_targets(self, tmp_path):
        (tmp_path / "Makefile").write_text(
            "test:\n\tpytest -v\n\nlint:\n\truff check .\n",
            encoding="utf-8",
        )
        data = scan(tmp_path)
        # test should include `make test`
        assert any("make test" in e["command"] and "Makefile" in e["source"] for e in data["commands"].get("test", []))


class TestJustfile:
    def test_extracts_just_recipes(self, tmp_path):
        (tmp_path / "justfile").write_text(
            "test:\n    pytest -v\n\nlint:\n    ruff check .\n",
            encoding="utf-8",
        )
        data = scan(tmp_path)
        assert any("just test" in e["command"] for e in data["commands"].get("test", []))


class TestToxAndNox:
    def test_detects_tox_ini(self, tmp_path):
        (tmp_path / "tox.ini").write_text("[tox]\nenvlist = py311\n", encoding="utf-8")
        data = scan(tmp_path)
        assert any("tox" in e["command"] for e in data["commands"].get("test", []))

    def test_detects_noxfile(self, tmp_path):
        (tmp_path / "noxfile.py").write_text("import nox\n", encoding="utf-8")
        data = scan(tmp_path)
        assert any("nox" in e["command"] for e in data["commands"].get("test", []))


class TestGithubWorkflows:
    def test_workflow_yaml_is_recorded_as_source(self, tmp_path):
        wf_dir = tmp_path / ".github" / "workflows"
        wf_dir.mkdir(parents=True)
        (wf_dir / "ci.yml").write_text(
            """
name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm install
      - run: pnpm test
""",
            encoding="utf-8",
        )
        data = scan(tmp_path)
        # Either pnpm install or pnpm test recorded with workflow file as source
        flat = [e for cat in data["commands"].values() for e in cat]
        assert any(".github/workflows/ci.yml" in e["source"] for e in flat)


class TestCommandsStructure:
    def test_commands_has_required_categories(self, tmp_path):
        data = scan(tmp_path)
        assert "commands" in data
        # All seven categories present as keys
        for cat in ["install", "run", "test", "lint", "format", "typecheck", "build"]:
            assert cat in data["commands"]
            assert isinstance(data["commands"][cat], list)

    def test_warnings_field_present(self, tmp_path):
        data = scan(tmp_path)
        assert "warnings" in data
        assert isinstance(data["warnings"], list)
