# AGENTS

Operational guide for contributors and coding agents working in VibecodeLight.

## Authority and Reading Order

Reading order for execution work:
1. This file (`AGENTS.md`) for operations.
2. `docs/ARCHITECTURE_DECISIONS.md` for implementation decisions.
3. `docs/IMPLEMENTATION_MAP.md` for checkpoint sequence.
4. `docs/ARCHITECTURE.md` for module boundaries.
5. `docs/CONTEXT.md` for context architecture.
6. `docs/VISION.md` for product direction.

Authority rule:
- `docs/ARCHITECTURE_DECISIONS.md` is the implementation contract and source of truth for concrete implementation decisions.
- `AGENTS.md` is the operational guide.
- If they conflict on implementation details, `docs/ARCHITECTURE_DECISIONS.md` wins.

## Scope of This Baseline

Current task baseline is documentation consistency and repository baseline.
Do not scaffold application/runtime implementation in this phase.

## Canonical Repository Structure

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

Python scanner structure:

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

## Ownership Contract

TypeScript owns:
- Public `vibecode` CLI.
- Workflow orchestration.
- Workspace initialization.
- `config.yaml`.
- RunStore and `.vibecode` layout.
- `.vibecode/current` mirror.
- Skills catalog/copy/selection loading.
- LLM adapters and flash tools.
- Context and prompt assembly.
- PTY integration and desktop shell.
- JSON schema validation boundary.

Python owns:
- Internal `vibecode-scan` CLI.
- Deterministic repository scanning.
- Tree/inventory/manifest/docs/commands extraction.
- Symbols/imports/entrypoints/tests/tooling/schema/keyword/history extraction.
- Scan artifact generation only.

Write-boundary rule:
- RunStore creates and authorizes the scan output directory.
- Python may write only inside that provided scan output directory.
- All non-scan `.vibecode` writes go through RunStore directly.

## Skills Contract

- TypeScript owns the skills system.
- Primary skills are in user profile.
- Project snapshot skills are in root `SKILLS/`.
- `.vibecode/` does not store source skills.
- Copying is explicit and snapshot-based.
- No automatic sync and no silent overwrite.

TypeScript writes:
- `.vibecode/runs/<run_id>/skills/skills_catalog.json`
- `.vibecode/runs/<run_id>/skills/selected_skills.json`
- `.vibecode/runs/<run_id>/skills/selected_skill_contents.md`

Python scanner:
- May include `SKILLS/` in ordinary scan inventory/docs.
- Must not own canonical skills catalog creation.
- Must not copy/sync/manage skills.

## CLI Surface Contract

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

## Run Artifact Contract

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

Artifact notes:
- `flash_output.md` is canonical for initial implementation.
- `flash_output_meta.json` is optional.
- `flash_output.json` and `flash_validation.json` are later extension artifacts and require schema validation before use.
- `terminal/` stores terminal send/transcript artifacts.
- `after/` stores post-run git/check artifacts.
- `terminal_transcript.md` is optional/configurable.
- `checks_summary.md` may initially be empty.

## Current Mirror Contract

`.vibecode/current/` is a convenience mirror and pointer, not history.
History is always `.vibecode/runs/<run_id>/`.

Canonical current files:
- `run_manifest.json`
- `context_pack.md`
- `final_prompt.md`
- `selected_skills.json`
- `send_metadata.json` (only after send)

## Config Contract

- Human-maintained project config is root `config.yaml`.
- Per-run scanner input: `.vibecode/runs/<run_id>/scanner_config.json`.
- Scanner config snapshot: `.vibecode/runs/<run_id>/scan/config_snapshot.json`.
- `.vibecode/config.json` is not part of this implementation contract.

## Preflight Terminology

Preflight is a product-level synonym for deterministic scan.
No canonical `preflight.json` exists in the initial implementation.
Canonical deterministic outputs are under `scan/`.

## Commit and Safety Policy

Every model run should create a deterministic git commit that captures run result.
If validation fails, failed validation state must be visible in run metadata and commit/report.
UI/CLI should later provide revert by run.

Agent discipline:
- Keep commits scoped.
- Never include unrelated changes.
- Never push or open PR unless explicitly asked.
- Never commit generated `.vibecode/` artifacts.

## Secrets Policy

Initial VibecodeLight does not perform aggressive secret redaction or fixed filename censorship.
It respects ignore rules.
Users are responsible for secrets in non-ignored files.
Provider secrets must remain outside committed project files.

## Standard Test Commands

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

Live tests are explicit, token-efficient, and not part of default runs.

## Terminal Send Policy

Initial implementation does not require terminal-mode detection.
No required target-kind detection gate for initial behavior.
VibecodeLight sends as if communicating with a real terminal.
User is responsible for active terminal context.
