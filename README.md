<a id="readme-top"></a>

<br />
<div align="center">
  <h1 align="center">VibecodeLight</h1>

  <p align="center">
    A real-terminal workspace with a transparent context-pack and prompt layer for AI coding agents.
    <br />
    <br />
    <strong>Status:</strong> architecture contracts aligned; implementation starts checkpoint-by-checkpoint.
  </p>
</div>

---

## Table of Contents

<details>
  <summary>Open</summary>
  <ol>
    <li><a href="#about-the-project">About The Project</a></li>
    <li><a href="#project-status">Project Status</a></li>
    <li><a href="#what-vibecodelight-does">What VibecodeLight Does</a></li>
    <li><a href="#core-workflow">Core Workflow</a></li>
    <li><a href="#built-with">Built With</a></li>
    <li><a href="#architecture-split">Architecture Split</a></li>
    <li><a href="#generated-state">Generated State</a></li>
    <li><a href="#skills">Skills</a></li>
    <li><a href="#configuration">Configuration</a></li>
    <li><a href="#planned-cli-surface">Planned CLI Surface</a></li>
    <li><a href="#getting-started">Getting Started</a></li>
    <li><a href="#development">Development</a></li>
    <li><a href="#desktop-app">Desktop App</a></li>
    <li><a href="#per-run-commits">Per-Run Commits</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>

---

## About The Project

VibecodeLight is being built as a practical workspace for using AI coding agents on real repositories.

It does not try to replace Hermes, OpenCode, Codex, Git, test runners, or the shell. Instead, it prepares the context an agent needs before a prompt is sent into a real terminal session.

The core idea:

```text
selected repository
→ user prompt
→ new reproducible run package
→ deterministic repo scan
→ flash model context compression
→ selected skills
→ final_prompt.md preview
→ exact prompt sent into a real terminal
→ post-run artifacts
→ per-run git commit
```

Every prompt should become an inspectable artifact.

Every generated context package should be reproducible.

Every model prompt should be visible before it is sent.

VibecodeLight exists to reduce agent confusion, hidden prompt drift, repeated repository exploration, and unreproducible implementation sessions.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Project Status

VibecodeLight is past the baseline scaffold stage. The CLI/core path, PTY terminal adapter, Electron desktop shell, composer preview, and prompt-send pipeline are implemented and tested.

Implemented checkpoints (as of HEAD):

```text
repository baseline / scaffold
CLI and core debug path
workspace initialization + run store
Python scanner CLI skeleton + deterministic scan artifacts
manifest/dependency/command/environment scan
docs/instructions scan + code map scan
skills catalog and project snapshot
flash input builder + Markdown flash output contract
flash model adapter (mock) + context pack
final prompt renderer
real PTY terminal (node-pty)
Electron shell + composer preview
send final prompt into terminal (send_metadata.json)
per-run git commit
```

Deferred / not yet implemented:

```text
follow-up terminal context (terminal_excerpt_after.md — explicitly deferred in 32bfb8f)
schemas/ JSON Schema files (placeholder directory; see JSON Schema Strategy debt below)
src/core/validation/ (placeholder directory; TypeScript types and Pydantic models exist but JSON Schema cross-language contracts not yet written)
auto-approve mode
post-run after/ artifacts
terminal-mode detection (Hermes/OpenCode/Codex)
```

The desktop shell comes after the CLI/core path is testable and reproducible.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## What VibecodeLight Does

VibecodeLight is designed to:

- open and manage a real terminal session in a selected repository;
- create a new run package for every model prompt;
- scan the repository deterministically;
- build a structured flash-model input from repository facts and project skills;
- let the flash model select relevant files, cautions, commands, and skills;
- store a structured Markdown flash output;
- render a transparent `final_prompt.md`;
- show the exact prompt before sending it by default;
- send that exact prompt into the active terminal session;
- preserve enough artifacts to debug what happened later;
- capture the run result in a deterministic git commit.

The terminal must be a real PTY terminal, not a simulated textarea.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Core Workflow

```text
User writes task
  ↓
VibecodeLight creates a new run
  ↓
TypeScript creates run layout and scanner_config.json
  ↓
Python scanner performs deterministic read-only repository scan
  ↓
TypeScript builds flash_input.md
  ↓
Flash model produces flash_output.md
  ↓
TypeScript extracts selected skills/context metadata where possible
  ↓
TypeScript writes context_pack.md and selected skill artifacts
  ↓
TypeScript renders final_prompt.md
  ↓
User previews final_prompt.md by default
  ↓
VibecodeLight sends the exact prompt into the real terminal
  ↓
Run artifacts preserve what happened
  ↓
Post-run state is captured
  ↓
A deterministic git commit captures the run result
```

