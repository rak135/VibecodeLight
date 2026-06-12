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
task normalizer (optional)
CodeGraph integration (optional)
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
auto-approve send (desktop composer auto-send after build, and CLI `vibecode prompt --auto-approve`; send_metadata.auto_approve)
per-run git commit
task normalizer (optional)
CodeGraph integration (optional)
```

Deferred / not yet implemented:

```text
follow-up terminal context (terminal_excerpt_after.md — explicitly deferred in 32bfb8f)
schemas/ JSON Schema files (placeholder directory; see JSON Schema Strategy debt below)
src/core/validation/ (placeholder directory; TypeScript types and Pydantic models exist but JSON Schema cross-language contracts not yet written)
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
Task Normalizer (optional) — translates non-English task into English search hints
  ↓
VibecodeLight creates a new run
  ↓
TypeScript creates run layout, task_intent artifacts, and scanner_config.json
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
  task_intent.json
  task_intent.md
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

### Optional Task Normalizer

Task Normalizer is an optional, off-by-default feature that translates and expands the user task into English technical search hints before context selection. It does **not** select files, does not invent repository symbols, and is not a source of truth for relevance.

- When enabled, it writes `.vibecode/runs/<run_id>/task_intent.json` and `task_intent.md`. The task intent contains the normalized English task, search hints, keyword groups, constraints, and validation hints.
- When disabled, it still writes a deterministic disabled artifact (`enabled: false`).
- If the normalizer fails, the pipeline continues with the raw task. The failure is recorded in the artifact (`ok: false`, `source: "fallback"`).
- **Not a file selector.** The normalizer produces linguistic/task-intent signals only — no relevant files, no exact source paths, no implementation plan.
- The python scanner receives expanded search signals via `scanner_config.json` (normalized English task, search hints, keyword groups).
- Flash compaction and `task_slice.md` surface selection reasons from normalized task terms.
- CodeGraph queries use the enriched English task when the normalizer runs successfully.
- `flash_input.md` includes a visible **Task Intent** section showing the normalized English task, search hints, and constraints.

Opting in is per-build and explicit. CLI remains explicit: `vibecode prompt --task-normalizer` or `vibecode prompt --no-task-normalizer` (and the matching `context-build` variants). Desktop: the **Task Normalizer** toggle in the composer header (ON = enabled, OFF = disabled) remembers the last GUI choice in global user config at `%LOCALAPPDATA%/vibecodelight/config.yaml` under `desktop.task_normalizer.enabled`; this Desktop GUI preference is not a CLI default.

The normalizer uses the flash LLM provider for inference. By default (disabled), no LLM call is made and no cost is incurred. Default tests use a mock normalizer — no live provider calls.

### Optional CodeGraph

CodeGraph is an optional, off-by-default code-intelligence tool. By default VibecodeLight only detects it. A context build may explicitly opt into using an existing initialized local CodeGraph index as read-only input; VibecodeLight still never auto-runs `codegraph init`, `index`, `sync`, or `watch`, and never creates `.codegraph/` during context build.

- `.codegraph/` is external generated index state (like `.vibecode/`). It is ignored by git and excluded from repository scans — it is never scanned as source content.
- Each scan records detection in `.vibecode/runs/<run_id>/scan/external_tools.json` (whether the `codegraph` command is available and whether `.codegraph/` is initialized). A missing command or missing `.codegraph/` is a warning, never a scan failure.
- When explicitly enabled and usable, context build records `.vibecode/runs/<run_id>/scan/codegraph_usage.json` and bounded `.vibecode/runs/<run_id>/scan/codegraph_context.md`. When CodeGraph hints expose recognizable repo paths, a bounded CodeGraph-derived Repo Atlas is also written to `scan/codegraph_repo_atlas.md` and `scan/codegraph_repo_atlas.json` (mirrored under the legacy `scan/repo_atlas.md` / `scan/repo_atlas.json` paths for backward compatibility). `flash_input.md` marks the atlas and context as guidance from the existing local index, not source truth.
- Opting in is per-build and explicit. CLI remains explicit: `vibecode prompt --codegraph` or `vibecode prompt --codegraph-mode use-existing` (and the matching `--no-codegraph` / `--codegraph-mode detect-only` to force off); `vibecode context-build "task" --codegraph-mode use-existing` for the no-flash path. Desktop: the **CodeGraph** toggle in the composer header (ON = `use-existing`, OFF = `detect-only`) remembers the last GUI choice in global user config at `%LOCALAPPDATA%/vibecodelight/config.yaml` under `desktop.codegraph.mode`; this Desktop GUI preference is not a CLI default.
- Maintenance actions are explicit and never automatic. CLI: `vibecode codegraph status | init | sync | reindex` (each accepts `--repo <path>` and `--json`). Desktop: the **Initialize / Sync / Re-index** buttons in the composer header (Re-index requires confirmation). Prompt and context build never call `codegraph init`, `index`, `sync`, or `watch`; MCP transport may spawn `codegraph serve --mcp` only to query context.
- MCP integration with the **existing upstream CodeGraph MCP server** (`codegraph serve --mcp`) is available as an opt-in helper. `vibecode codegraph mcp self-test --repo <path>` (with optional `--json`) spawns the upstream server through stdio, performs the MCP handshake, calls `tools/list`, and verifies that the expected CodeGraph tools (`codegraph_status`, `codegraph_context`, `codegraph_search`, `codegraph_files`) are exposed. `vibecode codegraph mcp config --agent claude --print` prints a stdio MCP config snippet for Claude (other agents return a structured `AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED` diagnostic). VibecodeLight does not implement its own CodeGraph MCP server, and MCP self-test never calls `codegraph init`, `sync`, `index`, or `watch`. HTTP/stdio gateway serving, managed install/update, background watch, and automatic agent-config writes remain out of scope. See `docs/codegraph.md` and `docs/codegraph_mcp_roadmap.md` for phase boundaries.
- **CodeGraph MCP transport (Phase 1B)**: the prompt/context pipeline can optionally query CodeGraph context through the upstream MCP server instead of the CLI. The desktop composer header exposes **CodeGraph Transport: CLI / MCP / Auto**; the GUI dropdown and CLI command both read/write the shared global user config setting `defaults.codegraph.transport` at `%LOCALAPPDATA%/vibecodelight/config.yaml` (or the equivalent platform user config path). Inspect with `vibecode codegraph transport get --json`, set with `vibecode codegraph transport set cli|mcp|auto`, and reset with `vibecode codegraph transport reset --json`. default = cli. The GUI remembers the setting by using global config, not localStorage. **CLI** is the stable default; **MCP** is strict (spawns `codegraph serve --mcp`, calls `codegraph_context`, and does not fall back); **Auto** prefers MCP and falls back to CLI on failure (with a warning event and `fallback_used: true` in `scan/codegraph_usage.json`). The transport is independent of the CodeGraph ON/OFF toggle — detect-only never queries context, regardless of transport. prompt-level transport flags are intentionally not the primary UX; use the persisted setting instead. No auto-init/sync/index/watch is performed during prompt generation.

