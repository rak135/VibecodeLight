# VibecodeLight

VibecodeLight is a local-first coding assistant workflow that builds deterministic run artifacts and a prompt package for a coding model.

This repository currently defines architecture and implementation contracts only.
Application scaffolding and runtime implementation are intentionally out of scope for this baseline.

## Document Authority

Implementation decision authority:
1. `docs/ARCHITECTURE_DECISIONS.md` is the implementation contract and source of truth for concrete implementation decisions.
2. `AGENTS.md` is the operational working guide for agents.
3. If operational guidance and implementation detail conflict, `docs/ARCHITECTURE_DECISIONS.md` wins.

Recommended reading order:
1. `AGENTS.md`
2. `docs/ARCHITECTURE_DECISIONS.md`
3. `docs/IMPLEMENTATION_MAP.md`
4. `docs/ARCHITECTURE.md`
5. `docs/CONTEXT.md`
6. `docs/VISION.md`

## Canonical Project Layout

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

Canonical Python scanner layout:

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

## Ownership Boundaries

TypeScript owns:
- Main CLI command `vibecode`
- Workflow orchestration
- Workspace initialization
- `config.yaml`
- Run store
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

Python scanner write boundary:
- RunStore creates and authorizes the scan output directory.
- Python may write only inside that provided scan output directory.
- All non-scan `.vibecode` writes go through RunStore directly.

## Skills Policy

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

## CLI Surfaces

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

## Flash Output Strategy

Initial implementation is Markdown-first.

Canonical initial flash artifact:
- `.vibecode/runs/<run_id>/flash/flash_output.md`

Required stable sections in `flash_output.md`:
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

If JSON flash output is added later, it must be schema-validated before use.

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

Notes:
- `terminal/` stores terminal send/transcript artifacts.
- `after/` stores post-run git/check artifacts.
- `terminal_transcript.md` is optional/configurable.
- `checks_summary.md` may be initially empty until captured checks are implemented.

## Current Mirror

`.vibecode/current/` is a convenience mirror/pointer only.
Historical truth is always `.vibecode/runs/<run_id>/`.

Canonical files under `.vibecode/current/`:
- `run_manifest.json`
- `context_pack.md`
- `final_prompt.md`
- `selected_skills.json`
- `send_metadata.json` (only after send)

## Preflight Naming

Preflight is a product-level synonym for the deterministic scan phase.
There is no canonical `preflight.json` in the initial implementation.
Canonical preflight outputs live under `scan/`.

## Config Baseline

- Root human-maintained project config: `config.yaml`.
- Scanner input per run: `.vibecode/runs/<run_id>/scanner_config.json`.
- Scanner snapshot artifact: `.vibecode/runs/<run_id>/scan/config_snapshot.json`.

`.vibecode/config.json` is not part of this contract.

## Secret Handling

Initial VibecodeLight does not perform aggressive secret redaction or fixed filename censorship.
It respects ignore rules.
Users are responsible for keeping secrets out of non-ignored repository content.
Provider secrets must live outside committed project files.

## Commit Policy

Each model run is expected to create a deterministic git commit that captures the run result.
If tests fail, the run and commit must clearly mark the failed validation state.
UI and CLI should later provide a way to revert changes from a run.

Agent commit discipline:
- Keep commits scoped.
- Do not include unrelated changes.
- Do not push or open PR unless explicitly asked.
- Generated `.vibecode/` artifacts are not committed.

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

Live model tests are explicit, token-efficient, and not part of default test runs.

## Terminal Send Safety

Initial implementation does not try to detect terminal mode (shell, Hermes, OpenCode, Codex, or other interactive tools).
VibecodeLight behaves like communication with a real terminal.
The user remains responsible for active terminal state when sending prompts.
