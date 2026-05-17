# Implementation Map

## Purpose

This map defines implementation checkpoint order for VibecodeLight.
It is aligned with `docs/ARCHITECTURE_DECISIONS.md` and should be used as execution sequence guidance.

## Authority

- `docs/ARCHITECTURE_DECISIONS.md` is source of truth for implementation decisions.
- This file defines practical checkpoint order.
- If implementation detail conflicts occur, decisions doc wins.

## Checkpoint Order

1. Contract baseline and deterministic run model
2. RunStore and canonical run artifact layout
3. Scanner subprocess integration with strict write boundary
4. Skills loading/catalog/selection (TypeScript-owned)
5. Context assembly and flash input generation
6. Flash Markdown output handling and optional metadata
7. Final prompt output and current mirror updates
8. Terminal send metadata/transcript handling
9. Post-run git/check capture
10. Validation and deterministic per-run commit flow

## Canonical Layouts to Implement

Repository implementation layout:

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

Python scanner layout:

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

## Ownership Checkpoints

TypeScript responsibilities to deliver:
- Public `vibecode` CLI and workflow orchestration.
- `config.yaml` handling.
- RunStore and `.vibecode` structure.
- Skills catalog and selected skills artifacts.
- Context and prompt generation.
- Flash invocation orchestration.
- Terminal integration and metadata capture.
- Validation boundary and run report creation.

Python scanner responsibilities to deliver:
- Deterministic scan extraction and artifacts.
- Internal `vibecode-scan` CLI.
- Read-only behavior for target repository.

Write boundary checkpoint (must be explicit in implementation):
- RunStore creates and authorizes the scan output directory.
- Python may write only inside that provided scan output directory.
- All non-scan `.vibecode` writes go through RunStore directly.

## Skills Checkpoint

TypeScript-owned outputs:
- `.vibecode/runs/<run_id>/skills/skills_catalog.json`
- `.vibecode/runs/<run_id>/skills/selected_skills.json`
- `.vibecode/runs/<run_id>/skills/selected_skill_contents.md`

Rules:
- Primary skills in user profile.
- Project snapshot in `SKILLS/`.
- No source skills persisted under `.vibecode/`.
- Copying is explicit, snapshot-based, no auto sync, no silent overwrite.

## CLI Surfaces

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

## Run Artifact Layout Checkpoint

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

Rules:
- `terminal/` stores terminal send/transcript artifacts.
- `after/` stores post-run git/check artifacts.
- `terminal_transcript.md` optional/configurable.
- `checks_summary.md` may initially be placeholder/empty.

## Current Mirror Checkpoint

`.vibecode/current/` is convenience mirror only.
History lives under `.vibecode/runs/<run_id>/`.

Canonical current files:
- `run_manifest.json`
- `context_pack.md`
- `final_prompt.md`
- `selected_skills.json`
- `send_metadata.json` (only after send)

## Flash Strategy Checkpoint

Initial implementation must work with:
- `.vibecode/runs/<run_id>/flash/flash_output.md`

Required sections in order:
- `# Task Summary`
- `# Relevant Files`
- `# Files To Read With Tools`
- `# Relevant Tests`
- `# Commands To Run`
- `# Selected Skills`
- `# Cautions`
- `# Context Pack`

Optional:
- `.vibecode/runs/<run_id>/flash/flash_output_meta.json`

Future extension:
- `.vibecode/runs/<run_id>/flash/flash_output.json`
- `.vibecode/runs/<run_id>/flash/flash_validation.json`

Future JSON mode requires schema validation before use.

## Preflight and Terminal Policy Checkpoints

- Preflight is a synonym for deterministic scan phase.
- No canonical `preflight.json` in initial implementation.
- Initial implementation does not require terminal-mode detection.
- User remains responsible for active terminal target state.

## Validation and Commit Policy Checkpoints

Validation command baseline:
- TypeScript: `pnpm test`, `pnpm test:live`, `pnpm lint`, `pnpm typecheck`, `pnpm build`
- Python: `cd src/core/scanning/python`, `uv run pytest`, `uv run pytest -m live`, `uv run ruff check .`

Commit policy baseline:
- Every model run should create a deterministic commit.
- Failed validation state must be visible when checks fail.
- `.vibecode/` generated artifacts are not committed.
- Commits must remain scoped and exclude unrelated changes.