Desktop remembered pipeline settings live in the global user config under the `desktop.*` namespace and are Desktop GUI preferences, not CLI defaults:

- `desktop.codegraph.mode`: `detect-only` (GUI OFF, safe default) or `use-existing` (GUI ON).
- `desktop.task_normalizer.enabled`: boolean, default `false`.
- `desktop.auto_approve.enabled`: boolean, default `false`; this safety-sensitive value only initializes the Desktop GUI auto-approve toggle.

CLI remains explicit and does not automatically consume these `desktop.*` settings: use `--codegraph` / `--no-codegraph` / `--codegraph-mode detect-only|use-existing`, `--task-normalizer` / `--no-task-normalizer`, and `--auto-approve` for CLI runs. `desktop.auto_approve.enabled` does not make CLI prompt auto-approve; actual terminal sends still record `auto_approve` in `terminal/send_metadata.json` as a per-send value. Renderer localStorage is not the source of truth for pipeline-affecting remembered settings; reserve localStorage for pure UI/session state only.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Run Artifact Layout

Canonical run layout:

```text
.vibecode/runs/<run_id>/
  user_prompt.md
  task_intent.json
  task_intent.md
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
    exact_text_hits.json   # deterministic exact user-provided phrase matches in scanned text files
    keyword_hits.json
    recent_history.json
    previous_run_summary.json
    external_tools.json
    codegraph_usage.json       # present for prompt/context builds
    codegraph_context.md       # only when explicitly using an existing CodeGraph index succeeds
    codegraph_repo_atlas.md    # bounded CodeGraph-derived Repo Atlas (use-existing only)
    codegraph_repo_atlas.json  # structured form of the same atlas
    repo_atlas.md              # legacy compat copy of codegraph_repo_atlas.md
    repo_atlas.json            # legacy compat copy of codegraph_repo_atlas.json

  skills/
    skills_catalog.json
    selected_skills.json
    selected_skill_contents.md

  flash/
    flash_input_manifest.json
    flash_input.md
    flash_system_prompt.md   # resolved flash system prompt text for this run
    flash_prompt_meta.json   # system prompt source metadata (bundled default, user-profile, or project-local override)
    repo_atlas.md            # bounded Repo Atlas passed to the flash model for this run
    task_slice.md            # task-relevant file slice selected for flash context
    relevance_selection.json # relevance/selection metadata for the task slice
    flash_input_budget.json  # context budget allocation for this flash run
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
%LOCALAPPDATA%\vibecodelight\config.yaml   # global provider/model registry (non-secret)
%LOCALAPPDATA%\vibecodelight\.env          # secrets/credentials only
```

Per-repository local workspace config:

```text
<repo>\.vibecode\config.yaml               # local provider/model registry (non-secret)
```

Global and local Vibecode `config.yaml` files hold a **provider/model registry** (which providers exist, which models each provides, and the active flash defaults). They never hold API keys. `.env` holds **credentials only** and is global (never synced into `.vibecode`). Each provider names its key by env-variable NAME via `api_key_env`; the value lives only in `.env`.

Never treat <repo>/config.yaml as Vibecode configuration. The root config.yaml belongs to the target project. VibecodeLight must not create, read, write, or interpret <repo>/config.yaml as Vibecode settings. .vibecode/config.yaml can be initialized or synced from the global config; `<repo>/.vibecode/config.yaml` is the only repo-local Vibecode config path. If root config.yaml appears in context, it is only a target project file, not Vibecode settings. Renderer localStorage is allowed only for pure UI state, not semantic pipeline settings.

Canonical Vibecode config layers:

```text
1. Global user config: %LOCALAPPDATA%/vibecodelight/config.yaml
2. Repo-local Vibecode config: <repo>/.vibecode/config.yaml
3. Per-run options / CLI flags / GUI values
4. Generated run artifacts under <repo>/.vibecode/runs/<run_id>/
5. Renderer localStorage for pure UI state only
```

Global `config.yaml` shape:

