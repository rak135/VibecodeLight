# ARCHITECTURE_DECISIONS.md

This document is the concrete implementation contract for VibecodeLight.

It defines the practical decisions needed before and during implementation:

- repository stack,
- TypeScript/Python ownership,
- CLI boundaries,
- scanner subprocess behavior,
- configuration ownership,
- artifact layout,
- Markdown-first flash output,
- schema strategy,
- package managers,
- test runners,
- live model test mode,
- terminal artifact layout,
- per-run commit policy,
- and the first implementation checkpoints.

If another document conflicts with this file on implementation details, this file wins.

---

# Document Authority

Use the documents in this order:

```text
1. AGENTS.md — operational guide
2. ARCHITECTURE_DECISIONS.md — implementation decisions, wins on conflicts
3. IMPLEMENTATION_MAP.md — checkpoint order
4. ARCHITECTURE.md — module boundaries
5. CONTEXT.md — context architecture
6. VISION.md — product direction
```

`AGENTS.md` tells agents how to work.

`ARCHITECTURE_DECISIONS.md` defines what must be built.

If `AGENTS.md` and `ARCHITECTURE_DECISIONS.md` conflict on concrete implementation details, `ARCHITECTURE_DECISIONS.md` wins.

If an implementation task exposes a contradiction between documents, the agent must report it clearly instead of silently choosing a side.

---

# Core Decision

VibecodeLight is built as:

```text
Electron / TypeScript shell
+ TypeScript orchestration/core
+ Python deterministic scanner subprocess
+ JSON/Markdown artifacts in .vibecode/
+ real PTY terminal
+ CLI-first debug path
```

The core split is:

```text
TypeScript owns workflow orchestration.
Python owns deterministic repository scanning.
```

Python does not own application state.  
Python does not own prompt rendering.  
Python does not own the LLM provider.  
Python does not own skills.  
Python does not own `.vibecode/current`.  
Python does not create commits.

---

# Repository Structure

Canonical repository structure:

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

Python scanner code lives under the scanning boundary, not as a separate competing application.

Canonical Python scanner layout:

```text
src/core/scanning/
  index.ts
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

Do not introduce a second Python architecture elsewhere.

---

# Stack Decisions

## TypeScript / Electron side

Use:

```text
pnpm
TypeScript
Vitest
ESLint
Prettier
Electron
electron-vite
```

TypeScript owns:

```text
main CLI command
workspace initialization
run store
config loading/writing
scanner subprocess orchestration
skills catalog/copy/selection loading
LLM provider adapters
flash tools
context assembly
prompt rendering
PTY terminal integration
desktop shell
JSON schema validation boundary
per-run commit workflow orchestration
```

## Python scanner side

Use:

```text
uv
pytest
ruff
pydantic
typer
```

Python owns:

```text
deterministic repo scan logic
file inventory
repo tree generation
manifest parsing
command discovery
docs discovery
regex-based symbol extraction
import extraction
entrypoint detection
test inventory
keyword hits
scan artifact generation
```

Python scanner is read-only against the target repository.

Python scanner may write only to scanner output destinations explicitly provided by TypeScript, normally:

```text
.vibecode/runs/<run_id>/scan/
```

---

# CLI Ownership

There are two CLI surfaces.

## Main CLI: `vibecode`

Owned by TypeScript.

Purpose:

```text
human-facing CLI
agent-facing CLI
workflow orchestration
debugging
reproducible command execution
```

Public/stable CLI:

```powershell
vibecode init
vibecode scan "task"
vibecode prompt "task"
vibecode runs list
vibecode runs show latest
vibecode skills list
vibecode skills copy <skill-id>
```

Debug/internal CLI:

```powershell
vibecode doctor
vibecode run create "task"
vibecode context-build "task"
vibecode flash validate <path>
vibecode flash run latest
vibecode terminal demo
```

`vibecode run create` is debug/internal and exists to test run store behavior.

Agent-facing commands should support machine-readable output where relevant:

```powershell
vibecode init --json
vibecode scan "task" --json
vibecode prompt "task" --json
vibecode runs show latest --json
vibecode skills list --json
```

## Internal scanner CLI: `vibecode-scan`

Owned by Python.

Purpose:

```text
internal deterministic scanner subprocess
debuggable standalone scanner
artifact generator for scan outputs
```

It should be callable as:

```powershell
vibecode-scan --repo . --task "task"
```

and also as:

```powershell
python -m vibecode_scanner --repo . --task "task"
```

The `vibecode-scan` command is a wrapper around `python -m vibecode_scanner`.

---

# Scanner Subprocess Contract

The scanner subprocess supports both stdout output and file output.

## Default behavior

By default, the scanner writes a structured scan summary to stdout:

```powershell
vibecode-scan --repo . --task "add context pack"
```

Stdout must be valid JSON unless a human-readable mode is explicitly requested.

## Artifact mode

When TypeScript orchestrates a real VibecodeLight run, it passes an output directory:

```powershell
vibecode-scan `
  --repo C:\DATA\PROJECTS\SomeRepo `
  --task "add context pack" `
  --scanner-config .vibecode/runs/<run_id>/scanner_config.json `
  --out .vibecode/runs/<run_id>/scan `
  --json
```

