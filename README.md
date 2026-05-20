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

VibecodeLight is in the design-to-implementation stage.

The architecture contracts are aligned. Implementation is expected to begin checkpoint-by-checkpoint.

Current baseline checkpoint:

```text
documentation/baseline alignment
README.md
AGENTS.md
docs/*
config.yaml
.gitignore
```

Next code/scaffold checkpoint:

```text
repository scaffold
workspace initialization
run store
CLI smoke tests
Python scanner CLI skeleton
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

`terminal_transcript.md` is optional and controlled by configuration.

`after/` is for post-run git/check artifacts.

`terminal/` is for send metadata and terminal transcript/excerpt artifacts.

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

The only human-maintained project config is:

```text
config.yaml
```

It lives in the repository root.

TypeScript owns it.

TypeScript creates, preserves, reads, validates, and resolves `config.yaml`.

Python scanner does not read `config.yaml` directly.

For each run, TypeScript writes:

```text
.vibecode/runs/<run_id>/scanner_config.json
```

Python scanner receives this file and writes the scan-side config snapshot to:

```text
.vibecode/runs/<run_id>/scan/config_snapshot.json
```

Do not use:

```text
.vibecode/config.json
scan/config.json
```

Provider secrets and API keys must not be committed. They should live in user-profile configuration, local environment variables, or other local non-committed configuration.

VibecodeLight is not a secret scanner. It respects ignore rules. Users are responsible for keeping secrets out of non-ignored repository content.

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
```

For local development, invoke the TypeScript CLI through pnpm:

```powershell
pnpm vibecode context-build "task"
pnpm vibecode context-build "task" --repo <path>
pnpm vibecode context-build "task" --json
pnpm vibecode flash run latest --mock
pnpm vibecode flash run latest --mock --json
```

The current `context-build` checkpoint creates a run, runs the deterministic scanner, writes `skills/skills_catalog.json`, and writes `flash/flash_input_manifest.json` plus `flash/flash_input.md`. It does not call a real flash model and does not produce `flash_output.md`, `context_pack.md`, or `final_prompt.md`.

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
pnpm test:live
pnpm lint
pnpm typecheck
pnpm build
```

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

The desktop app is planned as an Electron shell around the same core pipeline used by the CLI.

The desktop app should provide:

- a real embedded PTY terminal;
- a prompt composer overlay;
- final prompt preview;
- prompt send into the active terminal;
- run artifact visibility.

The GUI must call the same core logic as the CLI.

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