```yaml
version: 1

providers:
  lmstudio:
    type: openai-compatible
    label: LM Studio
    base_url: http://127.0.0.1:1234/v1
    api_key_env: LMSTUDIO_API_KEY
    models:
      - id: qwen3.5-9b
        label: Qwen3.5 9B Local
        role: flash

  openrouter:
    type: openai-compatible
    label: OpenRouter
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    models:
      - id: deepseek/deepseek-chat
        label: DeepSeek Chat via OpenRouter
        role: flash
      - id: deepseek/deepseek-reasoner
        role: flash

  deepseek:
    type: openai-compatible
    label: DeepSeek
    base_url: https://api.deepseek.com
    api_key_env: DEEPSEEK_API_KEY
    models:
      - id: deepseek-chat
        role: flash
      - id: deepseek-reasoner
        role: flash

defaults:
  flash:
    provider: openrouter
    model: deepseek/deepseek-chat
    timeout_ms: 30000
    max_tokens: 4096
    temperature: 0.1
```

Provider and model ids are editable config values, not hardcoded — add or rename providers/models freely. LM Studio can be added as provider `lmstudio` under the existing Live mode; there is no separate Local/Cloud GUI mode. LM Studio is just another Live provider backed by the same OpenAI-compatible provider registry/config service. Before setting the LM Studio model id, query the running server and copy the exact returned id (the `qwen3.5-9b` example is editable and may not match every LM Studio model):

```powershell
Invoke-RestMethod http://127.0.0.1:1234/v1/models
```

After editing `%LOCALAPPDATA%\vibecodelight\config.yaml`, sync global → local for this repo:

```powershell
pnpm vibecode config sync --from-global --repo C:\DATA\PROJECTS\VibecodeLight --json
```

For a local live smoke, use the exact model id returned by `/v1/models`:

```powershell
pnpm vibecode prompt "local LM Studio flash smoke" --live --flash-provider lmstudio --flash-model qwen3.5-9b --json
```

`.env` shape (credentials only, referenced by `api_key_env` name):

```text
LMSTUDIO_API_KEY=not-needed
OPENROUTER_API_KEY=...
DEEPSEEK_API_KEY=...
```

Rules:

- The local workspace config takes priority over the global config (providers merge by id with local replacing same-id entries; flash defaults merge field-by-field with local winning).
- When a repo has no `.vibecode/config.yaml`, it is created as a snapshot from the global config (or a minimal registry) at init/config-use time.
- Sync between global and local is explicit (never automatic) and copies the `config.yaml` registry shape only — the `.env` is never copied into `.vibecode`.
- `.vibecode/config.yaml` is local working state inside the ignored `.vibecode/` tree; it is not committed.
- API keys live only in the AppData `.env`. They are never written to committed files, artifacts, diagnostics, logs, or README examples. Secret-looking keys found in any `config.yaml` are ignored with a warning (`api_key_env` is a NON-secret key name and is kept).

Resolution priority for the active flash provider/model and non-secret tuning:

```text
1. explicit CLI flags (--flash-provider / --flash-model)
2. local workspace config (<repo>\.vibecode\config.yaml)
3. AppData global config.yaml
4. otherwise FLASH_PROVIDER_NOT_CONFIGURED / FLASH_MODEL_NOT_CONFIGURED
```

The available provider/model registry comes only from the global user and repo-local Vibecode `config.yaml` files (local then global), never from `<repo>/config.yaml`. The `.env` contributes only the secret value for the selected provider's `api_key_env`:

```text
1. AppData .env (global-env:<NAME>)
2. process environment (process-env:<NAME>)
3. otherwise PROVIDER_API_KEY_ENV_MISSING (no api_key_env) / FLASH_PROVIDER_AUTH_MISSING (no value)
```

Structured config diagnostics: `CONFIG_PROVIDER_NOT_FOUND`, `CONFIG_MODEL_NOT_FOUND`, `PROVIDER_API_KEY_ENV_MISSING`, `FLASH_PROVIDER_AUTH_MISSING`, `FLASH_PROVIDER_NOT_CONFIGURED`, `FLASH_MODEL_NOT_CONFIGURED`, `CONFIG_INVALID_PROVIDER_REGISTRY`. Diagnostics report the provider id, model id, config source/path, and the missing env var NAME — never a secret value.

Config CLI commands (debug/automation; all call the same core service):

```powershell
pnpm vibecode config paths --json
pnpm vibecode config show --json
pnpm vibecode config providers --json
pnpm vibecode config models --json
pnpm vibecode config init-local --repo <path> --json
pnpm vibecode config sync --from-global --repo <path> --json
```

`config paths` shows the global dir, global config, global env, and local config path. `config show` shows the resolved active provider/model, per-field source map, config source (local/global/cli/mixed), per-provider API-key status (configured true/false, by `api_key_env` name), and the global/local paths — never API keys. `config providers` lists all configured providers and whether each has a key; `config models` lists models per provider. `config sync` currently supports only global → local sync and requires `--from-global`; `--to-global` is intentionally rejected with `CONFIG_SYNC_TO_GLOBAL_DISABLED` because per-repo `.vibecode/config.yaml` must not overwrite the global user config. Provider/model can be selected per run: `pnpm vibecode prompt "task" --flash-provider openrouter --flash-model deepseek/deepseek-chat` and `pnpm vibecode flash run latest --flash-provider deepseek --flash-model deepseek-chat`.

Every prompt/flash run records which config was used in a safe, secret-free artifact:

```text
.vibecode/runs/<run_id>/config_resolution.json
```

It records the global/local config and env paths, whether each exists, whether the local config was created from the global one, the selected config source, the selected provider id/label, model id/label, provider type, baseUrl host, the API key env-variable NAME and key source (e.g. `global-env:OPENROUTER_API_KEY` — never the value), the configured provider/model registry, and a per-field source map. The flash run metadata at `flash/flash_output_meta.json` additionally records `provider`, `provider_label`, `model`, `model_label`, `live`, `baseUrl_host`, `config_source`, and `config_resolution_path`, so it is always clear which provider/model and config source were used. No API key value is ever written to either artifact.

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