In artifact mode, Python writes many small files under `scan/` and still emits a short JSON summary to stdout.

The stdout summary should include:

```json
{
  "ok": true,
  "scan_dir": ".vibecode/runs/<run_id>/scan",
  "artifacts": [
    "scan_manifest.json",
    "repo_tree.txt",
    "file_inventory.json"
  ],
  "warnings": []
}
```

## Why both stdout and files?

Stdout is useful for agents, shells, and quick debugging.

File artifacts are better for real VibecodeLight runs because:

```text
large scan output stays inspectable
each artifact can be checked independently
failures are easier to locate
flash input can reference stable files
runs are reproducible
```

---

# Run Ownership

TypeScript owns the run lifecycle.

TypeScript creates:

```text
.vibecode/
.vibecode/runs/
.vibecode/current/
.vibecode/runs/<run_id>/
```

TypeScript owns:

```text
run_id creation
run folder layout
run_manifest.json
user_prompt.md
scanner_config.json
.vibecode/current updates
previous run summary
flash input/output storage
context pack storage
selected skill storage
final prompt rendering
terminal artifact storage
post-run artifact storage
per-run commit orchestration
```

Python owns only scan artifacts inside:

```text
.vibecode/runs/<run_id>/scan/
```

Python must not update:

```text
.vibecode/current/
config.yaml
.gitignore
SKILLS/
run_manifest.json
final_prompt.md
context_pack.md
selected_skills.json
flash_output.md
send_metadata.json
after/
terminal/
```

---

# `.vibecode/` Ownership

`.vibecode/` is generated working state.

It must be ignored by git.

During initialization, TypeScript inserts:

```text
.vibecode/
```

into `.gitignore` and reports that it did so.

`.vibecode/` contains run artifacts, current pointers, scan outputs, flash inputs/outputs, prompt outputs, send metadata, post-run metadata, and terminal transcripts.

`.vibecode/` is never scanned as part of the target repository.

`.vibecode/` is not where project skills live.

Generated `.vibecode/` artifacts are not committed.

---

# `config.yaml` Ownership

TypeScript owns `config.yaml`.

