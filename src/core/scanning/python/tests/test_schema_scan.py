"""
Tests for schema/API/domain artifact discovery.

TDD: tests are written before implementation.
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


def _paths(entries: list[dict]) -> list[str]:
    return [e["path"] for e in entries]


class TestJsonSchema:
    def test_dot_schema_json_detected(self, tmp_path: Path):
        s = tmp_path / "schemas"
        s.mkdir()
        (s / "thing.schema.json").write_text(
            '{"$schema": "http://json-schema.org/draft-07/schema#"}\n', encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        result = run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "schemas.json").read_text(encoding="utf-8"))
        entries = data["schemas"]
        paths = _paths(entries)
        assert "schemas/thing.schema.json" in paths
        rec = next(e for e in entries if e["path"] == "schemas/thing.schema.json")
        assert rec["kind"] == "json-schema"


class TestOpenApi:
    def test_openapi_yaml_detected(self, tmp_path: Path):
        (tmp_path / "openapi.yaml").write_text("openapi: 3.0.0\ninfo: {}\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "schemas.json").read_text(encoding="utf-8"))["schemas"]
        rec = next((e for e in entries if e["path"] == "openapi.yaml"), None)
        assert rec is not None
        assert rec["kind"] == "openapi"

    def test_swagger_yaml_detected(self, tmp_path: Path):
        (tmp_path / "swagger.yaml").write_text("swagger: '2.0'\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "schemas.json").read_text(encoding="utf-8"))["schemas"]
        rec = next((e for e in entries if e["path"] == "swagger.yaml"), None)
        assert rec is not None
        assert rec["kind"] == "openapi"


class TestGraphQLPrismaProto:
    def test_graphql_file_detected(self, tmp_path: Path):
        (tmp_path / "schema.graphql").write_text("type Query { hi: String }\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "schemas.json").read_text(encoding="utf-8"))["schemas"]
        rec = next((e for e in entries if e["path"] == "schema.graphql"), None)
        assert rec is not None
        assert rec["kind"] == "graphql"

    def test_prisma_schema_detected(self, tmp_path: Path):
        d = tmp_path / "prisma"
        d.mkdir()
        (d / "schema.prisma").write_text("model User { id Int @id }\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "schemas.json").read_text(encoding="utf-8"))["schemas"]
        rec = next((e for e in entries if e["path"].endswith("schema.prisma")), None)
        assert rec is not None
        assert rec["kind"] == "prisma"

    def test_proto_file_detected(self, tmp_path: Path):
        (tmp_path / "api.proto").write_text(
            'syntax = "proto3";\nmessage X {}\n', encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "schemas.json").read_text(encoding="utf-8"))["schemas"]
        rec = next((e for e in entries if e["path"] == "api.proto"), None)
        assert rec is not None
        assert rec["kind"] == "protobuf"


class TestMigrationsAndSql:
    def test_migrations_directory_detected(self, tmp_path: Path):
        m = tmp_path / "migrations"
        m.mkdir()
        (m / "0001_init.sql").write_text("CREATE TABLE x (id INT);\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "schemas.json").read_text(encoding="utf-8"))["schemas"]
        paths = _paths(entries)
        assert "migrations/0001_init.sql" in paths
        rec = next(e for e in entries if e["path"] == "migrations/0001_init.sql")
        assert rec["kind"] in ("migration", "sql")

    def test_sql_schema_file_at_root_detected(self, tmp_path: Path):
        (tmp_path / "schema.sql").write_text("CREATE TABLE y (id INT);\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "schemas.json").read_text(encoding="utf-8"))["schemas"]
        rec = next((e for e in entries if e["path"] == "schema.sql"), None)
        assert rec is not None
        assert rec["kind"] == "sql"


class TestSchemaRecordShape:
    def test_record_has_required_fields(self, tmp_path: Path):
        s = tmp_path / "schemas"
        s.mkdir()
        (s / "a.schema.json") .write_text("{}\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "t", "--out", str(out_dir)])
        entries = json.loads((out_dir / "schemas.json").read_text(encoding="utf-8"))["schemas"]
        rec = entries[0]
        for f in ("path", "kind", "source_evidence"):
            assert f in rec, f"missing field {f} in {rec}"
        # language_guess or format must be present
        assert ("language_guess" in rec) or ("format" in rec)