> Note: this supersedes the earlier rule that the repository-root `config.yaml` is Vibecode-owned config. Root `config.yaml` may still exist in a target repo, but Vibecode treats it only as an ordinary project file.

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
vibecode scan summary --run current --json
vibecode scan artifact-read --run current --artifact commands --json
vibecode prompt "task"
vibecode runs list
vibecode runs show latest
vibecode runs artifact-read --run current --artifact final_prompt --json
vibecode skills list
vibecode skills project-list
vibecode skills copy <skill-id>
vibecode skills copy --all
vibecode coordination status --repo <path> --json
vibecode agents register|list|heartbeat|status|terminate --repo <path> --json
vibecode claims add|list|status|release --repo <path> --json
vibecode claims plan --repo <path> --agent <agent_id> --path <p> --json
vibecode claims add-bulk --repo <path> --agent <agent_id> --intent "<intent>" --path <p> --json
```

`skills list` and `skills project-list` accept `--json`. `skills copy` accepts `--force` to overwrite an existing destination and `--repo <path>` to target a specific repository.

Agent Guidance terminal preflight smoke commands:

```powershell
vibecode agent-guidance preflight --repo <path> --terminal --json
vibecode agent-guidance preflight --repo <path> --terminal --mode check_only --json
vibecode agent-guidance preflight --repo <path> --terminal --mode auto_repair --json
```

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
vibecode config providers
vibecode config models
vibecode config init-local --repo <path>
vibecode config sync --from-global --repo <path>
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
pnpm vibecode prompt "task" --mock --auto-approve
pnpm vibecode prompt "task" --mock --agent <agent_id> --agent-mode mcp
pnpm vibecode prompt render latest --agent <agent_id> --agent-mode cli
pnpm vibecode runs list
pnpm vibecode runs show latest
pnpm vibecode runs show latest --json
pnpm vibecode runs show latest --artifact codegraph
pnpm vibecode runs show latest --artifact scan/codegraph_repo_atlas.md
```

`prompt --mock` writes scan, skills, flash, context, and `output/final_prompt.md` artifacts. By default it does not send anything to a terminal, so no `terminal/send_metadata.json` is created. Adding `--auto-approve` sends the saved `output/final_prompt.md` into a terminal without a separate approval step and writes `terminal/send_metadata.json` with `auto_approve: true` (still no `after/` post-run artifacts). The artifact is the truth — the exact rendered file is what is sent. For CodeGraph-derived Repo Atlas artifacts, the canonical scan paths are `scan/codegraph_repo_atlas.md` / `scan/codegraph_repo_atlas.json`; the legacy compatibility aliases `scan/repo_atlas.md` / `scan/repo_atlas.json` are also written.

Optional multi-agent coordination (advisory): pass `--agent <agent_id>` (with optional `--terminal-session <id>` and `--agent-mode mcp|cli|unknown`) to `prompt` or `prompt render` to bind the run to a registered agent. The binding is stored as a per-run artifact `runs/<id>/coordination/agent_binding.json` (never in `run_manifest.json`), and the renderer adds a visible `# Multi-Agent Coordination` section to `output/final_prompt.md` that lists the agent's own claims, files claimed by other active agents, and mode-specific reminders (MCP `vibecode_claim_*` tools for `mcp`, `vibecode claims …` CLI commands for `cli`/`unknown`). An unknown `--agent` returns a structured `AGENT_NOT_FOUND` error; an invalid `--agent-mode` returns `INVALID_AGENT_MODE`. Coordination is read-only here (the block reflects existing state); claims are still created/released explicitly via the `vibecode claims …` commands or the MCP coordination tools. Without `--agent`, no binding is written and no coordination block is added.

`runs show` includes a first-class CodeGraph summary (`used for context`, reason, Repo Atlas status, warnings, and available `scan/` artifacts). The same structured `codegraph` object is present in `runs show --json`; `--artifact codegraph` prints `scan/codegraph_usage.json` for agent assertions without Electron.

### Optional Task Normalizer

Task Normalizer is an optional, off-by-default feature that translates and expands the user task into English technical search hints before context selection. It does **not** select files, does not invent repository symbols, and is not a source of truth for relevance.

- When enabled, it writes `.vibecode/runs/<run_id>/task_intent.json` and `task_intent.md`. The task intent contains the normalized English task, search hints, keyword groups, constraints, and validation hints.
- When disabled, it still writes a deterministic disabled artifact (`enabled: false`).
- If the normalizer fails, the pipeline continues with the raw task. The failure is recorded in the artifact (`ok: false`, `source: "fallback"`).
- **Not a file selector.** The normalizer produces linguistic/task-intent signals only — no relevant files, no exact source paths, no implementation plan.
- The python scanner receives expanded search signals via `scanner_config.json` (normalized English task, search hints, keyword groups).
- Flash compaction and `task_slice.md` surface selection reasons from normalized task terms.
- CodeGraph queries use the enriched English task when the normalizer runs successfully.
- `flash_input.md` includes a visible **Task Intent** section showing the normalized English task, search hints, and constraints.

Opting in is per-build and explicit. CLI remains explicit: `vibecode prompt --task-normalizer` or `vibecode prompt --no-task-normalizer` (and the matching `context-build` variants). Desktop: the **Task Normalizer** toggle in the composer header (ON = enabled, OFF = disabled) remembers the last GUI choice in global user config at `%LOCALAPPDATA%/vibecodelight/config.yaml` under `desktop.task_normalizer.enabled`; this Desktop GUI preference is not a CLI default.