The important contract:

```text
flash_output.md = structured Markdown output from the flash model
context_pack.md = flash-compressed task context
final_prompt.md = deterministic prompt sent to the terminal
```

`final_prompt.md` is the truth.

What is written in `final_prompt.md` is what gets sent to the terminal.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Built With

Planned core stack:

- Electron
- TypeScript
- pnpm
- Vitest
- ESLint
- node-pty
- Prettier
- electron-vite
- Python
- uv
- pytest
- ruff
- pydantic
- typer

The project is intentionally hybrid:

```text
Electron / TypeScript shell
+ TypeScript orchestration/core
+ Python deterministic scanner subprocess
+ JSON/Markdown run artifacts
+ real PTY terminal
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Architecture Split

VibecodeLight has a strict TypeScript/Python ownership boundary.

### TypeScript owns

```text
main CLI command: vibecode
workflow orchestration
workspace initialization
config.yaml
run store
.vibecode/ layout
.vibecode/current
skills catalog/copy/selection loading
LLM provider adapters
flash tools
Markdown flash output parsing
context assembly
prompt rendering
PTY/terminal integration
desktop shell
post-run artifacts
per-run commit orchestration
JSON schema validation boundary
```

### Python owns

```text
internal scanner CLI: vibecode-scan
deterministic repository scanning
repo tree generation
file inventory
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

Python writes only inside the scan output directory authorized by TypeScript:

```text
.vibecode/runs/<run_id>/scan/
```

All non-scan `.vibecode/` writes go through the TypeScript RunStore.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Repository Layout

Expected layout:

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
  schemas/
  tests/
    core/
    adapters/
    integration/
```

Python scanner code is expected to live under the scanning boundary:

```text
src/core/scanning/
  scanner_subprocess.ts
  scanner_config.ts
  python/
    pyproject.toml
    vibecode_scanner/
      cli.py
      scan/
```

Do not introduce a competing top-level Python architecture.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Generated State

`.vibecode/` is generated working state.

It must be ignored by git.

It contains run artifacts such as:

```text
.vibecode/runs/<run_id>/
  user_prompt.md
  run_manifest.json
  scanner_config.json
  scan/
  skills/
  flash/
  output/
  terminal/
  after/
```

`.vibecode/` is not scanned as source repository content.

`.vibecode/current/` is only a convenience mirror/pointer.

Historical truth lives in:

```text
.vibecode/runs/<run_id>/
```

Canonical current files:

```text
.vibecode/current/
  run_manifest.json
  context_pack.md
  final_prompt.md
  selected_skills.json
  send_metadata.json   # only after send
```

Generated `.vibecode/` artifacts are not committed.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Run Artifact Layout

Canonical run layout:

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

`terminal_transcript.md` is optional and controlled by configuration.

`after/` is for post-run git/check artifacts.

`terminal/` is for send metadata and optional terminal transcript artifacts.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Skills

VibecodeLight uses skills as reusable instructions for agents.

Primary skills live in the user profile.

Project snapshots live in:

```text
SKILLS/
```

`SKILLS/` is outside `.vibecode/`.

Skills are not auto-synced.

Skills are not silently rewritten.

Copying a skill is an explicit snapshot operation.

TypeScript owns the canonical skills catalog.

Python scanner may see `SKILLS/` as ordinary repository files for tree, inventory, and docs, but Python does not build the canonical skills catalog.

The flash model receives a skills catalog and selects which skills should be included in the prompt package.

Selected skill content is expanded by TypeScript and inserted into the final prompt.

Primary user-profile skills root (Windows default):

```text
%APPDATA%/VibecodeLight/skills/
  default/
  user/
