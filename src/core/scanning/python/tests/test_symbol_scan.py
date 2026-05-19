"""
Tests for symbol extraction (regex-based).

TDD: tests are written before implementation.

Covers:
- Python: class, def, async def, decorators @app.command / @app.route
- TypeScript/JavaScript: export function/class/interface/type, function X, const X =, export const X =
- Each record includes: path, name, kind, signature, line, language_guess, extraction_method == "regex"
- Files under .vibecode/ are excluded
- No AST parsing is required
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


def _by_name(entries: list[dict], name: str) -> list[dict]:
    return [e for e in entries if e.get("name") == name]


class TestPythonSymbols:
    def test_class_and_def_are_extracted(self, tmp_path: Path):
        (tmp_path / "module.py").write_text(
            "class Greeter:\n"
            "    def hello(self, who: str) -> str:\n"
            "        return f'hi {who}'\n"
            "\n"
            "def standalone(x):\n"
            "    return x\n",
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr

        data = json.loads((out_dir / "symbols.json").read_text(encoding="utf-8"))
        symbols = data["symbols"]

        greeter = _by_name(symbols, "Greeter")
        assert greeter, f"missing class Greeter in {symbols}"
        assert greeter[0]["kind"] == "class"
        assert greeter[0]["language_guess"] == "python"
        assert greeter[0]["extraction_method"] == "regex"
        assert greeter[0]["path"] == "module.py"
        assert greeter[0]["line"] == 1

        hello = _by_name(symbols, "hello")
        assert hello, "missing def hello"
        assert hello[0]["kind"] == "function"

        standalone = _by_name(symbols, "standalone")
        assert standalone, "missing def standalone"
        assert standalone[0]["kind"] == "function"

    def test_async_def_is_extracted(self, tmp_path: Path):
        (tmp_path / "a.py").write_text(
            "async def fetch_thing(url):\n    return url\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        symbols = json.loads((out_dir / "symbols.json").read_text(encoding="utf-8"))["symbols"]
        rec = _by_name(symbols, "fetch_thing")
        assert rec, "async def must be extracted"
        assert rec[0]["kind"] in ("async-function", "function")

    def test_app_command_and_route_decorators(self, tmp_path: Path):
        (tmp_path / "cli.py").write_text(
            "@app.command()\n"
            "def my_cmd():\n"
            "    pass\n"
            "\n"
            "@app.route('/users')\n"
            "def list_users():\n"
            "    pass\n",
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        symbols = json.loads((out_dir / "symbols.json").read_text(encoding="utf-8"))["symbols"]
        names = {e["name"]: e for e in symbols}
        assert "my_cmd" in names
        assert "list_users" in names
        # At least one symbol records that a decorator was present
        decorated = [e for e in symbols if e.get("decorators")]
        assert any(any("app.command" in d for d in e["decorators"]) for e in decorated), (
            f"expected @app.command decorator in {decorated}"
        )
        assert any(any("app.route" in d for d in e["decorators"]) for e in decorated), (
            f"expected @app.route decorator in {decorated}"
        )


class TestTypeScriptSymbols:
    def test_export_function_and_class_are_extracted(self, tmp_path: Path):
        (tmp_path / "mod.ts").write_text(
            "export function runIt(x: number): number { return x; }\n"
            "export class Service {}\n",
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        symbols = json.loads((out_dir / "symbols.json").read_text(encoding="utf-8"))["symbols"]
        run_it = _by_name(symbols, "runIt")
        assert run_it, "missing export function runIt"
        assert run_it[0]["kind"] == "function"
        assert run_it[0]["language_guess"] == "typescript"
        assert run_it[0]["extraction_method"] == "regex"
        svc = _by_name(symbols, "Service")
        assert svc, "missing export class Service"
        assert svc[0]["kind"] == "class"

    def test_export_interface_and_type(self, tmp_path: Path):
        (tmp_path / "types.ts").write_text(
            "export interface User { id: string }\n"
            "export type Id = string;\n",
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        symbols = json.loads((out_dir / "symbols.json").read_text(encoding="utf-8"))["symbols"]
        user = _by_name(symbols, "User")
        assert user and user[0]["kind"] == "interface"
        idsym = _by_name(symbols, "Id")
        assert idsym and idsym[0]["kind"] == "type"

    def test_plain_function_and_const_assignment(self, tmp_path: Path):
        (tmp_path / "f.ts").write_text(
            "function helper() { return 1; }\n"
            "const value = 42;\n"
            "export const exported = 'x';\n",
            encoding="utf-8",
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        symbols = json.loads((out_dir / "symbols.json").read_text(encoding="utf-8"))["symbols"]
        names = {e["name"] for e in symbols}
        assert "helper" in names
        assert "value" in names
        assert "exported" in names

    def test_js_file_is_also_scanned(self, tmp_path: Path):
        (tmp_path / "a.js").write_text(
            "export function jsFn() {}\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        symbols = json.loads((out_dir / "symbols.json").read_text(encoding="utf-8"))["symbols"]
        assert any(e["name"] == "jsFn" and e["language_guess"] == "javascript" for e in symbols)


class TestSymbolBoundaries:
    def test_vibecode_dir_is_excluded(self, tmp_path: Path):
        v = tmp_path / ".vibecode" / "stuff"
        v.mkdir(parents=True)
        (v / "leak.py").write_text("def secret_fn(): pass\n", encoding="utf-8")
        (tmp_path / "ok.py").write_text("def public_fn(): pass\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        symbols = json.loads((out_dir / "symbols.json").read_text(encoding="utf-8"))["symbols"]
        names = {e["name"] for e in symbols}
        assert "public_fn" in names
        assert "secret_fn" not in names

    def test_unreadable_file_does_not_crash_and_records_warning(self, tmp_path: Path):
        (tmp_path / "broken.py").write_bytes(b"\xff\xfe\x00 not utf-8 \xff")
        (tmp_path / "good.py").write_text("def good_fn(): pass\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "symbols.json").read_text(encoding="utf-8"))
        warnings = data.get("warnings", [])
        assert any("broken.py" in w for w in warnings), f"expected warning for broken.py in {warnings}"
        names = {e["name"] for e in data["symbols"]}
        assert "good_fn" in names

    def test_symbol_record_required_fields(self, tmp_path: Path):
        (tmp_path / "m.py").write_text("def foo():\n    pass\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        symbols = json.loads((out_dir / "symbols.json").read_text(encoding="utf-8"))["symbols"]
        foo = _by_name(symbols, "foo")[0]
        for field in ("path", "name", "kind", "signature", "line", "language_guess", "extraction_method"):
            assert field in foo, f"missing field {field} in {foo}"
        assert foo["extraction_method"] == "regex"
