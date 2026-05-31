"""
Tests for deterministic exact text phrase extraction and hit scanning.

TDD: these tests describe raw-user-task exact text evidence before implementation.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

SCANNER_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SCANNER_DIR))

from vibecode_scanner.scan.exact_text_scan import extract_exact_phrases  # noqa: E402
EXACT_DESCRIPTION = (
    "Translates and expands your task into English search hints before context selection. "
    "Does not select files."
)


def run_scanner(args: list[str], cwd: Path = SCANNER_DIR) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "vibecode_scanner", *args],
        capture_output=True,
        text=True,
        cwd=cwd,
    )


class TestExactPhraseExtraction:
    def test_extracts_parenthesized_ui_text_from_czech_task(self):
        task = (
            "odstraň z GUI popis task normalizeru - "
            f"({EXACT_DESCRIPTION})"
        )

        phrases = extract_exact_phrases(task)

        assert [phrase["text"] for phrase in phrases] == [EXACT_DESCRIPTION]
        assert phrases[0]["source"] == "parenthesized"
        assert phrases[0]["normalized_text"] == EXACT_DESCRIPTION

    @pytest.mark.parametrize(
        ("task", "expected"),
        [
            ('Remove label "Exact quoted UI text should be found here"', "Exact quoted UI text should be found here"),
            ("Remove label 'Single quoted UI text should be found here'", "Single quoted UI text should be found here"),
            ("Error: TypeError: Cannot read properties of undefined while rendering preview panel", "TypeError: Cannot read properties of undefined while rendering preview panel"),
        ],
    )
    def test_extracts_quoted_and_error_strings(self, task: str, expected: str):
        phrases = extract_exact_phrases(task)

        assert expected in [phrase["text"] for phrase in phrases]

    def test_ignores_too_short_phrases(self):
        phrases = extract_exact_phrases("fix GUI - (short text)")

        assert phrases == []

    def test_caps_phrase_count(self):
        task = " ".join(f'"Long exact phrase number {index} with enough words"' for index in range(20))

        phrases = extract_exact_phrases(task)

        assert len(phrases) == 10
        assert phrases[0]["text"] == "Long exact phrase number 0 with enough words"


class TestExactTextScanner:
    def test_scanner_writes_exact_text_hits_with_line_and_excerpt(self, tmp_path: Path):
        renderer = tmp_path / "src" / "app" / "desktop" / "renderer"
        renderer.mkdir(parents=True)
        (renderer / "index.html").write_text(
            f"<p>{EXACT_DESCRIPTION}</p>\n",
            encoding="utf-8",
        )
        (tmp_path / "settings.ts").write_text("export const settings = true;\n", encoding="utf-8")
        out_dir = tmp_path / "scan"
        task = f"odstraň z GUI popis task normalizeru - ({EXACT_DESCRIPTION})"

        result = run_scanner(["--repo", str(tmp_path), "--task", task, "--out", str(out_dir)])

        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "exact_text_hits.json").read_text(encoding="utf-8"))
        hits = data["exact_text_hits"]
        assert hits, data
        hit = hits[0]
        assert hit["term"] == EXACT_DESCRIPTION
        assert hit["provenance"] == "exact_phrase"
        assert hit["match_type"] == "exact_text"
        assert hit["path"] == "src/app/desktop/renderer/index.html"
        assert hit["line"] == 1
        assert EXACT_DESCRIPTION in hit["excerpt"]

    def test_scanner_respects_ignored_directories_for_exact_text_hits(self, tmp_path: Path):
        (tmp_path / ".gitignore").write_text("ignored/\n", encoding="utf-8")
        ignored = tmp_path / "ignored"
        ignored.mkdir()
        (ignored / "index.html").write_text(EXACT_DESCRIPTION, encoding="utf-8")
        (tmp_path / "visible.txt").write_text("no exact phrase here", encoding="utf-8")
        out_dir = tmp_path / "scan"
        task = f"remove ({EXACT_DESCRIPTION})"

        result = run_scanner(["--repo", str(tmp_path), "--task", task, "--out", str(out_dir)])

        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "exact_text_hits.json").read_text(encoding="utf-8"))
        assert data["exact_text_hits"] == []

    def test_scanner_matches_normalized_whitespace_but_keeps_original_phrase(self, tmp_path: Path):
        phrase = "Alpha beta gamma delta epsilon"
        (tmp_path / "ui.html").write_text("<p>Alpha   beta\tgamma  delta epsilon</p>\n", encoding="utf-8")
        out_dir = tmp_path / "scan"

        result = run_scanner(["--repo", str(tmp_path), "--task", f"remove ({phrase})", "--out", str(out_dir)])

        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "exact_text_hits.json").read_text(encoding="utf-8"))
        hits = data["exact_text_hits"]
        assert hits
        assert hits[0]["term"] == phrase
        assert hits[0]["normalized_term"] == phrase
        assert hits[0]["match_type"] == "normalized_whitespace"
        assert hits[0]["path"] == "ui.html"

    def test_scanner_does_not_treat_case_only_differences_as_exact_text(self, tmp_path: Path):
        phrase = "Alpha beta gamma delta epsilon"
        (tmp_path / "ui.html").write_text("ALPHA BETA GAMMA DELTA EPSILON\n", encoding="utf-8")
        out_dir = tmp_path / "scan"

        result = run_scanner(["--repo", str(tmp_path), "--task", f"remove ({phrase})", "--out", str(out_dir)])

        assert result.returncode == 0, result.stderr
        data = json.loads((out_dir / "exact_text_hits.json").read_text(encoding="utf-8"))
        assert data["exact_text_hits"] == []
