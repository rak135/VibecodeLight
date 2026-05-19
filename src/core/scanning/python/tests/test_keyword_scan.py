"""
Tests for keyword hits scan.

TDD: tests are written before implementation.

Covers:
- mechanical hits on paths, filenames, symbol names, doc headings
- no numeric relevance scores
- evidence-only output
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


class TestKeywordHits:
    def test_keyword_hits_find_paths(self, tmp_path: Path):
        s = tmp_path / "src"
        s.mkdir()
        (s / "skills.ts").write_text("export const skill = 1;\n", encoding="utf-8")
        (s / "unrelated.ts").write_text("export const ok = 1;\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        result = run_scanner(
            ["--repo", str(tmp_path), "--task", "add skills feature", "--out", str(out_dir)]
        )
        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "keyword_hits.json").read_text(encoding="utf-8"))
        hits = data["keyword_hits"]
        skills_hits = [h for h in hits if h["keyword"] == "skills"]
        assert skills_hits, f"no hits for 'skills' in {hits}"
        match_paths = [h["path"] for h in skills_hits]
        assert any("src/skills.ts" in p for p in match_paths), f"expected src/skills.ts in {match_paths}"

    def test_keyword_hits_find_symbols(self, tmp_path: Path):
        (tmp_path / "code.py").write_text(
            "def context_builder():\n    pass\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(
            ["--repo", str(tmp_path), "--task", "improve context system", "--out", str(out_dir)]
        )
        data = json.loads((out_dir / "keyword_hits.json").read_text(encoding="utf-8"))
        symbol_hits = [
            h for h in data["keyword_hits"]
            if h["keyword"] == "context" and h["match_type"] == "symbol"
        ]
        assert symbol_hits, f"expected symbol match for context, got {data['keyword_hits']}"
        assert any(h["path"] == "code.py" for h in symbol_hits)

    def test_keyword_hits_find_doc_headings(self, tmp_path: Path):
        (tmp_path / "README.md").write_text(
            "# Project\n\n## Architecture details\n", encoding="utf-8"
        )
        out_dir = tmp_path / "scan"
        run_scanner(
            ["--repo", str(tmp_path), "--task", "document architecture clearly", "--out", str(out_dir)]
        )
        data = json.loads((out_dir / "keyword_hits.json").read_text(encoding="utf-8"))
        heading_hits = [
            h for h in data["keyword_hits"]
            if h["keyword"] == "architecture" and h["match_type"] == "heading"
        ]
        assert heading_hits, f"expected heading match for architecture, got {data['keyword_hits']}"

    def test_no_numeric_relevance_scores(self, tmp_path: Path):
        (tmp_path / "scanner.py").write_text("def f(): pass\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(
            ["--repo", str(tmp_path), "--task", "improve scanner", "--out", str(out_dir)]
        )
        data = json.loads((out_dir / "keyword_hits.json").read_text(encoding="utf-8"))
        for h in data["keyword_hits"]:
            for k, v in h.items():
                assert k not in ("score", "relevance", "weight"), (
                    f"unexpected numeric field {k}={v} in hit {h}"
                )
                # No float fields anywhere
                if isinstance(v, float):
                    raise AssertionError(f"unexpected float field {k}={v} in hit {h}")

    def test_record_has_required_fields(self, tmp_path: Path):
        (tmp_path / "auth.py").write_text("def login(): pass\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        run_scanner(["--repo", str(tmp_path), "--task", "fix auth login", "--out", str(out_dir)])
        data = json.loads((out_dir / "keyword_hits.json").read_text(encoding="utf-8"))
        hits = data["keyword_hits"]
        assert hits, "expected at least one hit for keywords {auth, login}"
        for h in hits:
            for f in ("keyword", "match_type", "path"):
                assert f in h, f"missing field {f} in hit {h}"
            assert h["match_type"] in (
                "path", "filename", "symbol", "heading", "content_excerpt"
            ), f"unexpected match_type: {h['match_type']}"
