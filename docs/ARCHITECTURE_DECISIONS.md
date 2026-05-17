# Architecture Decisions

This document is the implementation contract and source of truth for concrete implementation decisions.
If another document conflicts on implementation details, this document wins.

## Decision 1: Document Authority Contract

- `docs/ARCHITECTURE_DECISIONS.md` is the implementation contract.
- `AGENTS.md` is the operational guide for day-to-day execution.
- `docs/IMPLEMENTATION_MAP.md` defines checkpoint order.
- `docs/ARCHITECTURE.md` defines boundaries.
- `docs/CONTEXT.md` defines context architecture.
- `docs/VISION.md` defines direction.

## Decision 2: Canonical Repository Layout

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

## Decision 3: Canonical Python Scanner Layout

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

## Decision 4: TypeScript and Python Ownership

TypeScript owns:
- Main CLI command `vibecode`
- Workflow orchestration
- Workspace initialization
- `config.yaml`
- RunStore
- `.vibecode/` layout and `.vibecode/current`
- Skills catalog/copy/selection loading
- LLM provider adapters
- Flash tools
- Context assembly
- Prompt rendering
- PTY/terminal integration
- Desktop shell
- JSON schema validation boundary

Python owns:
- Internal scanner CLI `vibecode-scan`
- Deterministic repository scanning
- Repo tree generation
- File inventory
- Manifest parsing
- Command discovery
- Docs discovery
- Regex-based symbol extraction
- Import extraction
- Entrypoint detection
- Test inventory
- Keyword hits
- Scan artifact generation

Write-boundary formulation:
- RunStore creates and authorizes the scan output directory.
- Python may write only inside that provided scan output directory.
- All non-scan `.vibecode` writes go through RunStore directly.

## Decision 5: Skills Ownership

- TypeScript owns the skills system.
- Primary skills live in user profile.
- Project skills snapshot lives in root `SKILLS/`.
- `.vibecode/` never stores source skills.
- Copying skills is explicit and snapshot-based.
- No automatic sync.
- No silent overwrite.

TypeScript writes:
- `.vibecode/runs/<run_id>/skills/skills_catalog.json`
- `.vibecode/runs/<run_id>/skills/selected_skills.json`
- `.vibecode/runs/<run_id>/skills/selected_skill_contents.md`

Python scanner:
- May see `SKILLS/` as ordinary repository files for tree/inventory/docs.
- Must not build the canonical skills catalog.
- Must not copy, sync, or manage skills.

## Decision 6: CLI Surface Split

Public/stable CLI:
- `vibecode init`
- `vibecode scan "task"`
- `vibecode prompt "task"`
- `vibecode runs list`
- `vibecode runs show latest`
- `vibecode skills list`
- `vibecode skills copy <skill-id>`

Debug/internal CLI:
- `vibecode doctor`
- `vibecode run create "task"`
- `vibecode context-build "task"`
- `vibecode flash validate <path>`
- `vibecode flash run latest`
- `vibecode terminal demo`

Internal scanner CLI:
- `vibecode-scan --help`
- `vibecode-scan --repo . --task "task"`
- `python -m vibecode_scanner --repo . --task "task"`

## Decision 7: Flash Output Strategy

Initial implementation is Markdown-first.

Canonical initial flash artifact:
- `.vibecode/runs/<run_id>/flash/flash_output.md`

Required structure:
- `# Task Summary`
- `# Relevant Files`
- `# Files To Read With Tools`
- `# Relevant Tests`
- `# Commands To Run`
- `# Selected Skills`
- `# Cautions`
- `# Context Pack`

Optional extracted metadata:
- `.vibecode/runs/<run_id>/flash/flash_output_meta.json`

Future structured JSON extension:
- `.vibecode/runs/<run_id>/flash/flash_output.json`
- `.vibecode/runs/<run_id>/flash/flash_validation.json`

If JSON mode is introduced later, it must be schema-validated before use.

## Decision 8: Canonical Run Artifact Layout

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
- `terminal/` contains terminal send/transcript artifacts.
- `after/` contains post-run git/check artifacts.
- `terminal_transcript.md` is optional/configurable.
- `checks_summary.md` may initially be empty/placeholder.

## Decision 9: Current Mirror

`.vibecode/current/` is convenience mirror/pointer only.
Historical truth is always `.vibecode/runs/<run_id>/`.

Canonical current files:
- `run_manifest.json`
- `context_pack.md`
- `final_prompt.md`
- `selected_skills.json`
- `send_metadata.json` only after send

Non-canonical current files are not required by this contract.

## Decision 10: Preflight Naming

- Preflight is product terminology for deterministic scan phase.
- No canonical `preflight.json` in initial implementation.
- Canonical artifacts for that phase are under `scan/`.

## Decision 11: Config Contract

- Root `config.yaml` is the only human-maintained project config.
- Per-run scanner input is `.vibecode/runs/<run_id>/scanner_config.json`.
- Scanner snapshot artifact is `.vibecode/runs/<run_id>/scan/config_snapshot.json`.
- `.vibecode/config.json` is not valid in this contract.

## Decision 12: Secrets Policy

Initial VibecodeLight does not perform aggressive secret redaction or fixed filename censorship.
It respects ignore rules.
Users are responsible for keeping secrets out of non-ignored repository content.
Provider secrets must live outside committed project files.

## Decision 13: Per-Run Commit Policy

Each model run is expected to create a deterministic git commit that captures run result.
If tests fail, run metadata and commit/report must clearly mark failed validation state.
UI/CLI should later provide run-level revert.

Agent commit discipline:
- Keep commits scoped.
- Do not include unrelated changes.
- Do not push or open PR unless explicitly asked.
- Generated `.vibecode/` artifacts are not committed.

## Decision 14: Standard Test Commands

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

Live tests are explicit and not part of default test flow.

## Decision 15: Terminal Send Safety

Initial implementation does not require terminal-mode detection.
VibecodeLight behaves like communication with a real terminal.
User remains responsible for active terminal state when sending prompt.

## Decision 16: Initial Success Criteria

Initial success requires:
- Markdown flash output at `.vibecode/runs/<run_id>/flash/flash_output.md`.
- Optional `.vibecode/runs/<run_id>/flash/flash_output_meta.json`.
- Full run layout with `terminal/` and `after/` usage as defined.
- Root `config.yaml`, per-run `scanner_config.json`, and scan `config_snapshot.json` naming consistency.
- TypeScript-owned skills catalog and selected skill outputs.
- Per-run deterministic commit with explicit failed-validation visibility when checks fail.
- `.vibecode/current/` limited to canonical current files.