> Update: human-maintained provider configuration now uses a global user
> directory (`%LOCALAPPDATA%\vibecodelight\config.yaml` plus a sibling `.env` for
> secrets) and a per-repository local workspace config at
> `<repo>\.vibecode\config.yaml`. The local config takes priority over the
> global config; sync between them is explicit. A single TypeScript-owned core
> config service (`src/core/config`) performs resolution for both the CLI and the
> desktop. This supersedes the earlier rule that the repository-root
> `config.yaml` was treated as the sole human-maintained config; the root `config.yaml`
> remains for project/scanner defaults. API keys live only in the AppData `.env`
> and are never written to committed files, artifacts, or logs. The Python
> scanner never reads the global or local YAML config directly.
>
> Update 2: flash provider configuration is a **provider/model registry**, not
> single fields. `config.yaml` (global and local) holds `providers.<id>`
> (`type`, `label`, `base_url`, `api_key_env`, `models[]`) and `defaults.flash`
> (`provider`, `model`, `timeout_ms`, `max_tokens`, `temperature`). This replaces
> the old `models.flash_provider` / `flash_model` / `flash_base_url` fields (kept
> only as a deprecated legacy bridge with a warning). The active flash
> provider/model resolves as CLI flags (`--flash-provider`/`--flash-model`) →
> local registry → global registry. `api_key_env` is a non-secret env-variable
> NAME; the key value lives only in `.env` and is recorded in artifacts as a
> source string (e.g. `global-env:OPENROUTER_API_KEY`), never the value. Sync
> copies the `config.yaml` registry shape only; `.env` is never synced into
> `.vibecode`. Errors: `CONFIG_PROVIDER_NOT_FOUND`, `CONFIG_MODEL_NOT_FOUND`,
> `PROVIDER_API_KEY_ENV_MISSING`, `FLASH_PROVIDER_AUTH_MISSING`,
> `FLASH_PROVIDER_NOT_CONFIGURED`, `FLASH_MODEL_NOT_CONFIGURED`,
> `CONFIG_INVALID_PROVIDER_REGISTRY`.
>
> Update 3: Desktop GUI remembered pipeline toggles use the global user config
> `desktop.*` namespace: `desktop.codegraph.mode`,
> `desktop.task_normalizer.enabled`, and `desktop.auto_approve.enabled`. These
> values initialize Desktop GUI controls only and do not become CLI/global
> defaults. The CLI still requires explicit per-run flags for CodeGraph mode,
> Task Normalizer, and safety-sensitive auto-approve; `desktop.auto_approve.enabled`
> only remembers the Desktop toggle and does not make CLI prompt auto-approve.
> Actual terminal sends record `auto_approve` in send metadata as a per-send
> value. Renderer localStorage is not a source of truth for these pipeline-affecting
> remembered settings. The deliberate exception is CodeGraph Transport:
> `defaults.codegraph.transport` remains shared by the GUI and CLI command
> (`vibecode codegraph transport get|set|reset`).

Human-maintained config is layered: `%LOCALAPPDATA%\vibecodelight\config.yaml` for global provider/default settings, `<repo>\.vibecode\config.yaml` for per-repo overrides, and repository-root `config.yaml` for project/scanner defaults. Local workspace config takes priority over the global user config.

TypeScript:

```text
creates config.yaml if missing
preserves existing config.yaml
validates config.yaml
loads config.yaml
resolves config into runtime settings
creates scanner_config.json for Python
```

Python scanner does not read `config.yaml` directly.

Instead, TypeScript writes:

```text
.vibecode/runs/<run_id>/scanner_config.json
```

and passes it to Python:

```powershell
vibecode-scan --scanner-config .vibecode/runs/<run_id>/scanner_config.json
```

The scanner writes the resolved scan snapshot to:

```text
.vibecode/runs/<run_id>/scan/config_snapshot.json
```

Do not use:

```text
.vibecode/config.json
scan/config.json
```

This prevents TypeScript and Python from developing two different interpretations of project configuration.

---

# Scanner Config Contract

`scanner_config.json` is generated by TypeScript for each run.

It contains the scanner-specific resolved configuration only.

Example shape:

```json
{
  "repo_root": "C:/DATA/PROJECTS/SomeRepo",
  "task": "add context pack",
  "ignore": {
    "always_exclude": [".git/", ".vibecode/"],
    "respect_gitignore": true
  },
  "scan": {
    "include_full_tree": true,
    "include_docs_full": true,
    "include_git_diff_stat": true,
    "include_full_diff": false
  },
  "paths": {
    "scan_out": ".vibecode/runs/<run_id>/scan"
  }
}
```

Python treats this file as input configuration for the scan only.

Python writes the scan-side snapshot as:

```text
scan/config_snapshot.json
```

---

# Skills Ownership

TypeScript owns the skills system.

## Primary skills store

Skills live primarily in the user profile.

Example:

```text
%APPDATA%/VibecodeLight/skills/
  default/
    test-driven-development/
      SKILL.md
      skill.yaml
  user/
    my-custom-skill/
      SKILL.md
      skill.yaml
```

## Project skills snapshot

When explicitly requested, TypeScript copies skills into the project:

```text
SKILLS/
  test-driven-development/
    SKILL.md
    skill.yaml
```

