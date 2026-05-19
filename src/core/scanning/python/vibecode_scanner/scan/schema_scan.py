"""
Schema / API / domain artifact detection.

Detects files that define data shape or API/domain contracts:
- JSON schema: *.schema.json, schemas/*.json
- OpenAPI: openapi.yaml/yml, swagger.yaml/yml
- GraphQL: *.graphql
- Prisma: *.prisma
- Protobuf: *.proto
- SQL schema: schema.sql, migrations/*.sql
- Migrations: migrations/* (sql, py, ts, ...)
- pydantic/zod model files (path/name heuristic only)

Each record:
    {
        "path": "<rel>",
        "kind": "json-schema" | "openapi" | "graphql" | "prisma"
                | "protobuf" | "sql" | "migration" | "model" | "schema",
        "language_guess"?: str,
        "format"?: str,
        "source_evidence": "<short reason>"
    }
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable


OPENAPI_NAMES = {"openapi.yaml", "openapi.yml", "swagger.yaml", "swagger.yml"}
SQL_SCHEMA_ROOT_NAMES = {"schema.sql"}


def _to_rel(p: Path) -> str:
    return str(p).replace("\\", "/")


def _classify(rel: str) -> dict[str, Any] | None:
    name = Path(rel).name.lower()
    ext = Path(rel).suffix.lower()

    # JSON Schema: *.schema.json (also schemas/*.json files)
    if name.endswith(".schema.json"):
        return {
            "kind": "json-schema",
            "format": "json",
            "language_guess": "json",
            "source_evidence": "filename ends with .schema.json",
        }
    if rel.startswith("schemas/") and ext == ".json":
        return {
            "kind": "json-schema",
            "format": "json",
            "language_guess": "json",
            "source_evidence": "file under schemas/ with .json extension",
        }

    # OpenAPI / Swagger
    if name in OPENAPI_NAMES or rel.endswith("/openapi.yaml") or rel.endswith("/openapi.yml") \
            or rel.endswith("/swagger.yaml") or rel.endswith("/swagger.yml"):
        return {
            "kind": "openapi",
            "format": "yaml",
            "language_guess": "yaml",
            "source_evidence": "OpenAPI/Swagger filename",
        }

    if ext == ".graphql":
        return {
            "kind": "graphql",
            "format": "graphql",
            "language_guess": "graphql",
            "source_evidence": ".graphql extension",
        }

    if ext == ".prisma":
        return {
            "kind": "prisma",
            "format": "prisma",
            "language_guess": "prisma",
            "source_evidence": ".prisma extension",
        }

    if ext == ".proto":
        return {
            "kind": "protobuf",
            "format": "proto",
            "language_guess": "protobuf",
            "source_evidence": ".proto extension",
        }

    # SQL: schema.sql at root or migrations/*.sql
    if name in SQL_SCHEMA_ROOT_NAMES and "/" not in rel:
        return {
            "kind": "sql",
            "format": "sql",
            "language_guess": "sql",
            "source_evidence": "schema.sql at repo root",
        }

    # Migrations directories
    if rel.startswith("migrations/") or "/migrations/" in f"/{rel}":
        kind = "migration"
        # SQL migrations get extra labeling
        fmt = ext.lstrip(".") if ext else "unknown"
        return {
            "kind": kind,
            "format": fmt or "unknown",
            "language_guess": fmt or "unknown",
            "source_evidence": "path under migrations/",
        }

    # pydantic/zod heuristics: file named models.py/schemas.py at any depth
    if name in ("models.py", "schemas.py", "schema.py"):
        return {
            "kind": "model",
            "language_guess": "python",
            "format": "python",
            "source_evidence": f"filename: {name}",
        }
    if name in ("schemas.ts", "schema.ts") or name.endswith(".schema.ts") or name.endswith(".zod.ts"):
        return {
            "kind": "model",
            "language_guess": "typescript",
            "format": "typescript",
            "source_evidence": "TypeScript schema/model filename",
        }

    return None


def run_schema_scan(repo_root: Path, paths: Iterable[Path]) -> dict[str, Any]:
    warnings: list[str] = []
    entries: list[dict[str, Any]] = []

    for p in paths:
        rel = _to_rel(p)
        classified = _classify(rel)
        if classified is None:
            continue
        record = {"path": rel}
        record.update(classified)
        entries.append(record)

    entries.sort(key=lambda e: e["path"])
    return {"schemas": entries, "warnings": warnings}