The normalizer uses the flash LLM provider for inference. By default (disabled), no LLM call is made and no cost is incurred. Default tests use a mock normalizer — no live provider calls.

### Optional Task Normalizer CLI

```powershell
pnpm vibecode prompt "task" --task-normalizer                  # enable task normalizer
pnpm vibecode prompt "task" --no-task-normalizer               # disable (default)
pnpm vibecode context-build "task" --task-normalizer
pnpm vibecode context-build "task" --no-task-normalizer
pnpm vibecode runs show latest --artifact task-intent          # read task_intent.json
```

`runs show latest` includes a Task Normalizer summary (enabled, ok status, detected language, normalized English task, search hints, warnings) in both human and `--json` output when `task_intent.json` is present.

### Optional CodeGraph CLI

CodeGraph is optional and stays detect-only by default. Both the per-build mode and the maintenance actions are reachable from the CLI without Electron, with stable JSON envelopes for agent use.

Per-build mode selection (mutually exclusive — conflicting flags return a structured `CONFLICTING_CODEGRAPH_FLAGS` error):

```powershell
pnpm vibecode prompt "task" --codegraph                       # use-existing
pnpm vibecode prompt "task" --no-codegraph                    # detect-only (default)
pnpm vibecode prompt "task" --codegraph-mode use-existing
pnpm vibecode prompt "task" --codegraph-mode detect-only
pnpm vibecode context-build "task" --codegraph-mode use-existing
pnpm vibecode context-build "task" --codegraph-mode detect-only
```

Transport setting (settings-driven, not a per-prompt flag):

```powershell
pnpm vibecode codegraph transport get --json
pnpm vibecode codegraph transport set cli|mcp|auto
pnpm vibecode codegraph transport reset --json
```

CodeGraph Transport is a shared global setting. GUI dropdown and CLI command both read/write the global user config (`%LOCALAPPDATA%/vibecodelight/config.yaml`, or the equivalent platform user config path) as `defaults.codegraph.transport`; unset or invalid values resolve to `cli` (default = cli). Desktop uses the same **CodeGraph Transport: CLI / MCP / Auto** semantic setting by calling the desktop config bridge, so the GUI remembers the setting by using global config, not localStorage. prompt-level transport flags are intentionally not the primary UX; CLI `prompt` and `context-build` consume the persisted setting when CodeGraph mode is `use-existing`.

When `use-existing` is selected, the pipeline queries the existing CodeGraph index read-only and writes `scan/codegraph_usage.json`, `scan/codegraph_context.md`, and the CodeGraph-derived Repo Atlas artifacts. Transport behavior: `cli` uses the existing CLI adapter; `mcp` is strict (uses `codegraph serve --mcp` + `codegraph_context` and does not fall back); `auto` prefers MCP and falls back to CLI on MCP failure, recording `fallback_used: true`. `detect-only` never calls CodeGraph context through CLI or MCP regardless of transport. Neither prompt nor context-build ever runs `codegraph init`, `index`, `sync`, `watch`, or `serve` except that strict/auto MCP context may spawn `codegraph serve --mcp` solely for context.

Verify MCP exposure and transport use with:

```powershell
pnpm vibecode codegraph mcp self-test --repo <path> --json
pnpm vibecode context-build "task" --codegraph-mode use-existing --json
pnpm vibecode runs show latest --artifact codegraph
```

Maintenance namespace (explicit, never automatic):

```powershell
pnpm vibecode codegraph status   --repo <path> [--json]
pnpm vibecode codegraph init     --repo <path> [--json]
pnpm vibecode codegraph sync     --repo <path> [--json]
pnpm vibecode codegraph reindex  --repo <path> [--json]
```

`status` is read-only (uses `codegraph --version` and an `fs.existsSync` check on `.codegraph/`). In `--json` mode it preserves adapter fields such as `available`, `initialized`, `version`, and `binary`, and also reports the shared derived CodeGraph status view (`state`, `label`, `displayWarnings`, `usageNote`, `usedForContext`). `init`, `sync`, and `reindex` are thin wrappers around `codegraph init -i`, `codegraph sync`, and `codegraph index --force`; failures return a structured `CODEGRAPH_<ACTION>_FAILED` envelope. These are the same operations the desktop composer's CodeGraph buttons trigger.

Agent-facing read-only query namespace (provider-agnostic shell tools):

```powershell
pnpm vibecode codegraph search   "<query>"            --repo <path> [--max-results <n>] [--json]
pnpm vibecode codegraph context  "<query>"            --repo <path> [--max-nodes <n>] [--max-code <n>] [--json]
pnpm vibecode codegraph files                         --repo <path> [--limit <n>] [--json]
pnpm vibecode codegraph callers  "<symbol>"           --repo <path> [--limit <n>] [--json]
pnpm vibecode codegraph callees  "<symbol>"           --repo <path> [--limit <n>] [--json]
pnpm vibecode codegraph impact   "<path-or-symbol>"   --repo <path> [--limit <n>] [--json]
```

These wrap the verified read-only upstream subcommands (`query`, `context`, `files`, `callers`, `callees`, `impact`). They are provider-agnostic: any terminal agent (Claude Code, Codex, Hermes, opencode, or anything else that can run a shell command) can invoke them. They are **not** native MCP tools, and they are **not** a Vibecode-owned MCP server. Native MCP integration remains optional future work. The commands are strictly read-only — they never run `codegraph init`, `sync`, `index`, `watch`, or `serve`, never create `.codegraph/`, never mutate the repository, and never call an LLM provider. If CodeGraph is missing or the repository is not initialized, they return a structured `CODEGRAPH_NOT_INSTALLED` / `CODEGRAPH_NOT_INITIALIZED` envelope that points to the explicit maintenance commands above. Use `rg`/`grep` for exact text and error messages; use these commands for structural symbol search, call relationships, and impact analysis.