The `SKILLS/` directory is outside `.vibecode/`.

Copying skills is a snapshot operation.

No automatic sync.  
No silent overwrite.  
No background update.

`SKILLS/` commit behavior is configurable in `config.yaml`.

## Python scanner and skills

Python may include `SKILLS/` in:

```text
repo_tree.txt
file_inventory.json
docs scan if relevant
```

But Python does not manage skills.

Python does not build the canonical skills catalog.

TypeScript builds:

```text
.vibecode/runs/<run_id>/skills/skills_catalog.json
```

Flash model receives skill metadata from `skills_catalog.json`.

After flash selects skills, TypeScript loads selected full skill content and writes:

```text
.vibecode/runs/<run_id>/skills/selected_skills.json
.vibecode/runs/<run_id>/skills/selected_skill_contents.md
```

---

# LLM / Flash Model Ownership

TypeScript owns the LLM provider layer.

The flash model belongs to orchestration, not scanning.

TypeScript owns:

```text
LLM provider config
provider adapters
flash model invocation
flash input construction
flash output storage
Markdown flash output parsing
future JSON flash output validation if added
read-only flash tools
live model test mode
```

Python scanner must not call LLM providers.

---

# Flash Tools

Flash model may use read-only tools.

Initial tools:

```text
read_file(path)
list_dir(path)
read_artifact(name)
search_text(query)
```

TypeScript owns the tool dispatcher.

The tools are read-only.

They may read:

```text
target repo files allowed by scanner/tool policy
run artifacts
scan artifacts
skills metadata/content selected for the run
```

They may not write:

```text
repo files
.vibecode artifacts
SKILLS/
config.yaml
```

All flash tool calls must be logged.

Recommended log artifact:

```text
.vibecode/runs/<run_id>/flash/tool_calls.json
```

Later optimization may allow Python to provide search/read backends, but the TypeScript tool dispatcher remains the owner of tool authorization and logging.

---

# Context Pack and Final Prompt

The boundary is fixed:

```text
context_pack.md = flash model output / flash-compressed task context
final_prompt.md = deterministically rendered prompt that goes to the terminal
```

TypeScript renderer owns `final_prompt.md`.

The renderer combines:

```text
user_prompt.md
context_pack.md
selected_skill_contents.md
commands_to_run
cautions
tool/file-reading instructions for the main model
```

`final_prompt.md` is the truth.

What is in `final_prompt.md` is what gets sent to the terminal.

No hidden prompt text is added after preview.

---

# Flash Output Format

The initial flash output is Markdown-first.

Primary initial artifact:

```text
.vibecode/runs/<run_id>/flash/flash_output.md
```

The Markdown output must use stable sections so it can be inspected and parsed:

```md
# Task Summary

# Relevant Files

# Files To Read With Tools

# Relevant Tests

# Commands To Run

# Selected Skills

# Cautions

# Context Pack
```

TypeScript may create extracted metadata when possible:

```text
.vibecode/runs/<run_id>/flash/flash_output_meta.json
```

The metadata file can contain:

```json
{
  "selected_skills": [],
  "relevant_files": [],
  "files_to_read_with_tools": [],
  "commands_to_run": [],
  "cautions": []
}
```

Future JSON mode remains open.

Future optional artifact:

```text
.vibecode/runs/<run_id>/flash/flash_output.json
```

When JSON mode is introduced, it must be schema-validated before use.

Invalid JSON flash output must produce a clear diagnostic showing where validation failed.

Markdown mode must not require `flash_output.json`.

---

# JSON Schema Strategy

Canonical schemas live in:

```text
schemas/
```

TypeScript and Python validate against JSON Schema files where practical.

Do not let TypeScript and Python maintain separate unsynchronized model definitions as the source of truth.

The implementation may have TypeScript types and Python Pydantic models, but JSON Schema files are the cross-language contract.

Required schemas:

```text
schemas/run_manifest.schema.json
schemas/scanner_config.schema.json
schemas/scan_manifest.schema.json
schemas/git_status.schema.json
schemas/file_inventory.schema.json
schemas/commands.schema.json
schemas/skills_catalog.schema.json
schemas/selected_skills.schema.json
schemas/send_metadata.schema.json
schemas/cli_response.schema.json
schemas/error.schema.json
```

