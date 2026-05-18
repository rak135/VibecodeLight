"""
Tests for manifest scan: detect project manifests and summarize what they declare.
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
    return json.loads((out_dir / "manifests.json").read_text(encoding="utf-8"))


class TestPackageJson:
    def test_detects_package_json(self, tmp_path):
        (tmp_path / "package.json").write_text(
            json.dumps({
                "name": "demo",
                "version": "0.1.0",
                "dependencies": {"left-pad": "1.0.0"},
                "devDependencies": {"vitest": "^2"},
                "scripts": {"test": "vitest run", "build": "tsc"},
            }),
            encoding="utf-8",
        )
        data = scan(tmp_path)
        paths = [m["path"] for m in data["manifests"]]
        assert "package.json" in paths
        pkg = next(m for m in data["manifests"] if m["path"] == "package.json")
        assert pkg["kind"] == "node-project"
        assert "javascript" in pkg["languages"] or "typescript" in pkg["languages"]
        # package manager guess (no lockfile present yet, can be empty list)
        assert "package_managers" in pkg

    def test_package_json_dependency_summary(self, tmp_path):
        (tmp_path / "package.json").write_text(
            json.dumps({
                "name": "demo",
                "dependencies": {"react": "^18", "yaml": "^2"},
                "devDependencies": {"vitest": "^2"},
            }),
            encoding="utf-8",
        )
        data = scan(tmp_path)
        pkg = next(m for m in data["manifests"] if m["path"] == "package.json")
        assert "react" in pkg["dependencies"]
        assert "yaml" in pkg["dependencies"]
        assert "vitest" in pkg["dev_dependencies"]


class TestLockfiles:
    def test_detects_pnpm_lock(self, tmp_path):
        (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '6.0'\n", encoding="utf-8")
        data = scan(tmp_path)
        paths = [m["path"] for m in data["manifests"]]
        assert "pnpm-lock.yaml" in paths
        entry = next(m for m in data["manifests"] if m["path"] == "pnpm-lock.yaml")
        assert entry["kind"] in ("lockfile", "pnpm-lock")
        # lockfiles must not dump huge content; expect no "content" key with raw text
        assert "content" not in entry

    def test_detects_yarn_lock(self, tmp_path):
        (tmp_path / "yarn.lock").write_text("# yarn lockfile v1\n", encoding="utf-8")
        data = scan(tmp_path)
        paths = [m["path"] for m in data["manifests"]]
        assert "yarn.lock" in paths

    def test_detects_package_lock(self, tmp_path):
        (tmp_path / "package-lock.json").write_text("{}\n", encoding="utf-8")
        data = scan(tmp_path)
        paths = [m["path"] for m in data["manifests"]]
        assert "package-lock.json" in paths


class TestPyproject:
    def test_detects_pyproject_toml(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text(
            """
[project]
name = "demo"
version = "0.1.0"
dependencies = ["typer", "pydantic"]

[project.optional-dependencies]
dev = ["pytest", "ruff"]

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.ruff]
line-length = 100
""",
            encoding="utf-8",
        )
        data = scan(tmp_path)
        paths = [m["path"] for m in data["manifests"]]
        assert "pyproject.toml" in paths
        py = next(m for m in data["manifests"] if m["path"] == "pyproject.toml")
        assert py["kind"] == "python-project"
        assert "python" in py["languages"]
        assert "typer" in py["dependencies"]
        assert "pydantic" in py["dependencies"]
        assert "tool.pytest" in py["important_sections"] or "tool.pytest.ini_options" in py["important_sections"]
        assert "tool.ruff" in py["important_sections"]


class TestRequirementsTxt:
    def test_detects_requirements_txt(self, tmp_path):
        (tmp_path / "requirements.txt").write_text("requests==2.31.0\nrich>=13\n# comment\n", encoding="utf-8")
        data = scan(tmp_path)
        paths = [m["path"] for m in data["manifests"]]
        assert "requirements.txt" in paths
        entry = next(m for m in data["manifests"] if m["path"] == "requirements.txt")
        assert entry["kind"] in ("python-requirements", "requirements")
        assert "requests" in entry["dependencies"]
        assert "rich" in entry["dependencies"]


class TestOtherManifests:
    def test_detects_cargo_toml(self, tmp_path):
        (tmp_path / "Cargo.toml").write_text('[package]\nname = "x"\n', encoding="utf-8")
        data = scan(tmp_path)
        paths = [m["path"] for m in data["manifests"]]
        assert "Cargo.toml" in paths

    def test_detects_go_mod(self, tmp_path):
        (tmp_path / "go.mod").write_text("module example.com/x\n", encoding="utf-8")
        data = scan(tmp_path)
        paths = [m["path"] for m in data["manifests"]]
        assert "go.mod" in paths

    def test_detects_dockerfile(self, tmp_path):
        (tmp_path / "Dockerfile").write_text("FROM python:3.11\n", encoding="utf-8")
        data = scan(tmp_path)
        paths = [m["path"] for m in data["manifests"]]
        assert "Dockerfile" in paths

    def test_detects_makefile(self, tmp_path):
        (tmp_path / "Makefile").write_text("test:\n\tpytest\n", encoding="utf-8")
        data = scan(tmp_path)
        paths = [m["path"] for m in data["manifests"]]
        assert "Makefile" in paths

    def test_detects_github_workflow(self, tmp_path):
        wf_dir = tmp_path / ".github" / "workflows"
        wf_dir.mkdir(parents=True)
        (wf_dir / "ci.yml").write_text("name: ci\non: push\n", encoding="utf-8")
        data = scan(tmp_path)
        paths = [m["path"] for m in data["manifests"]]
        # Path normalized to forward slashes
        assert ".github/workflows/ci.yml" in paths


class TestMalformedManifest:
    def test_malformed_package_json_does_not_crash(self, tmp_path):
        (tmp_path / "package.json").write_text("{not json", encoding="utf-8")
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "x", "--out", str(out_dir)])
        # Scanner must still succeed
        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "manifests.json").read_text(encoding="utf-8"))
        assert any("package.json" in w for w in data.get("warnings", []))

    def test_malformed_pyproject_does_not_crash(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text("not = valid =\n[", encoding="utf-8")
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "x", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "manifests.json").read_text(encoding="utf-8"))
        assert any("pyproject.toml" in w for w in data.get("warnings", []))