### VibecodeMCP server (v1)

VibecodeLight now exposes its **own** native Model Context Protocol server: a repo-bound stdio process that any MCP-capable agent (Claude Code, Codex, OpenCode, Hermes, anything that speaks MCP) can connect to. It is distinct from upstream CodeGraph's MCP server (`codegraph serve --mcp`) — VibecodeMCP is a Vibecode-owned protocol adapter that calls the same internal core services the CLI calls. Provider-agnostic by construction: no provider SDK ever crosses the MCP boundary.

Start the server:

```powershell
pnpm vibecode mcp serve --repo C:\DATA\PROJECTS\YourRepo
pnpm vibecode mcp serve --repo C:\DATA\PROJECTS\YourRepo --codegraph-transport mcp
pnpm vibecode mcp serve --repo C:\DATA\PROJECTS\YourRepo --codegraph-bin C:\Tools\codegraph.exe
pnpm vibecode mcp serve --repo C:\DATA\PROJECTS\YourRepo --log-level silent
```

`--repo` is required and the resolved path is bound to the server for its lifetime. Tools never accept a `repo` argument. stdout is reserved for the MCP JSON-RPC stream; human/diagnostic logs go to stderr (controlled by `--log-level info|warn|silent`) and per-call usage rows go to `<repo>/.vibecode/logs/mcp_tool_usage.jsonl` as bounded, secret-free JSONL.

VibecodeMCP v1 is a breaking public tool contract cleanup. The server exposes
exactly **14 public MCP tools**; old phase-era MCP tool names are not listed,
not callable, and not kept as public aliases. Existing CLI/operator commands may
remain for human use, but agents should use the v1 MCP names below.

VibecodeMCP v1 scope:

- transport: **stdio only**;
- read-only tools are read-only; build tools write only generated coordination
  state under `.vibecode/coordination`;
- bound to a **single repo** at startup;
- tools call existing core services in-process (no shell-out, no CLI text parsing);
- `vibecode_build_finish` returns commit-guard guidance but **does not commit**.

Public MCP tools:

```text
vibecode_session_start
vibecode_workspace_snapshot
vibecode_project_instructions
vibecode_run_status
vibecode_artifact_read
vibecode_changes
vibecode_codegraph_search
vibecode_codegraph_explore
vibecode_codegraph_callers
vibecode_codegraph_impact
vibecode_build_start
vibecode_build_scope
vibecode_build_finish
vibecode_handoff
```

Start an MCP-capable agent with `vibecode_session_start`, then call
`vibecode_workspace_snapshot`. Build work requires `mode: "build"` and an
explicit `vibecode_build_start` claim for exact paths before editing. Restart or
reconnect already-running MCP clients after changing the server contract or MCP
configuration.

MCP-capable agents should prefer these VibecodeMCP v1 tools over shelling out to
grep/find for repo navigation or opening `.vibecode/runs/...` files by hand.
Agents without MCP support should fall back to the equivalent `vibecode codegraph ...`,
`vibecode runs ...`, `vibecode scan ...`, `vibecode git changes`, `vibecode session ...`,
`vibecode claims ...`, `vibecode finalize ...`, `vibecode handoff ...`, and
`vibecode commit guard` CLI commands. Both paths call the same Vibecode core
services.

The v1 MCP surface intentionally does not expose old phase-era public MCP tool
names, resources, worktrees, terminal write, shell exec, source file write, git
commit, arbitrary file read, or upstream CodeGraph maintenance tools. CodeGraph
maintenance (`init`/`sync`/`index`/`watch`) remains explicit CLI/Desktop work.
List them without starting the server:

```powershell
pnpm vibecode mcp tools
pnpm vibecode mcp tools --json
```

Each tool returns both a `content` text block (model-friendly Markdown, bounded) and a `structuredContent` envelope (`ok`, `tool`, `repo_root`, `command`, `warnings`, `truncated`, `duration_ms`, `data`, or `error` with stable codes: `CODEGRAPH_NOT_INSTALLED`, `CODEGRAPH_NOT_INITIALIZED`, `CODEGRAPH_QUERY_FAILED`, `INVALID_ARGUMENT`, `MCP_TOOL_TIMEOUT`, `OUTPUT_TRUNCATED`, `UNSUPPORTED_TOOL`, `REPO_NOT_FOUND`, `REPO_NOT_A_DIRECTORY`).

Install VibecodeMCP for Codex without manually editing Codex config:

```powershell
pnpm vibecode mcp config --agent codex --repo C:\DATA\PROJECTS\YourRepo --print
pnpm vibecode mcp config --agent codex --repo C:\DATA\PROJECTS\YourRepo --json
pnpm vibecode mcp install --agent codex --repo C:\DATA\PROJECTS\YourRepo --dry-run
pnpm vibecode mcp install --agent codex --repo C:\DATA\PROJECTS\YourRepo --yes
pnpm vibecode mcp doctor --agent codex --repo C:\DATA\PROJECTS\YourRepo --json
```

Default scope is Codex user config (`$CODEX_HOME/config.toml`, or
`~/.codex/config.toml` when `CODEX_HOME` is unset). Project scope is explicit:
add `--scope project` to target `<repo>/.codex/config.toml`; Codex only loads
project config for trusted projects. Install preserves unrelated Codex settings,
updates only `[mcp_servers.vibecode]`, creates a backup before writing an
existing config, and never writes secrets. Restart or reload Codex after
install; inside the Codex TUI, use `/mcp` to inspect the active server.