Prepare for future:

```text
schemas/flash_output.schema.json
```

but the first flash implementation uses `flash_output.md` plus optional `flash_output_meta.json`.

## Schema Implementation Debt

**Status (as of commit 32bfb8f / HEAD):** `schemas/` and `src/core/validation/` are canonical placeholder directories. No `.schema.json` files have been written yet.

TypeScript types (`src/core/models/`) and Python Pydantic models (`vibecode_scanner/`) exist and serve as single-language contracts. The cross-language JSON Schema files listed above are **explicitly deferred** — they are not blocking the current implementation phase.

When schemas are implemented:
- TypeScript validation at `src/core/validation/` reads from `schemas/`.
- Python scanner validates its output with `pydantic` models that are kept in sync.
- A future checkpoint will add runtime schema validation and tests.

Do not delete `schemas/.gitkeep` or `src/core/validation/.gitkeep` — they mark canonical directories that will hold real content in a future checkpoint.

---

# Scan Artifact Layout

Scanner output should be many files, not one giant blob.

Expected scan layout:

```text
.vibecode/runs/<run_id>/scan/
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
```

`scan_manifest.json` records which artifacts were produced.

Example:

```json
{
  "ok": true,
  "scanner_version": "0.0.0",
  "repo_root": "C:/DATA/PROJECTS/SomeRepo",
  "artifacts": {
    "repo_tree": "repo_tree.txt",
    "file_inventory": "file_inventory.json",
    "git_status": "git_status.json",
    "config_snapshot": "config_snapshot.json"
  },
  "warnings": []
}
```

---

# Full Run Artifact Layout

A complete run should look like:

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
    terminal_transcript.md

  after/
    git_status_after.json
    changed_files_after.json
    checks_summary.md
```

`terminal_transcript.md` is optional according to config.

Full transcript is configurable.

`.vibecode/current/` contains copies or pointers to latest important artifacts:

```text
.vibecode/current/
  run_manifest.json
  context_pack.md
  final_prompt.md
  selected_skills.json
  send_metadata.json   # only after send
```

---

# CLI JSON Output

Agent-friendly CLI output is required.

Commands with `--json` use a consistent response envelope.

Success:

```json
{
  "ok": true,
  "data": {},
  "artifacts": [],
  "warnings": []
}
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "CONFIG_INVALID",
    "message": "config.yaml is invalid",
    "path": "config.yaml",
    "details": []
  }
}
```

Human-readable output may be used by default, but JSON mode must be stable for agents.

---

# Exit Codes

Use stable exit codes.

```text
0 success
1 validation or expected user error
2 internal application error
3 external tool or subprocess error
4 model/provider error
5 cancelled/interrupted
```

Examples:

```text
invalid config.yaml -> 1
scanner subprocess failed -> 3
flash provider authentication failed -> 4
uncaught internal exception -> 2
user cancelled send -> 5
```

---

# Validation and Diagnostics

Validation must produce structured diagnostics, not raw tracebacks.

A diagnostic should include:

```text
code
message
path if applicable
details if applicable
```

Example:

```json
{
  "code": "FLASH_OUTPUT_INVALID",
  "message": "Flash output is missing required section: Selected Skills",
  "path": ".vibecode/runs/2026-05-16_001/flash/flash_output.md",
  "details": [
    {
      "expected_section": "Selected Skills"
    }
  ]
}
```

This matters because both humans and LLM coding agents need repairable diagnostics.

---

# First Implementation Checkpoint

The first implementation checkpoint is:

```text
Repository baseline and documentation alignment
```

It includes:

```text
README.md
AGENTS.md
docs/VISION.md
docs/CONTEXT.md
docs/ARCHITECTURE.md
docs/IMPLEMENTATION_MAP.md
docs/ARCHITECTURE_DECISIONS.md
config.yaml
.gitignore
git initialization if needed
```

It does not include:

```text
package.json
TypeScript scaffold
Electron scaffold
Python package scaffold
source code
tests
.venv
.vibecode runtime artifacts
```

The first checkpoint must be commit-ready as a documentation/baseline checkpoint.

Commit message:

```text
docs: align VibecodeLight architecture contracts
```

---

# First Implementation Scaffold Checkpoint

The first code/scaffold checkpoint after documentation alignment is:

```text
Repository scaffold + workspace init + run store + CLI smoke + scanner CLI skeleton
```

It includes:

```text
repo skeleton
pnpm setup
uv setup for Python scanner
TypeScript CLI skeleton
Python scanner CLI skeleton
basic tests
config.yaml creation/preservation
.vibecode/ creation
.gitignore update with .vibecode/
minimal run store
vibecode --help
vibecode init
vibecode-scan --help
```

It does not need real scanner behavior yet.

It does not need real Electron UI behavior yet.

It may include an empty Electron shell scaffold, but real desktop behavior waits until the CLI/core path is working.

The first code checkpoint must be commit-ready without a functional desktop app.

---

# First Useful CLI Slice

The first useful slice after the skeleton should make this possible:

```powershell
vibecode prompt "test task"
```

and create a reproducible run folder containing at least:

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
    config_snapshot.json
  flash/
    flash_input.md
    flash_output.md
  output/
    final_prompt.md
```

