"""
Tests for tooling scan: detect formatter/linter/typechecker/test framework configs.
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
    return json.loads((out_dir / "tooling.json").read_text(encoding="utf-8"))


class TestTooling:
    def test_detects_tsconfig(self, tmp_path):
        (tmp_path / "tsconfig.json").write_text("{}\n", encoding="utf-8")
        data = scan(tmp_path)
        assert "tsconfig.json" in data["configs"]
        assert "tsc" in data["typecheckers"]

    def test_detects_vitest_config(self, tmp_path):
        (tmp_path / "vitest.config.ts").write_text("export default {}\n", encoding="utf-8")
        data = scan(tmp_path)
        assert "vitest" in data["test_frameworks"]
        assert "vitest.config.ts" in data["configs"]

    def test_detects_eslint_config(self, tmp_path):
        (tmp_path / "eslint.config.js").write_text("export default []\n", encoding="utf-8")
        data = scan(tmp_path)
        assert "eslint" in data["linters"]
        assert "eslint.config.js" in data["configs"]

    def test_detects_prettier_config(self, tmp_path):
        (tmp_path / ".prettierrc").write_text("{}\n", encoding="utf-8")
        data = scan(tmp_path)
        assert "prettier" in data["formatters"]

    def test_detects_ruff_in_pyproject(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text(
            "[tool.ruff]\nline-length = 100\n",
            encoding="utf-8",
        )
        data = scan(tmp_path)
        assert "ruff" in data["linters"] or "ruff" in data["formatters"]

    def test_detects_pytest_in_pyproject(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text(
            "[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
            encoding="utf-8",
        )
        data = scan(tmp_path)
        assert "pytest" in data["test_frameworks"]

    def test_detects_mypy_config(self, tmp_path):
        (tmp_path / "mypy.ini").write_text("[mypy]\nstrict = True\n", encoding="utf-8")
        data = scan(tmp_path)
        assert "mypy" in data["typecheckers"]

    def test_detects_editorconfig(self, tmp_path):
        (tmp_path / ".editorconfig").write_text("root = true\n", encoding="utf-8")
        data = scan(tmp_path)
        assert ".editorconfig" in data["configs"]

    def test_detects_vite_config(self, tmp_path):
        (tmp_path / "vite.config.ts").write_text("export default {}\n", encoding="utf-8")
        data = scan(tmp_path)
        assert "vite.config.ts" in data["configs"]


class TestToolingStructure:
    def test_required_keys_present(self, tmp_path):
        data = scan(tmp_path)
        for k in ["formatters", "linters", "typecheckers", "test_frameworks", "configs", "warnings"]:
            assert k in data
            assert isinstance(data[k], list)
