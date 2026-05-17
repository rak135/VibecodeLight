# Vision

## Product Direction

VibecodeLight provides deterministic, local-first preparation for coding-model runs.
The initial implementation emphasizes predictable artifact generation, reproducible run state, and explicit ownership boundaries between TypeScript orchestration and Python scanning.

## Outcome for Initial Implementation

The initial implementation should:
- Produce deterministic run artifacts under `.vibecode/runs/<run_id>/`.
- Produce a Markdown-first flash output at `.vibecode/runs/<run_id>/flash/flash_output.md` with stable sections.
- Build context and final prompt artifacts from deterministic scan + skills selection.
- Keep operational behavior inspectable and reversible by run metadata and git history.

## Scope Boundaries

This initial contract does not require implementation scaffolding in this repository baseline step.
It defines what must be built later and how components must agree.

## Authority Rule

`docs/ARCHITECTURE_DECISIONS.md` is the implementation contract and source of truth for concrete implementation decisions.
`AGENTS.md` is the operational guide.
If implementation detail conflicts occur, `docs/ARCHITECTURE_DECISIONS.md` wins.

## Preflight Terminology

Preflight is a product-level synonym for deterministic scan.
There is no canonical `preflight.json` in the initial implementation.
Canonical outputs for this phase live under `.vibecode/runs/<run_id>/scan/`.

## Config Direction

Human-maintained project configuration lives in root `config.yaml`.
Per-run scanner input is `.vibecode/runs/<run_id>/scanner_config.json`.
Scanner snapshot artifact is `.vibecode/runs/<run_id>/scan/config_snapshot.json`.

`.vibecode/config.json` is not part of the initial contract.

## Flash Output Direction

Initial implementation is Markdown-first.
Canonical initial output:
- `.vibecode/runs/<run_id>/flash/flash_output.md`

Required headings:
- `# Task Summary`
- `# Relevant Files`
- `# Files To Read With Tools`
- `# Relevant Tests`
- `# Commands To Run`
- `# Selected Skills`
- `# Cautions`
- `# Context Pack`

Optional metadata:
- `.vibecode/runs/<run_id>/flash/flash_output_meta.json`

Future extension:
- `.vibecode/runs/<run_id>/flash/flash_output.json`
- `.vibecode/runs/<run_id>/flash/flash_validation.json`

Any future JSON flash mode must be schema-validated before use.

## Skills Direction

TypeScript owns canonical skills cataloging and selected-skills artifacts.
Python scanner may observe `SKILLS/` as regular repository files but does not own skills catalog creation and does not copy/sync/manage skills.

Primary skills location is user profile.
Project snapshot skills location is root `SKILLS/`.
Source skills are never stored in `.vibecode/`.

## Security Direction

Initial VibecodeLight does not perform aggressive secret redaction or fixed filename censorship.
It respects ignore rules.
Users remain responsible for keeping secrets out of non-ignored repository content.
Provider secrets must live outside committed project files.

## Commit Direction

Each model run is expected to create a deterministic git commit that captures the run result.
If tests fail, the run and commit must clearly mark the failed validation state.
The CLI/UI should later provide a run-scoped revert workflow.

Generated `.vibecode/` artifacts are not committed.

## Terminal Send Direction

Initial implementation does not require terminal-mode detection.
VibecodeLight behaves like communication with a real terminal.
User remains responsible for active terminal state at send time.

## Success Criteria for Initial Implementation

- `flash_output.md` is produced with required stable headings.
- Optional `flash_output_meta.json` may be produced.
- Run layout includes `terminal/` for send/transcript and `after/` for post-run git/check artifacts.
- Current mirror includes only:
  - `run_manifest.json`
  - `context_pack.md`
  - `final_prompt.md`
  - `selected_skills.json`
  - `send_metadata.json` only after send
- Skills ownership and scanner write boundary are enforced.
- Every run generates a deterministic commit with validation status visible when checks fail.