```

The location can be overridden during development with the `VIBECODE_USER_PROFILE` environment variable (skills live under `<profile>/skills/`) or `VIBECODE_SKILLS_HOME` (points directly at the skills root).

Each run gets a TypeScript-owned per-run skills catalog at:

```text
.vibecode/runs/<run_id>/skills/skills_catalog.json
```

The Python scanner does not produce this file.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Configuration

VibecodeLight resolves configuration from a global user profile and a per-repository local workspace config. A single TypeScript-owned core config service performs this resolution; the CLI and desktop call the same service.

Global user directory (Windows):

```text
%LOCALAPPDATA%\vibecodelight
```

Global files:

```text
%LOCALAPPDATA%\vibecodelight\config.yaml   # global non-secret defaults
%LOCALAPPDATA%\vibecodelight\.env          # secrets and env-style provider settings
```

Per-repository local workspace config:

```text
<repo>\.vibecode\config.yaml
```

Rules:

- The local workspace config takes priority over the global config.
- When a repo has no `.vibecode/config.yaml`, it is created as a snapshot from the global config (or minimal safe defaults) at init/config-use time.
- Sync between global and local is explicit (never automatic in either direction).
- `.vibecode/config.yaml` is local working state inside the ignored `.vibecode/` tree; it is not committed and is not the historical run-artifact truth.
- API keys must live only in the AppData `.env` file. They are never written to committed files, artifacts, diagnostics, logs, or README examples. Secret keys found in any `config.yaml` are ignored with a warning.

Resolution priority for model/provider/baseUrl/timeouts and other non-secret settings:

```text
1. explicit CLI flags
2. local workspace config (<repo>\.vibecode\config.yaml)
3. AppData .env values
4. AppData global config.yaml
5. safe defaults
6. otherwise FLASH_PROVIDER_NOT_CONFIGURED
```

Resolution priority for API keys/secrets:

```text
1. explicit CLI/env input
2. AppData .env
3. process environment
4. otherwise FLASH_PROVIDER_NOT_CONFIGURED / FLASH_PROVIDER_AUTH_MISSING
```

Config CLI commands (debug/automation; all call the same core service):

```powershell
pnpm vibecode config paths --json
pnpm vibecode config show --json
pnpm vibecode config init-local --repo <path> --json
pnpm vibecode config sync --from-global --repo <path> --json
pnpm vibecode config sync --to-global --repo <path> --json
```

`config paths` shows the global dir, global config, global env, and local config path for a repo. `config show` shows the resolved safe config and per-field source map and never prints API keys. `config sync` requires an explicit direction and reports the source and destination paths.

Every prompt/flash run records which config was used in a safe, secret-free artifact:

```text
.vibecode/runs/<run_id>/config_resolution.json
```

It records the global/local config and env paths, whether each exists, whether the local config was created from the global one, the selected config source, the provider/model/baseUrl host, and a per-field source map (the API key source only, never its value). The flash run metadata at `flash/flash_output_meta.json` additionally records `provider`, `model`, `live`, `baseUrl_host`, `config_source`, and `config_resolution_path`, so it is always clear which model/provider was used.

For each run, TypeScript writes:

```text
.vibecode/runs/<run_id>/scanner_config.json
```

Python scanner receives this file and writes the scan-side config snapshot to:

```text
.vibecode/runs/<run_id>/scan/config_snapshot.json
```

The Python scanner never reads the global or local YAML config directly.

Do not use:

```text
.vibecode/config.json
scan/config.json
```

VibecodeLight is not a secret scanner. It respects ignore rules. Users are responsible for keeping secrets out of non-ignored repository content.

> Note: this supersedes the earlier rule that the repository-root `config.yaml` is the only human-maintained config. The root `config.yaml` still exists for project/scanner defaults, but human-maintained provider configuration now lives in the global user directory and the per-repository `.vibecode/config.yaml`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Flash Output

Initial flash output is Markdown-first.

Canonical initial artifact:

```text
.vibecode/runs/<run_id>/flash/flash_output.md
```

Expected stable sections:

```markdown
# Task Summary

# Relevant Files

# Files To Read With Tools

# Relevant Tests

# Commands To Run

# Selected Skills

# Cautions