The first useful slice may use mocked flash output for normal tests.

A live flash adapter should exist early enough to prove the direction, but live model calls are not part of default tests.

---

# Electron Timing

Electron shell is part of the chosen stack, but it must not drive the first implementation.

A minimal empty Electron scaffold may exist early.

Real desktop behavior should wait until the CLI/core path can:

```text
initialize workspace
create runs
scan repo
build flash input
produce final_prompt.md
show/debug run artifacts
```

The GUI should call the same core that CLI calls.

If GUI and CLI produce different artifacts for the same task, the architecture is broken.

---

# Test Strategy

TDD is mandatory.

Each checkpoint begins with tests.

The expected cycle is:

```text
RED: write failing acceptance/unit test first
GREEN: implement smallest code to pass
REFACTOR: clean only after tests pass
```

Production code without a failing test first is not accepted.

## Default tests

Default test commands must not call real LLM providers.

TypeScript:

```powershell
pnpm test
```

Python:

```powershell
uv run pytest
```

## Live tests

Live tests call real model providers and are explicit only.

TypeScript:

```powershell
pnpm test:live
```

Python:

```powershell
uv run pytest -m live
```

Live tests should be token-efficient.

Live tests are used only when explicitly requested.

Provider secrets/config are not stored in committed project config.

---

# Model Provider Secrets

Provider secrets live outside the project repository.

Use user-profile configuration or local environment setup.

Project `config.yaml` must not contain committed API keys or provider secrets.

Allowed sources:

```text
user profile config
local environment variables
local .env if explicitly ignored and locally managed
```

The preferred source is user profile configuration.

---

# Secret Handling

Initial VibecodeLight does not perform aggressive secret redaction or fixed filename censorship.

It respects ignore rules.

Users are responsible for keeping secrets out of non-ignored repository content.

Provider secrets must live outside committed project files.

VibecodeLight is not a secret scanner.

Future hardening can add secret scanning/redaction, but it is not part of the initial implementation contract.

---

# Live Test Behavior

Default tests:

```text
do not call real models
use mocks
are stable
are cheap
run in normal development
```

Live tests:

```text
call configured real provider
verify flash adapter can return usable Markdown output
are token-efficient
are not run unless explicitly requested
may require provider config in user profile
```

---

# TypeScript / Python Write Boundary

## TypeScript may write

```text
config.yaml
.gitignore during init
.vibecode/runs/<run_id>/run_manifest.json
.vibecode/runs/<run_id>/scanner_config.json
.vibecode/runs/<run_id>/skills/
.vibecode/runs/<run_id>/flash/
.vibecode/runs/<run_id>/output/
.vibecode/runs/<run_id>/terminal/
.vibecode/runs/<run_id>/after/
.vibecode/current/
SKILLS/ during explicit skills copy
```

## Python may write

Only when `--out` is provided:

```text
.vibecode/runs/<run_id>/scan/
```

## Python may read

```text
target repo excluding ignored/generated paths according to scanner config
scanner_config.json
```

## Python must not write

