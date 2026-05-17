# Architecture

## Purpose

This document defines module boundaries for VibecodeLight and aligns to the implementation contract in `docs/ARCHITECTURE_DECISIONS.md`.

## Authority

- `docs/ARCHITECTURE_DECISIONS.md` is source of truth for concrete implementation decisions.
- This architecture document explains boundaries and composition.
- If detail conflicts occur, `docs/ARCHITECTURE_DECISIONS.md` wins.

## Canonical Repository Layout

```text
vibecode-light/
  src/
    app/
      desktop/
      cli/

    core/
      models/
      workspace/
      runs/
      scanning/
      skills/
      context/
      prompting/
      terminal/
      validation/

    adapters/
      fs/
      git/
      pty/
      llm/
      env/

  docs/
    VISION.md
    CONTEXT.md
    ARCHITECTURE.md
    IMPLEMENTATION_MAP.md
    ARCHITECTURE_DECISIONS.md

  schemas/

  tests/
    core/
    adapters/
    integration/
```

## Canonical Scanner Layout

```text
src/core/scanning/
  scanner_subprocess.ts
  scanner_config.ts
  python/
    pyproject.toml
    vibecode_scanner/
      __init__.py
      cli.py
      scan/
        git_scan.py
        tree_scan.py
        inventory_scan.py
        manifest_scan.py
        command_scan.py
        docs_scan.py
        symbol_scan.py
        import_scan.py
        entrypoint_scan.py
        test_scan.py
        tooling_scan.py
        schema_scan.py
        keyword_scan.py
        history_scan.py
```

## Component Boundaries

### app/

`src/app/cli/`:
- user-facing CLI command dispatch
- public and debug command wiring

`src/app/desktop/`:
- desktop shell/UI adapter behavior
- command invocation and status presentation

### core/

`src/core/models/`:
- run, artifact, and validation models

`src/core/workspace/`:
- workspace probing and deterministic paths

`src/core/runs/`:
- run creation, manifests, and RunStore
- `.vibecode/runs/<run_id>/` lifecycle
- `.vibecode/current/` mirror updates

`src/core/scanning/`:
- scanner config generation
- subprocess coordination with Python scanner

`src/core/skills/`:
- user profile skill loading
- project `SKILLS/` snapshot loading
- canonical catalog generation and selected skill outputs

`src/core/context/`:
- deterministic context assembly from scan and skills outputs

`src/core/prompting/`:
- flash input assembly, output parsing, final prompt assembly

`src/core/terminal/`:
- terminal send metadata and transcript handling

`src/core/validation/`:
- schema checks and run validation summaries

### adapters/

`src/adapters/fs/`:
- filesystem abstraction

`src/adapters/git/`:
- git status/check metadata capture

`src/adapters/pty/`:
- terminal process interactions

`src/adapters/llm/`:
- flash provider and model invocation adapters

`src/adapters/env/`:
- environment and config access wrappers

## Ownership Rules

TypeScript owns:
- `vibecode` CLI
- orchestration pipeline
- `config.yaml`
- RunStore and all non-scan `.vibecode` writes
- skills catalog and selection outputs
- context assembly and prompt rendering
- terminal integration and desktop shell
- schema validation boundary

Python owns:
- `vibecode-scan` internal CLI
- deterministic repository scan extraction
- scan artifact generation only

Write-boundary rule:
- RunStore creates and authorizes the scan output directory.
- Python may write only inside that provided scan output directory.
- All non-scan `.vibecode` writes go through RunStore directly.

## CLI Surface Boundaries

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

Internal scanner:
- `vibecode-scan --help`
- `vibecode-scan --repo . --task "task"`
- `python -m vibecode_scanner --repo . --task "task"`

## Artifact Topology

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

`terminal_transcript.md` is optional/configurable.
`checks_summary.md` may be empty in early implementation.

## Current Mirror

`.vibecode/current/` is convenience only.
Canonical current files:
- `run_manifest.json`
- `context_pack.md`
- `final_prompt.md`
- `selected_skills.json`
- `send_metadata.json` (only after send)

## Flash Contract

Initial implementation is Markdown-first:
- `.vibecode/runs/<run_id>/flash/flash_output.md`

Required sections:
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

Future JSON extension:
- `.vibecode/runs/<run_id>/flash/flash_output.json`
- `.vibecode/runs/<run_id>/flash/flash_validation.json`

Future JSON mode must be schema-validated before use.

## Preflight Naming

Preflight means deterministic scan phase.
There is no canonical `preflight.json` in initial implementation.
Artifacts are in `scan/`.

## Terminal Policy

Initial behavior does not require terminal-mode detection.
User is responsible for active terminal state at send time.

## Validation and Test Commands

TypeScript:
- `pnpm test`
- `pnpm test:live`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`

Python:
- `cd src/core/scanning/python`
- `uv run pytest`
- `uv run pytest -m live`
- `uv run ruff check .`

## Commit and Secrets Policy

Every model run should create a deterministic git commit.
If tests fail, failed validation state must be visible.
Generated `.vibecode/` artifacts are not committed.

Initial implementation does not provide aggressive secret redaction/censorship.
It respects ignore rules; users are responsible for non-ignored content.