# Context Pack
```

Optional extracted metadata:

```text
.vibecode/runs/<run_id>/flash/flash_output_meta.json
```

Run the deterministic mock flash adapter against a saved context-build run:

```powershell
pnpm vibecode flash run latest --mock
pnpm vibecode flash run latest --mock --json
pnpm vibecode flash run <run_id> --mock
```

`flash run` writes `flash_output.md`, `flash_output_meta.json`, and `tool_calls.json` under the selected run's `flash/` directory. Default local/test runs do not call live providers; use `--mock` unless an explicit live-provider mode is being tested.

Finalize a saved flash output into downstream context artifacts:

```powershell
pnpm vibecode context finalize latest
pnpm vibecode context finalize latest --json
pnpm vibecode context finalize <run_id>
```

`context finalize` validates `flash/flash_output.md`, writes `output/context_pack.md`, resolves selected skills into `skills/selected_skills.json`, and expands available `SKILL.md` files into `skills/selected_skill_contents.md`. It does not create `output/final_prompt.md`; final prompt rendering is a later step.

Future JSON flash output is allowed later, but it is not the initial implementation contract.

If JSON mode is introduced later, `flash_output.json` must be schema-validated before use.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Planned CLI Surface

The CLI is a first-class debug and automation interface.

### Public/stable CLI

```powershell
vibecode init
vibecode scan "task"
vibecode prompt "task"
vibecode runs list
vibecode runs show latest
vibecode skills list
vibecode skills project-list
vibecode skills copy <skill-id>
vibecode skills copy --all
```

`skills list` and `skills project-list` accept `--json`. `skills copy` accepts `--force` to overwrite an existing destination and `--repo <path>` to target a specific repository.

### Debug/internal CLI

```powershell
vibecode doctor
vibecode run create "task"
vibecode context-build "task"
vibecode flash validate <path>
vibecode flash run latest
vibecode terminal demo
vibecode config paths
vibecode config show
vibecode config init-local --repo <path>
vibecode config sync --from-global --repo <path>
vibecode config sync --to-global --repo <path>
```

For local development, invoke the TypeScript CLI through pnpm:

```powershell
pnpm vibecode context-build "task"
pnpm vibecode context-build "task" --repo <path>
pnpm vibecode context-build "task" --json
pnpm vibecode flash run latest --mock
pnpm vibecode flash run latest --mock --json
pnpm vibecode terminal demo
pnpm vibecode terminal demo --json
pnpm vibecode terminal demo --repo <path>
```

`terminal demo` starts a real PTY-backed PowerShell session in the requested repo and runs a small `VIBECODE_PTY_OK` demo command plus `git status --short` without sending a prompt or writing send/follow-up artifacts.

The current `context-build` checkpoint creates a run, runs the deterministic scanner, writes `skills/skills_catalog.json`, and writes `flash/flash_input_manifest.json` plus `flash/flash_input.md`. It does not call a real flash model and does not produce `flash_output.md`, `context_pack.md`, or `final_prompt.md`.

### Full CLI dogfood

Run the complete mock prompt pipeline without Electron:

```powershell
pnpm vibecode prompt "task" --mock
pnpm vibecode prompt "task" --mock --json
pnpm vibecode runs list
pnpm vibecode runs show latest
pnpm vibecode runs show latest --json
```

`prompt --mock` writes scan, skills, flash, context, and `output/final_prompt.md` artifacts. It does not send anything to a terminal in this checkpoint, so no `terminal/send_metadata.json` or `after/` post-run artifacts are created.

### Internal scanner CLI

```powershell
vibecode-scan --help
vibecode-scan --repo . --task "task"
python -m vibecode_scanner --repo . --task "task"
```

Agent-facing commands should support `--json` where relevant.

These commands are the target command surface. Early implementation checkpoints may provide only a subset.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Getting Started

This project is not fully implemented yet. The commands below describe the expected development setup once the repository scaffold exists.

### Prerequisites

Expected tools:

- Node.js
- pnpm
- Python
- uv
- Git
- Windows PowerShell as the primary development shell

Do not assume WSL or Docker as required development dependencies.

### Installation

Expected TypeScript setup:

```powershell
pnpm install
```

Expected Python scanner setup:

```powershell
cd src/core/scanning/python
uv sync
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Development

Expected TypeScript commands:

```powershell
pnpm test
pnpm test:serial
pnpm test:live
pnpm lint
pnpm typecheck
pnpm build
```

`pnpm test` runs the full Vitest suite (parallel by default). `pnpm test:serial` runs the same suite with `--fileParallelism=false` and is available as a fallback if the parallel run shows flakiness on a given Windows ConPTY/node-pty environment.

Expected Python scanner commands:

```powershell
cd src/core/scanning/python
uv run pytest
uv run pytest -m live
uv run ruff check .
```

Some commands may not exist in the earliest scaffold. When unavailable, report that clearly.

### Testing policy

Default tests must not call live LLM providers.

Live model tests are explicit only:

```powershell
pnpm test:live
uv run pytest -m live
```

Live tests should be token-efficient.

### Development rules

Keep the implementation checkpoint-driven.

Use TDD.

Keep TypeScript/Python ownership clean.

Do not commit `.vibecode/`.

Do not hide prompt text after preview.

Do not put scanner logic in UI.

Do not put LLM provider calls in the Python scanner.

Keep README updates minimal and targeted when behavior changes. Do not rewrite the README structure just because one command or artifact changes.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Desktop App

The desktop app now has a checkpoint Electron shell around the existing PTY adapter and keeps renderer access behind a preload/contextBridge API. Launch it for local development with:

```powershell
pnpm dev:desktop
```

The script compiles desktop TypeScript to ignored `dist-desktop/`, copies the minimal renderer HTML, copies local `@xterm/xterm` assets into `dist-desktop/app/desktop/renderer/vendor/xterm/`, and starts Electron. The renderer loads xterm from these local vendor files — no internet/CDN required.