Install VibecodeMCP for Claude Code without manually editing Claude config:

```powershell
pnpm vibecode mcp config --agent claude --repo C:\DATA\PROJECTS\YourRepo --print
pnpm vibecode mcp config --agent claude --repo C:\DATA\PROJECTS\YourRepo --json
pnpm vibecode mcp install --agent claude --repo C:\DATA\PROJECTS\YourRepo --dry-run --json
pnpm vibecode mcp install --agent claude --repo C:\DATA\PROJECTS\YourRepo --yes --scope local --json
pnpm vibecode mcp doctor --agent claude --repo C:\DATA\PROJECTS\YourRepo --json
```

Claude support uses Claude Code MCP config through `claude mcp add-json`.
The default scope is local, which keeps the repo-bound VibecodeMCP server
private to this user/project. `--scope user` makes the same repo-bound server
available across projects; `--scope project` writes project-shared MCP config
and may trigger Claude project-server approval/trust behavior for `.mcp.json`.
Vibecode does not manage Claude MCP approvals. Claude Code applies its own
approval/permission settings, and the installer does not edit
`.claude/settings.json`, allowedTools/deniedTools, hooks, or Claude permission
profiles.

Install VibecodeMCP for OpenCode:

```powershell
pnpm vibecode mcp config --agent opencode --repo C:\DATA\PROJECTS\YourRepo --print
pnpm vibecode mcp config --agent opencode --repo C:\DATA\PROJECTS\YourRepo --json
pnpm vibecode mcp install --agent opencode --repo C:\DATA\PROJECTS\YourRepo --dry-run --json
pnpm vibecode mcp install --agent opencode --repo C:\DATA\PROJECTS\YourRepo --yes --json
pnpm vibecode mcp doctor --agent opencode --repo C:\DATA\PROJECTS\YourRepo --json
```

OpenCode support patches `opencode.json` directly (JSON). The default scope is
`project` (writes `<repo>/opencode.json`); `--scope user` writes to
`~/.config/opencode/opencode.json`. OpenCode merges project config with global
config; project keys override conflicting global keys. The installer preserves
unrelated OpenCode config keys, creates timestamped backups of existing files,
and rejects JSONC (comments) with a clear diagnostic. Vibecode does not manage
OpenCode approvals or permissions.

Anti-scope for MCP-1 (intentionally **not** exposed):

- HTTP transport, multi-repo workspace registry;
- broad auto-write to external agent configs;
- terminal write / shell exec / file write / git commit tools;
- arbitrary file read; arbitrary repo path arguments on tools;
- upstream CodeGraph maintenance (`init`/`sync`/`index`/`watch`) — those remain explicit CLI/Desktop actions.

The installer adds no write/shell/git/terminal tools for source files or
terminal/git mutation; Coordination-3A claim tools only mutate generated
advisory state under `.vibecode/coordination/state.json`.

Agents with MCP support use VibecodeMCP tools. Agents without MCP support use the equivalent `vibecode codegraph ...` CLI commands above. Both paths call the same Vibecode core/adapters.

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
pnpm test:pty
pnpm lint
pnpm typecheck
pnpm build
```

`pnpm test` runs the full Vitest suite (parallel by default). `pnpm test:serial` runs the same suite with `--fileParallelism=false` and is available as a fallback if the parallel run shows flakiness on a given Windows ConPTY/node-pty environment.

The default suite uses a mocked PTY adapter and never spawns a real terminal. The real-ConPTY smoke tests are opt-in via `pnpm test:pty` (which sets `VIBECODE_PTY_INTEGRATION=1`). They are gated out of the default run because node-pty's vendored console-list agent crashes with `AttachConsole failed` on Node >= 24 under Windows, which can otherwise destabilize the full suite.

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
# no dedicated pnpm live-test script currently
pnpm test -- <specific-test-file>
uv run pytest -m live
```

There is currently no dedicated live-test pnpm script in `package.json`. For provider-backed/manual live checks, configure real API keys in `%LOCALAPPDATA%\vibecodelight\config.yaml` + `.env` and run targeted Vitest files manually with `pnpm test -- <specific-test-file>` (or run targeted `pnpm vibecode prompt ... --live ...` smoke commands). Live tests should be token-efficient.

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

### Terminal agent protocol banner

When the desktop opens a new terminal, it prints a short, one-time **agent protocol banner** to the terminal display (Phase 1B-4). The banner is guidance only — it tells a fresh agent to start with MCP `vibecode_session_start`, then `vibecode_workspace_snapshot`; the CLI fallback is `vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json`. It reminds build agents to use `vibecode_build_start` before editing, `vibecode_changes` during work, and `vibecode_build_finish` plus CLI `vibecode commit guard` before committing. It says not to push unless explicitly asked. It is **display-only** (never written into the PTY/shell stdin), never registers an agent, infers a mode, runs the scanner, or mutates state, and never pollutes JSON CLI output. Set `VIBECODE_AGENT_BANNER=0` to silence it.

The desktop app should provide:

- a real embedded PTY terminal; currently implemented in the checkpoint shell;
- a prompt composer overlay (preview only in this checkpoint);
- final prompt preview;
- prompt send into the active terminal;
- run artifact visibility;
- a VibecodeMCP panel (left nav) showing per-agent MCP status for Claude, Codex, and OpenCode, with read-only doctor/dry-run/install controls and a registry-loaded MCP Tool Catalog / Agent Contract viewer.

### VibecodeMCP Tool Catalog

