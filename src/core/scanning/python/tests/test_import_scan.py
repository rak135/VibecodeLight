"""
Tests for import extraction (practical, regex-based).

TDD: tests are written before implementation.

Covers:
- Python: import x, import x as y, from x import y
- TypeScript/JS: import ... from "x", import "x", require("x")
- Local vs external classification
- Each record includes: from_path, import_target, kind, line, language_guess
"""
from __future__ import annotations

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


def _from_to(entries: list[dict], from_path: str, target: str) -> dict | None:
    for e in entries:
        if e.get("from_path") == from_path and e.get("import_target") == target:
            return e
    return None


class TestPythonImports:
    def test_simple_import(self, tmp_path: Path):
        (tmp_path / "a.py").write_text(
            "import os\nimport sys as system\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        imports = json.loads((out_dir / "imports.json").read_text(encoding="utf-8"))["imports"]

        os_imp = _from_to(imports, "a.py", "os")
        assert os_imp is not None
        assert os_imp["kind"] == "external"
        assert os_imp["line"] == 1
        assert os_imp["language_guess"] == "python"

        sys_imp = _from_to(imports, "a.py", "sys")
        assert sys_imp is not None
        assert sys_imp["line"] == 2

    def test_from_import(self, tmp_path: Path):
        (tmp_path / "b.py").write_text(
            "from pathlib import Path\nfrom .local_mod import thing\n",
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        imports = json.loads((out_dir / "imports.json").read_text(encoding="utf-8"))["imports"]
        path_imp = _from_to(imports, "b.py", "pathlib")
        assert path_imp is not None
        assert path_imp["kind"] == "external"

        local_imp = _from_to(imports, "b.py", ".local_mod")
        assert local_imp is not None
        assert local_imp["kind"] == "local"


class TestTypeScriptImports:
    def test_import_from(self, tmp_path: Path):
        (tmp_path / "x.ts").write_text(
            'import { y } from "./y";\n'
            'import { z } from "lodash";\n',
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        imports = json.loads((out_dir / "imports.json").read_text(encoding="utf-8"))["imports"]

        rel = _from_to(imports, "x.ts", "./y")
        assert rel is not None
        assert rel["kind"] == "local"
        assert rel["language_guess"] == "typescript"

        ext = _from_to(imports, "x.ts", "lodash")
        assert ext is not None
        assert ext["kind"] == "external"

    def test_side_effect_import(self, tmp_path: Path):
        (tmp_path / "se.ts").write_text(
            'import "./styles.css";\n', encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        imports = json.loads((out_dir / "imports.json").read_text(encoding="utf-8"))["imports"]
        styles = _from_to(imports, "se.ts", "./styles.css")
        assert styles is not None
        assert styles["kind"] == "local"

    def test_require_call(self, tmp_path: Path):
        (tmp_path / "r.js").write_text(
            'const fs = require("fs");\n'
            'const local = require("./helper");\n',
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        imports = json.loads((out_dir / "imports.json").read_text(encoding="utf-8"))["imports"]
        fs_imp = _from_to(imports, "r.js", "fs")
        assert fs_imp is not None
        assert fs_imp["kind"] == "external"
        helper = _from_to(imports, "r.js", "./helper")
        assert helper is not None
        assert helper["kind"] == "local"


class TestImportBoundaries:
    def test_vibecode_excluded(self, tmp_path: Path):
        v = tmp_path / ".vibecode"
        v.mkdir()
        (v / "leak.py").write_text("import os\n", encoding="utf-8")
        (tmp_path / "ok.py").write_text("import os\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        imports = json.loads((out_dir / "imports.json").read_text(encoding="utf-8"))["imports"]
        from_paths = {e["from_path"] for e in imports}
        assert "ok.py" in from_paths
        assert not any(p.startswith(".vibecode") for p in from_paths)