Desktop resolves the workspace repo root in this priority order: `--repo` argument → `VIBECODE_REPO` environment variable → current working directory. To set the environment variable during local development:

```powershell
$env:VIBECODE_REPO = "C:\\path\\to\\repo"
pnpm dev:desktop
```

Prompt generation uses the current resolved repo only; it does not add follow-up terminal context or create follow-up terminal-context artifacts.

For an automated headless smoke of the desktop terminal bridge (no Electron window), run:

```powershell
pnpm desktop:smoke
pnpm vibecode desktop smoke --repo <path>
pnpm vibecode desktop smoke --json
```

`desktop smoke` exercises the same `DesktopTerminalService` that Electron uses, spawns a real PTY in the requested repo, writes `Write-Output "VIBECODE_ELECTRON_PTY_OK"`, verifies the marker appears in the output, then closes the session. It does not create any `.vibecode/`, `terminal/`, `output/`, or `after/` artifacts.

The desktop app should provide:

- a real embedded PTY terminal; currently implemented in the checkpoint shell;
- a prompt composer overlay (preview only in this checkpoint);
- final prompt preview;
- prompt send into the active terminal;
- run artifact visibility.

### Composer preview overlay

The checkpoint shell now ships a minimal composer overlay. Click **Open composer**, write a task, and press **Generate preview** to run the full mock prompt pipeline through the same core code as `pnpm vibecode prompt "task" --mock`. The overlay shows:

- the exact saved `output/final_prompt.md` content (the preview equals the saved file — no hidden prompt material is added in the UI);
- a run/artifact summary: `run_id`, `runDir`, `final_prompt.md`, `context_pack.md`, `skills/selected_skills.json`, terminal-send status.

### Send final prompt into terminal

After a preview is generated and a terminal session is active, click **Send to Terminal** to send the saved `output/final_prompt.md` of the current run into the active embedded PTY session. The renderer never reads files directly — it calls `composer.sendPreview(runId)` through the preload contextBridge, the main process reads the saved file, and the existing `DesktopTerminalService` writes the bytes into the active session. The preview source and the bytes sent are the same file; the metadata records both hashes honestly. After a successful send VibecodeLight writes:

```text
.vibecode/runs/<run_id>/terminal/send_metadata.json
.vibecode/current/send_metadata.json   # mirror; created only after send
```

`send_metadata.json` records `run_id`, `terminal_session_id`, `sent_file` (`output/final_prompt.md`), `sent_at`, `auto_approve: false`, `byte_count`, `char_count`, `content_sha256` (hash of the saved final prompt), `sent_payload_sha256` (hash of the bytes actually written; equal to `content_sha256` unless a trailing newline is appended), `newline_appended`, and `terminal_cwd`. The saved `output/final_prompt.md` is never mutated by send. This checkpoint does not implement auto-approve, post-run state capture, `after/` artifacts, per-run commits, or terminal-mode detection for Hermes/OpenCode/Codex. The terminal continues to work independently of the composer.

The GUI must call the same core/adapters logic as the CLI through IPC/preload boundaries.

If GUI and CLI produce different artifacts for the same task, the architecture is broken.

Real desktop behavior comes after the CLI/core path is reliable.

The initial implementation does not try to detect whether the terminal is shell, Hermes, OpenCode, Codex, or another interactive tool. VibecodeLight behaves like communication with a real terminal, and the user remains responsible for the active terminal state when sending a prompt.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Per-Run Commits

Each model run is expected to create a deterministic git commit that captures the run result.

If tests or validation fail, the run/commit must clearly mark the failed validation state.

Generated `.vibecode/` artifacts are not committed.

The commit captures repository changes, not VibecodeLight runtime artifacts.

Later UI/CLI should provide a way to revert changes from a run.

This policy makes every model-driven change visible in git history.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Contributing

This repository is expected to be built through small, testable checkpoints.

Before contributing or running a coding agent, read:

```text
AGENTS.md
docs/ARCHITECTURE_DECISIONS.md
docs/IMPLEMENTATION_MAP.md
```

Core contribution expectations:

- follow TDD;
- keep changes scoped;
- run relevant tests;
- do not commit generated run artifacts;
- preserve the TypeScript/Python boundary;
- perform a minimal README update if user-facing commands, setup steps, test commands, generated artifact paths, or workflow behavior change;
- do not rewrite the whole README when a small targeted update is enough;
- create a scoped commit after successful implementation work;
- do not push or open a PR unless explicitly asked.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## License

Distributed under the MIT License.

See `LICENSE` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>