```text
target repo source files
config.yaml
.gitignore
SKILLS/
.vibecode/current/
.vibecode/runs/<run_id>/output/
.vibecode/runs/<run_id>/flash/
.vibecode/runs/<run_id>/skills/
.vibecode/runs/<run_id>/terminal/
.vibecode/runs/<run_id>/after/
```

## PTY adapter may write

The PTY adapter writes terminal output metadata only through the run store.

It does not modify repo files directly.

## Git adapter may write

The Git adapter may create commits and collect git state when called by TypeScript orchestration.

Generated `.vibecode/` artifacts are not committed.

---

# Main Model Input vs Flash Input

Flash model receives broad scan material.

Main model receives compressed, task-specific context.

## Flash receives

```text
scan artifacts
skills catalog metadata
previous run summary
read-only tools
```

## Main model receives

```text
final_prompt.md
context_pack.md
selected skill contents
relevant files list
files to read with tools
commands to run
cautions
```

This separation prevents the main model from being flooded with raw scan material.

---

# Prompt Preview and Auto-Approve

Preview is required by default.

Default behavior:

```text
build run
build context
render final_prompt.md
show final_prompt.md
send only after approval
```

Auto-approve may be enabled by user configuration.

Even in auto-approve mode:

```text
final_prompt.md must be written before send
send_metadata.json must record what was sent
no hidden text may be added after render
```

---

# Terminal Logging

Default terminal logging stores send metadata after prompt send.

Config may enable full transcript.

Artifacts:

```text
terminal/send_metadata.json
terminal/terminal_transcript.md
```

`terminal_transcript.md` is optional and only present when full transcript mode is enabled.

---

# Post-Run Artifacts

Post-run git/check artifacts live under:

```text
after/
```

Canonical artifacts:

```text
after/git_status_after.json
after/changed_files_after.json
after/checks_summary.md
```

`checks_summary.md` may initially be partial or placeholder until check capture is implemented.

---

# Per-Run Commit Policy

Each model run is expected to create a deterministic git commit that captures the run result.

If tests or validation fail, the run/commit must clearly mark the failed validation state.

Failure state may be recorded in:

```text
run metadata
after/checks_summary.md
agent final report
commit message or commit body
```

Generated `.vibecode/` artifacts are not committed.

The commit captures repository changes, not VibecodeLight runtime artifacts.

Later UI/CLI should provide a way to revert changes from a run.

This is an intentional product decision.

---

# Terminal Send Policy

The initial implementation does not try to detect whether the terminal is shell, Hermes, OpenCode, Codex, or another interactive tool.

Initial policy:

```text
VibecodeLight behaves like communication with a real terminal.
The user remains responsible for the active terminal state when sending a prompt.
```

No complex automatic terminal-mode detection is part of the initial implementation.

Future adapters or send policies may improve target-specific behavior.

---

# Development Commands

Initial developer commands should be documented in `README.md`.

Expected commands:

```powershell
pnpm install
pnpm test
pnpm test:live
pnpm lint
pnpm typecheck
pnpm build

cd src/core/scanning/python
uv sync
uv run pytest
uv run pytest -m live
uv run ruff check .
```

Exact paths may be adjusted during scaffold, but the command surface must stay documented.

---

# Checkpoint Implementation Discipline

Every implementation checkpoint must define:

```text
what is being implemented
which modules are touched
which CLI commands must work
which artifacts must be produced
which tests prove the behavior
```

The implementation should not move to the next checkpoint until the current one works.

This is about building the required behavior, not writing long lists of prohibitions.

---

# Summary of Ownership

```text
TypeScript owns:
- app shell
- CLI orchestration
- workspace init
- config.yaml
- run store
- .vibecode layout
- .vibecode/current
- skills system
- LLM providers
- flash tools
- Markdown flash output parsing
- prompt rendering
- terminal/PTY integration
- post-run artifacts
- per-run commit orchestration
- JSON schema validation boundary

Python owns:
- deterministic repository scan logic
- scanner CLI
- scan artifact generation
- read-only repo analysis

Shared contract:
- JSON schemas in schemas/
- scanner_config.json
- scan artifacts
- Markdown flash output section contract
- CLI JSON envelope
- stable exit codes
```

This ownership split is non-negotiable for maintainability.

The whole point is to prevent a hybrid Electron/Python project from turning into a tangled mess.
