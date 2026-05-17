# Context Architecture

## Purpose

This document describes how VibecodeLight assembles deterministic context for a coding model run.
It aligns with the implementation contract in `docs/ARCHITECTURE_DECISIONS.md`.

## Ownership Model

TypeScript owns:
- `vibecode` CLI workflow orchestration
- Workspace initialization
- `config.yaml` management
- RunStore and `.vibecode` structure
- `.vibecode/current` mirror
- Skills loading and selection artifacts
- Flash invocation and output handling
- Context pack and final prompt assembly
- PTY and desktop integration

Python scanner owns:
- `vibecode-scan` internal CLI
- Deterministic repository scanning
- Scan artifact generation under authorized scan directory

Write boundary:
- RunStore creates and authorizes scan output directory.
- Python may write only inside that provided scan output directory.
- All non-scan `.vibecode` writes go through RunStore directly.

## Config Inputs

Human-maintained config:
- `config.yaml` in repository root.

Per-run scanner input:
- `.vibecode/runs/<run_id>/scanner_config.json`

Scanner config snapshot artifact:
- `.vibecode/runs/<run_id>/scan/config_snapshot.json`

## Deterministic Scan Outputs

Canonical deterministic outputs are in:
- `.vibecode/runs/<run_id>/scan/`

Preflight is a synonym for this deterministic scan phase.
There is no canonical `preflight.json` file in initial implementation.

## Skills Inputs and Outputs

Skills ownership is TypeScript-only at catalog level.

Inputs:
- User profile skills (primary source)
- Root `SKILLS/` project snapshot

TypeScript outputs:
- `.vibecode/runs/<run_id>/skills/skills_catalog.json`
- `.vibecode/runs/<run_id>/skills/selected_skills.json`
- `.vibecode/runs/<run_id>/skills/selected_skill_contents.md`

Python scanner behavior:
- May include `SKILLS/` in normal file/docs inventory.
- Must not build canonical skills catalog.
- Must not copy, sync, or manage skills.

## Flash Context Strategy

Initial flash output is Markdown-first.

Canonical output:
- `.vibecode/runs/<run_id>/flash/flash_output.md`

Required heading structure:
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

Future JSON extension (later):
- `.vibecode/runs/<run_id>/flash/flash_output.json`
- `.vibecode/runs/<run_id>/flash/flash_validation.json`

If JSON mode is introduced, it must be schema-validated before use.

## Canonical Run Layout

```text
.vibecode/runs/<run_id>/
  user_prompt.md
  run_manifest.json
  scanner_config.json

  scan/
    scan_manifest.json
    repo_tree.txt
    file_inventory.json
    git_status.json
    git_diff_stat.txt
    ignore_rules.json
    config_snapshot.json
    manifests.json
    environment.json
    commands.json
    repo_instructions.json
    docs.json
    architecture_docs.json
    symbols.json
    imports.json
    entrypoints.json
    tests.json
    tooling.json
    schemas.json
    keyword_hits.json
    recent_history.json
    previous_run_summary.json
    terminal_context.json

  skills/
    skills_catalog.json
    selected_skills.json
    selected_skill_contents.md

  flash/
    flash_input_manifest.json
    flash_input.md
    flash_output.md
    flash_output_meta.json
    tool_calls.json

  output/
    context_pack.md
    final_prompt.md

  terminal/
    send_metadata.json
    terminal_excerpt_after.md
    terminal_transcript.md

  after/
    git_status_after.json
    changed_files_after.json
    checks_summary.md
```

## Current Mirror

`.vibecode/current/` is convenience only.
Historical truth is always `.vibecode/runs/<run_id>/`.

Canonical current files:
- `run_manifest.json`
- `context_pack.md`
- `final_prompt.md`
- `selected_skills.json`
- `send_metadata.json` (only after send)

## CLI Surfaces in Context Flow

Public/stable:
- `vibecode init`
- `vibecode scan "task"`
- `vibecode prompt "task"`
- `vibecode runs list`
- `vibecode runs show latest`
- `vibecode skills list`
- `vibecode skills copy <skill-id>`

Debug/internal:
- `vibecode doctor`
- `vibecode run create "task"`
- `vibecode context-build "task"`
- `vibecode flash validate <path>`
- `vibecode flash run latest`
- `vibecode terminal demo`

Scanner/internal:
- `vibecode-scan --help`
- `vibecode-scan --repo . --task "task"`
- `python -m vibecode_scanner --repo . --task "task"`

## Validation and Commits

Expected validation commands:
- TypeScript: `pnpm test`, `pnpm test:live`, `pnpm lint`, `pnpm typecheck`, `pnpm build`
- Python: `cd src/core/scanning/python`, `uv run pytest`, `uv run pytest -m live`, `uv run ruff check .`

Run-level commit policy:
- Every model run should create a deterministic commit.
- Failed validation state must be visible if tests fail.
- Generated `.vibecode/` artifacts are not committed.

## Terminal Send Safety

Initial implementation does not require terminal-mode detection.
VibecodeLight sends as if communicating with a normal terminal.
User is responsible for current terminal state.

## Secret Handling

Initial VibecodeLight does not perform aggressive secret redaction or fixed filename censorship.
It respects ignore rules.
Users are responsible for keeping secrets out of non-ignored repository content.
Provider secrets must live outside committed project files.