The VibecodeMCP panel includes a read-only tool catalog loaded through the desktop bridge from the app MCP registry, schema definitions, and tool profile metadata. The renderer does not keep a hardcoded tool list.

The catalog shows the current registry-derived tool count, search and filters, side-effect classification, input schema, output contract summary ("what the agent receives"), CLI equivalents where available, profiles that include the tool, safety notes, and source/test pointers for maintainers. Output contracts are concise summaries of the `structuredContent` shape and important fields; they are not full live response examples unless a tool explicitly supplies one.

This UI is visibility only. It does not run MCP tools, does not orchestrate agents, does not mutate source files, git, or coordination state, and does not transfer ownership.

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

### Settings (tabbed)

The desktop Settings overlay now ships a tabbed layout:

```text
Flash · CodeGraph · MCP · Agent Guidance · Terminal · Advanced
```

The Flash tab preserves the existing Flash provider/model controls. The MCP tab shows the canonical VibecodeMCP tool inventory (read-only) grouped into workspace orientation, CodeGraph, runs/artifacts, and coordination, plus Agent Guidance enabled/source/hash status. The richer VibecodeMCP left-nav panel shows the full registry-loaded tool catalog and agent contract viewer. The Agent Guidance tab edits a dedicated, separate config layer described below and shows safe Claude/Codex integration status/apply controls plus Terminal Agent Preflight policy. The CodeGraph and Advanced tabs are placeholders in this slice.

### Agent Guidance (Settings)

Agent Guidance is a *separate* settings layer for terminal-agent guidance. It is **not** stored in the root `config.yaml` and **not** stored in `.vibecode/config.yaml`. It lives in a dedicated YAML file under the user profile directory:

```text
%LOCALAPPDATA%/vibecodelight/agent-guidance-config.yaml
```

Boundaries enforced by this slice:

- Agent Guidance is inspectable, editable, resettable, enable/disable-able from the Settings UI.
- MCP exposes Agent Guidance through VibecodeMCP. `vibecode_mcp_guidance` returns the effective guidance from `%LOCALAPPDATA%/vibecodelight/agent-guidance-config.yaml`, including per-tool notes, source, config path, and `guidance_hash`. MCP server instructions and bounded tool-description suffixes tell agents to call `vibecode_mcp_guidance` at session start.
- This slice does NOT inject hidden text into the PTY. The exact contents of `output/final_prompt.md` are still what Vibecode sends into the terminal — no hidden suffix is appended after the composer preview.
- This slice does NOT modify `final_prompt.md` after preview.
- This slice does NOT mutate Claude/Codex/OpenCode/Hermes approvals or permissions, does NOT edit `allowedTools`/`deniedTools`, and does NOT add hooks or permission profiles.
- `vibecode agent-guidance status --agent claude --repo <path> --json` and `vibecode agent-guidance status --agent codex --repo <path> --json` and `vibecode agent-guidance status --agent opencode --repo <path> --json` report config validity, source, `guidance_hash`, expected MCP tool count, and whether the agent-side VibecodeMCP config appears current.
- Claude MCP config may be detected from more than one safe config source. The Claude status detector reads (read-only) `<repo>/.mcp.json` (project scope), the per-project `mcpServers` map in `~/.claude.json` (local scope, what `claude mcp add-json --scope local` writes), and the top-level `mcpServers` map in `~/.claude.json` (user scope). When the server is found it reports `configured: true` with `mcp.status` (`up_to_date` when the detected command/repo binding match this repo's `bin/vibecode.js mcp serve --repo <path>`, otherwise `stale`), plus `mcp.source` (the effective scope) and `mcp.source_path`. `unknown` is reported only when no recognized config source exists. If multiple sources exist, local takes precedence over project over user, and every recognized source is listed under `mcp.sources`. Detection never mutates Claude config and never reads or changes approvals/permissions.
- `vibecode agent-guidance apply --agent claude --repo <path> --dry-run --json` and `vibecode agent-guidance apply --agent codex --repo <path> --dry-run --json` and `vibecode agent-guidance apply --agent opencode --repo <path> --dry-run --json` preview the safe MCP config action. `--yes` is required to write/update the existing VibecodeMCP server config. Apply means new MCP sessions can read the dedicated guidance config through VibecodeMCP; it does not write prompt text to terminal, root repo files, `AGENTS.md`, `CLAUDE.md`, or approval/permission settings.
- Terminal Agent Preflight runs when opening new Vibecode terminals. It ensures supported agents have VibecodeMCP configured according to Settings policy, defaults to `check_only`, and can use `auto_repair` only for the same safe MCP config surface as `agent-guidance apply --yes`.
- The user still starts codex/claude manually. There is no Start Codex button and no Start Claude button, no hidden PTY/stdin injection, no Composer final_prompt.md mutation, and no approval/permission mutation.
- `vibecode agent-guidance preflight --repo <path> --terminal --json` runs the same check without opening a terminal; add `--mode check_only` or `--mode auto_repair` to override the configured mode for smoke testing.
- Restart/reconnect an already running Claude/Codex MCP session after changing guidance or applying MCP config.
- Writing guidance into agent-native instruction files (CLAUDE.md, AGENTS.md, Codex prompts, etc.) remains out of scope.

Terminal preflight settings live in the same dedicated Agent Guidance file:

```yaml
terminal_preflight:
  enabled: true
  mode: check_only
  supported_agents:
    codex: true
    claude: true
  repair:
    create_backup: true
    require_valid_guidance_config: true
```

If the dedicated config file is missing, Settings shows defaults loaded from built-in defaults. If the YAML is invalid, Settings shows a structured diagnostic and leaves the file untouched so the user can fix it by hand.

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
