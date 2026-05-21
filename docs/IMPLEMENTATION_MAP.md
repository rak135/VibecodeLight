# VibecodeLight Implementation Map

This document defines the implementation sequence, checkpoints, required tests, produced artifacts, and success criteria for VibecodeLight.

It is not a feature wishlist. It is the build path for a small, inspectable, modular application whose core purpose is:

- run a real terminal inside the workspace;
- build a reproducible context package for every model prompt;
- use deterministic Python scanners to gather repo facts;
- use a flash model to compress and select relevant context;
- render a transparent final prompt;
- send exactly that prompt into the real terminal;
- preserve every run as debuggable artifacts;
- create a deterministic git commit for every model run.

The implementation must stay modular. Each checkpoint should leave the repository in a usable, testable state.

---

## Authority

`ARCHITECTURE_DECISIONS.md` is the implementation contract and source of truth for concrete implementation decisions.

This document defines implementation order and success criteria.

If this document conflicts with `ARCHITECTURE_DECISIONS.md` on concrete implementation details, `ARCHITECTURE_DECISIONS.md` wins.

`AGENTS.md` is the operational guide for agents.

---

## Core implementation principles

### Build in strict order

Each checkpoint depends on the previous ones.

The intended progression is:

```text
repository baseline
→ CLI and core debug path
→ workspace initialization
→ run package store
→ Python scanner CLI skeleton
→ base deterministic scan artifacts
→ manifest/dependency/command/environment scan
→ docs/instructions scan
→ code map scan
→ skills catalog and project snapshot
→ flash input builder
→ Markdown flash output contract
→ flash model adapter and read-only tools
→ context pack and selected skills expansion
→ final prompt renderer
→ full CLI dogfood
→ real PTY terminal
→ Electron shell
→ composer preview
→ send final prompt into terminal
→ transcript and post-run state
→ per-run commit workflow
→ real repo dogfood
→ multi-terminal readiness
```

The first reliable product is not the desktop app. The first reliable product is the CLI/core path that can produce a reproducible `final_prompt.md` without Electron.

### Use test-driven development

Implementation should follow RED-GREEN-REFACTOR.

For each behavior:

```text
1. Write the failing test first.
2. Run it and verify the failure is caused by missing behavior.
3. Implement the smallest code needed to pass.
4. Run the focused test and verify it passes.
5. Run the relevant broader suite.
6. Refactor only while tests stay green.
```

This applies especially to:

- CLI behavior;
- run artifact creation;
- scanner output formats;
- validation schemas;
- Markdown flash output parsing;
- prompt rendering;
- skills catalog behavior;
- terminal send metadata;
- post-run git/check artifacts;
- per-run commit behavior;
- document/JSON/YAML format changes.

Default tests must not call live model providers.

Live model calls are allowed only through explicit live test commands:

```powershell
pnpm test:live
uv run pytest -m live
```

Live tests should be token-efficient.

### Keep the core independent of the UI

The core pipeline must run from CLI without Electron.

Good dependency direction:

```text
app/desktop -> core -> adapters
app/cli     -> core -> adapters
```

Bad dependency direction:

```text
core -> app/desktop
scanner -> UI state
prompt renderer -> terminal widget
```

The Electron shell may display and trigger actions, but it must not own scanner logic, context logic, skills logic, run persistence, prompt rendering, or model-provider logic.

### TypeScript owns orchestration

TypeScript owns:

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
context assembly
prompt rendering
PTY/terminal integration
desktop shell
JSON schema validation boundary
per-run commit workflow orchestration
```

### Python owns deterministic scanning

Python owns:

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

RunStore creates and authorizes the scan output directory.

Python may write only inside that provided scan output directory:

```text
.vibecode/runs/<run_id>/scan/
```

All non-scan `.vibecode/` writes go through RunStore directly.

### Do not hide prompts

The final prompt must be stored before it is sent.

Default behavior:

```text
user prompt
→ new run package
→ deterministic scan
→ flash input
→ Markdown flash output
→ selected skills
→ context_pack.md
→ final_prompt.md
→ preview
→ send exact final_prompt.md into terminal
```

Auto-approve may exist, but even in auto-approve mode, `final_prompt.md` must be written before send and the send metadata must identify the exact file that was sent.

### Every prompt creates a new run package

Every model prompt creates a new run under:

```text
.vibecode/runs/<run_id>/
```

`.vibecode/current/` mirrors or points to the latest important run artifacts.

The run package is the audit trail. If a run cannot explain what happened, the implementation is not done.

### `.vibecode/` is generated

`.vibecode/` is a generated VibecodeLight working directory.

Rules:

- it must be added to `.gitignore` during initialization;
- it must not be scanned as part of the target repo;
- it stores run artifacts, current artifacts, logs, and generated working data;
- humans may inspect it for debugging;
- source skills do not live inside `.vibecode/`;
- generated `.vibecode/` artifacts are not committed.

### `SKILLS/` is the project skills snapshot

Skills are primarily managed in the user profile.

When explicitly copied into a project, they are copied to:

```text
SKILLS/
```

This copy is a snapshot, not automatic sync.

Whether `SKILLS/` is committed or ignored is controlled by project policy/config. The architecture must support both.

### Flash tools are read-only

The flash model may use tools while preparing the context pack.

Initial read-only tools:

```text
read_file(path)
list_dir(path)
read_artifact(name)
search_text(query)
```

Tool calls must be logged.

The flash model must not write to the repo, mutate run artifacts, or modify `SKILLS/`.

### Markdown-first flash output

The initial flash output contract is Markdown-first.

Canonical initial artifact:

```text
.vibecode/runs/<run_id>/flash/flash_output.md
```

It must use stable sections:

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

Future structured JSON flash output is allowed later, but it is not the initial implementation contract.

If JSON mode is later introduced, `flash_output.json` must be schema-validated before use.

### Preserve provenance

Important facts sent to the flash model or main model should include source metadata where practical:

```json
{
  "fact": "Project uses pytest.",
  "source": {
    "path": "pyproject.toml",
    "section": "tool.pytest"
  }
}
```

The scanner provides facts and evidence. The flash model performs selection, compression, and cautionary interpretation.

### Per-run git commit

Each model run is expected to create a deterministic git commit that captures the run result.

If tests or validation fail, the run/commit must clearly mark the failed validation state.

Generated `.vibecode/` artifacts are not committed.

The commit captures repository changes, not VibecodeLight runtime artifacts.

Later UI/CLI should provide a way to revert changes from a run.

---

## Reference repository shape

The implementation should follow this structure:

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

The important part is not only the folder names. The important part is that scanner, run store, flash input builder, prompt renderer, LLM adapter, PTY adapter, CLI, Electron shell, and git commit workflow remain separate modules.

---

## Public and debug CLI surfaces

### Public/stable CLI

```powershell
vibecode init
vibecode scan "task"
vibecode prompt "task"
vibecode runs list
vibecode runs show latest
vibecode skills list
vibecode skills copy <skill-id>
```

### Debug/internal CLI

```powershell
vibecode doctor
vibecode run create "task"
vibecode context-build "task"
vibecode flash validate <path>
vibecode flash run latest
vibecode terminal demo
```

### Internal scanner CLI

```powershell
vibecode-scan --help
vibecode-scan --repo . --task "task"
python -m vibecode_scanner --repo . --task "task"
```

Agent-facing commands should support `--json` where relevant.

---

## Canonical run artifact layout

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

`.vibecode/current/` is a convenience mirror/pointer only:

```text
.vibecode/current/
  run_manifest.json
  context_pack.md
  final_prompt.md
  selected_skills.json
  send_metadata.json   # only after send
```

Historical truth lives in `.vibecode/runs/<run_id>/`.

---

## Development commands

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

Some commands may not exist in the earliest scaffold. When unavailable, the implementation report must say so clearly.

---

# Checkpoint: Repository baseline and documentation alignment

## Purpose

Prepare the repository for implementation by aligning documentation, baseline project files, and git hygiene.

This checkpoint is documentation and repository setup only. It does not implement application functionality.

## Implement

- Ensure root `README.md` exists.
- Ensure root `AGENTS.md` exists.
- Ensure docs exist:
  - `docs/VISION.md`
  - `docs/CONTEXT.md`
  - `docs/ARCHITECTURE.md`
  - `docs/IMPLEMENTATION_MAP.md`
  - `docs/ARCHITECTURE_DECISIONS.md`
- Ensure root `.gitignore` exists and ignores generated/local state.
- Ensure root `config.yaml` exists as the human-maintained project config.
- Ensure documentation agrees on:
  - TypeScript/Python ownership;
  - canonical repo layout;
  - public/debug CLI split;
  - `.vibecode/` generated state;
  - `config.yaml`, `scanner_config.json`, and `scan/config_snapshot.json`;
  - Markdown-first `flash_output.md`;
  - TypeScript-owned skills catalog;
  - `terminal/` vs `after/` artifact layout;
  - per-run commit policy;
  - test command naming.

## CLI surface

No functional CLI is required yet.

## Produced files

Expected baseline files:

```text
README.md
AGENTS.md
config.yaml
.gitignore
docs/VISION.md
docs/CONTEXT.md
docs/ARCHITECTURE.md
docs/IMPLEMENTATION_MAP.md
docs/ARCHITECTURE_DECISIONS.md
```

## Required tests/checks

This checkpoint is mostly documentation, but it still needs checks.

Suggested checks:

- Search docs for obsolete `preflight.json`.
- Search docs for obsolete `.vibecode/config.json`.
- Search docs for obsolete top-level Python layout.
- Search docs for obsolete `npm run test:real-llm`.
- Search docs for initial `flash_output.json` requirements.
- Search docs for `scan/config.json` and replace with `scan/config_snapshot.json`.
- Inspect `git diff`.
- Confirm `.vibecode/` and `.venv/` are ignored.
- Confirm no implementation scaffold was added.

## Success criteria

- All planning docs agree on the same implementation contract.
- `ARCHITECTURE_DECISIONS.md` is clearly the source of truth for implementation decisions.
- `AGENTS.md` is clearly the operational guide.
- Root `config.yaml` exists.
- `.gitignore` exists and ignores `.vibecode/`, `.venv/`, `node_modules/`, build outputs, logs, and environment files.
- No `.venv` is created.
- No application scaffold is added yet.
- The repository can be committed as a clean documentation/baseline checkpoint.

---

# Checkpoint: Repository scaffold and developer baseline

## Purpose

Create the repository skeleton, test setup, package scripts, and initial CLI/scanner entrypoints so the project can grow without turning into a single-file mess.

## Implement

- TypeScript package scaffold.
- Electron/TypeScript shell folders.
- TypeScript core/adapters/CLI folders.
- Python scanner package workspace under `src/core/scanning/python/`.
- Test runner setup for TypeScript and Python.
- Basic lint/format/typecheck commands where practical.
- Basic TypeScript CLI entrypoint.
- Basic Python scanner CLI entrypoint.
- Basic docs/dev command references.

## CLI surface

```powershell
vibecode --help
vibecode doctor
vibecode-scan --help
python -m vibecode_scanner --help
```

## Produced files/artifacts

Repository source scaffold:

```text
package.json
pnpm-workspace.yaml if needed
tsconfig.json
vitest config
eslint/prettier config if selected
src/app/desktop/
src/app/cli/
src/core/
src/adapters/
src/core/scanning/python/pyproject.toml
src/core/scanning/python/vibecode_scanner/
tests/
schemas/
```

No `.vibecode` run artifacts are required yet.

## Required tests

Write tests before implementation.

Suggested tests:

- TypeScript CLI help smoke test.
- TypeScript package import/build smoke test.
- Python scanner package import smoke test.
- Python scanner CLI help smoke test.
- TypeScript typecheck smoke test.
- Basic module-boundary test if practical.

## Success criteria

- Project installs or boots in the chosen development mode.
- `vibecode --help` works.
- `vibecode doctor` exists, even if it only reports basic environment facts.
- `vibecode-scan --help` works.
- TypeScript and Python test commands run.
- Core, adapters, CLI, desktop app, and Python scanner areas are visibly separated.
- No UI module owns core scanning or prompt-building logic.

---

# Checkpoint: Workspace initialization

## Purpose

Allow VibecodeLight to initialize the selected repository as a workspace.

## Implement

- Repo root detection.
- `config.yaml` creation or loading.
- `config.yaml` preservation.
- `.vibecode/` directory creation.
- `.vibecode/runs/` and `.vibecode/current/` creation.
- `.vibecode/` insertion into `.gitignore` during initialization.
- `SKILLS/` status detection.
- Workspace path model.
- Structured CLI diagnostics.

## CLI surface

```powershell
vibecode init
vibecode doctor
```

## Produced artifacts

```text
config.yaml
.gitignore updated with .vibecode/
.vibecode/
  runs/
  current/
```

## Required tests

Write tests first.

Suggested tests:

- Initializing a fresh git repo creates `.vibecode/`.
- Initialization inserts `.vibecode/` into `.gitignore`.
- Re-running init is idempotent.
- Existing `config.yaml` is not overwritten silently.
- Workspace paths resolve correctly.
- `SKILLS/` status is reported if present.
- `.vibecode/` is classified as generated workspace data.
- CLI `--json` returns a stable envelope.

## Success criteria

- A clean repo can be initialized with one command.
- The command reports what it created or updated.
- `.vibecode/` is ignored by git after initialization.
- Root `config.yaml` is the only human-maintained project config.
- The workspace model can locate repo root, config, `.vibecode`, runs, current, and `SKILLS/` paths.

---

# Checkpoint: Run package store

## Purpose

Create a reproducible run package for every prompt.

## Implement

- Run ID generation.
- Run directory creation.
- `user_prompt.md` writing.
- `run_manifest.json` writing.
- `scanner_config.json` writing.
- scan output directory authorization.
- `.vibecode/current/` update.
- Previous run summary loading.
- Run listing and run display CLI.
- Structured run metadata.

## CLI surface

```powershell
vibecode run create "test task"
vibecode runs list
vibecode runs show latest
vibecode runs show <run_id>
```

`vibecode run create` is debug/internal.

## Produced artifacts

```text
.vibecode/runs/<run_id>/
  user_prompt.md
  run_manifest.json
  scanner_config.json
  scan/

.vibecode/current/
  run_manifest.json
```

`run_manifest.json` should include at least:

```json
{
  "run_id": "...",
  "created_at": "...",
  "repo_root": "...",
  "task_raw": "...",
  "git_branch": "...",
  "git_head": "..."
}
```

## Required tests

Write tests first.

Suggested tests:

- Creating a run writes expected files.
- Run IDs are unique and filesystem-safe.
- `scanner_config.json` is written from resolved `config.yaml`.
- Scan output directory is created/authorized.
- `current` points to the latest run data.
- Previous run summary can be read.
- Running the same command twice creates two separate runs, not overwritten files.
- `runs show latest --json` returns stable output.

## Success criteria

- Every prompt can be represented as a run before scan/model work begins.
- Runs are inspectable through CLI.
- Run artifacts never overwrite earlier runs.
- Current run state is reproducible from the run store.
- Python scanner receives configuration only through `scanner_config.json`.

---

# Checkpoint: Python scanner subprocess skeleton

## Purpose

Add the internal Python scanner CLI and TypeScript subprocess adapter before implementing full scan behavior.

## Implement

- Python package under `src/core/scanning/python/`.
- `vibecode_scanner.cli`.
- `vibecode-scan` wrapper or equivalent command.
- TypeScript scanner subprocess adapter.
- stdout JSON summary contract.
- exit code handling.
- structured subprocess diagnostics.
- `--repo`, `--task`, `--scanner-config`, `--out`, and `--json` flags.

## CLI surface

```powershell
vibecode-scan --help
python -m vibecode_scanner --help
vibecode-scan --repo . --task "test" --json
```

## Produced artifacts

In early skeleton mode, no full scan artifacts are required.

When `--out` is provided, the scanner may write a minimal:

```text
scan_manifest.json
```

## Required tests

Write tests first.

Suggested tests:

- Python scanner CLI help works.
- Python scanner accepts required arguments.
- Python scanner emits JSON summary on stdout.
- Python scanner writes minimal `scan_manifest.json` when `--out` is provided.
- TypeScript adapter invokes scanner and parses JSON summary.
- Non-zero scanner exit code becomes structured diagnostic.

## Success criteria

- TypeScript can call Python scanner through a stable subprocess boundary.
- Python scanner does not touch repo files.
- Python scanner writes only inside the provided scan output directory.
- Scanner stdout JSON is stable enough for TypeScript to consume.

---

# Checkpoint: Base deterministic scan

## Purpose

Build the first real deterministic scan layer: repo tree, file inventory, git status, diff stat, ignore rules, and config snapshot.

## Implement

Python scanner modules for:

- complete tree of non-ignored paths and files;
- file inventory;
- git status;
- git diff stat;
- ignore rules;
- config snapshot.

The tree should not have artificial truncation in the basic version. It should include the complete non-ignored path list.

`.vibecode/` must be excluded from target repo scan.

## CLI surface

```powershell
vibecode scan "task description"
vibecode runs show latest
```

## Produced artifacts

```text
.vibecode/runs/<run_id>/scan/
  scan_manifest.json
  repo_tree.txt
  file_inventory.json
  git_status.json
  git_diff_stat.txt
  ignore_rules.json
  config_snapshot.json
```

## Required tests

Write tests first.

Suggested tests:

- Scan creates all base artifacts.
- Tree includes non-ignored files.
- Tree excludes `.vibecode/`.
- Tree respects `.gitignore`.
- File inventory includes path, extension, guessed type, byte size, and line count where applicable.
- Git status artifact captures modified, untracked, and staged files.
- Diff stat artifact is written when git is available.
- Config snapshot is written as `config_snapshot.json`, not `config.json`.

## Success criteria

- Running `vibecode scan "x"` creates a complete base scan run.
- `repo_tree.txt` represents the complete non-ignored tree.
- `.vibecode/` does not appear as scanned source.
- The generated scan artifacts are readable and stable enough for flash input building.
- Python writes only inside `scan/`.

---

# Checkpoint: Manifest, dependency, command, and environment scan

## Purpose

Capture what the project declares and what the local environment can actually run.

## Implement

Scanner modules for:

- project manifest discovery;
- direct dependency extraction;
- package manager detection;
- build/test/lint/run command extraction;
- tooling configuration extraction;
- local environment snapshot.

Manifest sources:

```text
package.json
pnpm-lock.yaml
yarn.lock
package-lock.json
pyproject.toml
requirements.txt
poetry.lock
uv.lock
Cargo.toml
Cargo.lock
go.mod
go.sum
pom.xml
build.gradle
Dockerfile
docker-compose.yml
Makefile
justfile
tox.ini
noxfile.py
.github/workflows/*.yml
```

Environment sources may include:

```text
python --version
uv pip list
pip freeze
node --version
npm list --depth=0
pnpm list --depth=0
```

Repo declarations and local environment must be clearly separated.

## CLI surface

```powershell
vibecode scan "task"
vibecode scan --section commands "task"
```

## Produced artifacts

```text
.vibecode/runs/<run_id>/scan/
  manifests.json
  environment.json
  commands.json
  tooling.json
```

## Required tests

Write tests first.

Suggested tests:

- Python repo with `pyproject.toml` reports Python stack and dependencies.
- TypeScript repo with `package.json` reports package manager, scripts, and dependencies.
- Commands are extracted from package scripts or project configs.
- Environment scan is recorded separately from repo manifest facts.
- Missing optional tooling produces a clear diagnostic in the artifact, not a crash.
- Command entries preserve source/provenance where practical.

## Success criteria

- Flash and main model inputs can explain what language, package manager, test framework, lint tools, and run commands exist.
- Commands are source-attributed where possible.
- The project can distinguish “declared by repo” from “installed locally”.

---

# Checkpoint: Documentation and instruction scan

## Purpose

Capture the human-maintained docs and agent/contributor instructions that explain how the repo should be worked on.

## Implement

Scanner modules for:

- README files;
- main docs;
- architecture/vision/context/decision documents;
- AGENTS/CLAUDE/GEMINI instruction files;
- CONTRIBUTING and PR templates.

Main documentation files should be included fully in the basic version.

Important sources:

```text
README.md
docs/*.md
docs/**/*.md
VISION.md
CONTEXT.md
ARCHITECTURE.md
ARCHITECTURE_DECISIONS.md
IMPLEMENTATION_MAP.md
AGENTS.md
CLAUDE.md
GEMINI.md
CONTRIBUTING.md
.github/pull_request_template.md
.github/ISSUE_TEMPLATE/*
```

## CLI surface

```powershell
vibecode scan "task"
vibecode scan --section docs "task"
```

## Produced artifacts

```text
.vibecode/runs/<run_id>/scan/
  repo_instructions.json
  docs.json
  architecture_docs.json
```

## Required tests

Write tests first.

Suggested tests:

- README content is captured with source path.
- `docs/VISION.md`, `docs/CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE_DECISIONS.md`, and `docs/IMPLEMENTATION_MAP.md` are captured when present.
- AGENTS.md is captured as repo instruction content.
- CONTRIBUTING.md and PR template are captured with source path.
- Generated `.vibecode` docs are not treated as source docs.
- Every captured document has source path metadata.

## Success criteria

- Flash input can include the repo’s own instructions and main documentation.
- Every captured document has source path metadata.
- Main docs are available to the flash model without requiring early tool calls.

---

# Checkpoint: Symbol, import, entrypoint, test, schema, and keyword scan

## Purpose

Give the flash model a code map without sending full source files by default.

## Implement

Regex-based scanners first. AST can be added later if needed.

Scanner modules:

- symbol scanner;
- import/dependency scanner;
- entrypoint scanner;
- test inventory scanner;
- schema/API/domain artifact scanner;
- keyword hit scanner;
- recent history scanner.

Initial symbol patterns:

Python:

```text
def
async def
class
@app.command
@app.route
```

TypeScript/JavaScript:

```text
export function
export class
export interface
export type
function
const X =
```

Keyword hits should be evidence only, not relevance scoring.

## CLI surface

```powershell
vibecode scan "add skills selection"
vibecode scan --section code-map "add skills selection"
```

## Produced artifacts

```text
.vibecode/runs/<run_id>/scan/
  symbols.json
  imports.json
  entrypoints.json
  tests.json
  schemas.json
  keyword_hits.json
  recent_history.json
```

## Required tests

Write tests first.

Suggested tests:

- Python symbols are extracted from a fixture file.
- TypeScript symbols are extracted from a fixture file.
- Local and external imports are distinguished where practical.
- CLI entrypoint is detected from package metadata or common file names.
- Test inventory detects `tests/`, `test_*.py`, `*.test.ts`, and `*.spec.ts` patterns.
- Keyword hits find prompt terms in paths and symbols.
- No relevance score is generated.

## Success criteria

- Flash model receives a useful map of symbols, imports, entrypoints, tests, schemas, keyword hits, and recent history.
- The scanner does not pretend to know the correct edit target.
- The output is stable enough for tests and debugging.

---

# Checkpoint: Skills catalog and explicit project copy

## Purpose

Implement VibecodeLight-managed skills and project snapshots.

## Implement

- User-profile skill store.
- Default skills discovery.
- User skills discovery.
- Project `SKILLS/` snapshot discovery.
- TypeScript-owned skills catalog creation.
- Explicit skill copy command.
- Selected skill content loader.

Primary store:

```text
%APPDATA%/VibecodeLight/skills/
```

Project snapshot:

```text
SKILLS/
```

Copy is a snapshot. There is no automatic sync.

Python scanner may see `SKILLS/` as repo files, but it must not manage the canonical skills catalog.

## CLI surface

```powershell
vibecode skills list
vibecode skills copy <skill-id>
vibecode skills copy --all
vibecode skills project-list
```

## Produced artifacts

Per run:

```text
.vibecode/runs/<run_id>/skills/
  skills_catalog.json
```

After flash selection:

```text
.vibecode/runs/<run_id>/skills/
  selected_skills.json
  selected_skill_contents.md
```

## Required tests

Write tests first.

Suggested tests:

- User-profile skills appear in `skills list`.
- Project `SKILLS/` snapshot skills appear in the catalog.
- Copying a skill creates a project snapshot under `SKILLS/`.
- Re-copy behavior is explicit and does not silently sync.
- Catalog contains ID, title, summary, tags, source, and path.
- Selected skill content can be loaded by ID.
- Python scanner does not write `skills_catalog.json`.

## Success criteria

- Flash model can receive a metadata catalog of available skills.
- The selected skills can be expanded to full content for the final prompt.
- Skills are not stored as source inside `.vibecode/`.
- Project skills behavior is clear and reproducible.
- TypeScript is the only owner of the canonical skills catalog.

---

# Checkpoint: Flash input builder and artifact manifest

## Purpose

Build the exact input that will be sent to the flash model, using saved scan artifacts and TypeScript-generated skills catalog.

## Implement

- Flash input manifest builder.
- Human-readable `flash_input.md` builder.
- Artifact path resolver.
- Previous run summary inclusion.
- Optional terminal context inclusion hook.
- Skills catalog inclusion.

The flash input builder should consume saved artifacts, not secretly rescan the repo.

## CLI surface

```powershell
vibecode context-build "task"
vibecode runs show latest --artifact flash_input
```

## Produced artifacts

```text
.vibecode/runs/<run_id>/flash/
  flash_input_manifest.json
  flash_input.md
```

Example manifest:

```json
{
  "run_id": "...",
  "inputs": {
    "repo_tree": "scan/repo_tree.txt",
    "file_inventory": "scan/file_inventory.json",
    "git_status": "scan/git_status.json",
    "commands": "scan/commands.json",
    "docs": "scan/docs.json",
    "symbols": "scan/symbols.json",
    "skills_catalog": "skills/skills_catalog.json"
  }
}
```

## Required tests

Write tests first.

Suggested tests:

- Flash input manifest references existing scan artifacts.
- Flash input includes user task, repo summary, scan references, skills catalog, and previous run summary.
- Builder output is deterministic for the same run artifacts.
- Missing optional artifacts produce clear diagnostics.
- Builder does not rescan the repo directly.
- Builder does not ask Python to build skills catalog.

## Success criteria

- The exact material for the flash model is saved before model invocation.
- The user can inspect `flash_input.md` and `flash_input_manifest.json`.
- Flash input is reproducible from saved run artifacts.

---

# Checkpoint: Markdown flash output contract and parser

## Purpose

Define and enforce the initial Markdown flash output contract before deeply integrating provider calls into the pipeline.

## Implement

- Markdown section contract.
- Parser for stable sections:
  - Task Summary
  - Relevant Files
  - Files To Read With Tools
  - Relevant Tests
  - Commands To Run
  - Selected Skills
  - Cautions
  - Context Pack
- Extracted metadata writer:
  - `flash_output_meta.json`
- Structured diagnostics for missing required sections.
- Future JSON extension note in code/docs where appropriate.

## CLI surface

```powershell
vibecode flash validate <path-to-flash-output.md>
```

## Produced artifacts

```text
.vibecode/runs/<run_id>/flash/
  flash_output.md
  flash_output_meta.json
```

## Required tests

Write tests first.

Suggested tests:

- Valid Markdown flash output passes validation/parsing.
- Missing required sections fail with structured diagnostics.
- Selected skills section can be extracted into metadata.
- Relevant files section can be extracted into metadata where practical.
- Commands to run can be extracted into metadata where practical.
- Parser preserves the raw Markdown.
- Parser does not require `flash_output.json`.

## Success criteria

- Flash output is not a shapeless blob.
- Bad Markdown output results in clear diagnostics.
- The rest of the pipeline can consume `flash_output.md` and extracted metadata.
- JSON flash output is clearly left as a future extension, not required initially.

---

# Checkpoint: Flash model adapter with read-only tools

## Purpose

Call the real flash model and allow it to use logged, read-only tools.

## Implement

- LLM adapter interface.
- Provider adapter configuration.
- Real flash provider adapter.
- Mock provider adapter for tests.
- Tool gateway for read-only functions:
  - `read_file(path)`;
  - `list_dir(path)`;
  - `read_artifact(name)`;
  - `search_text(query)`.
- Tool call logging.
- Real-model test command gated behind explicit live test command.

## CLI surface

```powershell
vibecode flash run latest
vibecode prompt "task" --live-flash
pnpm test:live
```

## Produced artifacts

```text
.vibecode/runs/<run_id>/flash/
  flash_output.md
  flash_output_meta.json
  tool_calls.json

.vibecode/runs/<run_id>/output/
  context_pack.md
```

## Required tests

Write tests first.

Default tests use mocks:

- Mock flash adapter receives saved flash input.
- Mock output is parsed/validated as Markdown.
- Tool calls are logged.
- Tools are read-only.
- Tool path access is constrained to the selected repo/run artifact space.

Special live tests:

- Real flash adapter can return a valid structured Markdown output for a tiny fixture repo.
- Real tool calls are logged.
- Real output creates context pack.

## Success criteria

- The real flash model can create a context pack from saved flash input.
- The mock adapter supports reliable default tests.
- All flash tool calls are recorded.
- The flash model cannot mutate the repo through tools.
- Live tests run only when explicitly requested.

---

# Checkpoint: Context pack and selected skills expansion

## Purpose

Convert structured Markdown flash output into durable context artifacts and expand selected skill contents.

## Implement

- `context_pack.md` writer.
- `selected_skills.json` writer from parsed Markdown/extracted metadata.
- selected skill content loader.
- `selected_skill_contents.md` writer.
- selected relevant files/tests writer if useful.
- diagnostics for missing selected skills.

## CLI surface

```powershell
vibecode context show latest
vibecode skills selected latest
```

## Produced artifacts

```text
.vibecode/runs/<run_id>/output/
  context_pack.md

.vibecode/runs/<run_id>/skills/
  selected_skills.json
  selected_skill_contents.md
```

## Required tests

Write tests first.

Suggested tests:

- Valid Markdown flash output writes `context_pack.md`.
- Selected skill IDs expand to full content.
- Missing selected skill produces structured diagnostic.
- Selected skill contents are included in stable order.
- Context pack is not silently changed after flash output parsing.
- Context pack can be regenerated from saved flash output.

## Success criteria

- The run contains the flash model’s context pack.
- The run contains exact selected skills and expanded skill contents.
- The main prompt renderer can consume these artifacts without calling the flash model again.

---

# Checkpoint: Final prompt renderer

## Purpose

Create the exact prompt that will be previewed and optionally sent to the terminal.

## Implement

- Prompt template system.
- Markdown final prompt renderer.
- Tool instructions section.
- Context pack insertion.
- Selected skills insertion.
- Commands/checks insertion.
- Cautions insertion.
- Send metadata placeholder.
- Auto-approve setting support.

Base format is Markdown. Later adapters can customize prompt formatting for Hermes/OpenCode/Codex, but the basic prompt artifact remains visible.

## CLI surface

```powershell
vibecode prompt "task"
vibecode prompt "task" --preview
vibecode prompt "task" --auto-approve
```

## Produced artifacts

```text
.vibecode/runs/<run_id>/output/
  final_prompt.md

.vibecode/current/
  final_prompt.md
  context_pack.md
  selected_skills.json
  run_manifest.json
```

## Required tests

Write tests first.

Suggested tests:

- Renderer creates `final_prompt.md` from saved artifacts.
- Rendered prompt includes user task, context pack, selected skills, cautions, and commands.
- Renderer output is deterministic for the same inputs.
- Auto-approve still writes `final_prompt.md` before send.
- Preview content equals the saved `final_prompt.md`.
- Renderer does not append hidden prompt text after preview.

## Success criteria

- `final_prompt.md` is the source of truth for what will be sent.
- The prompt is inspectable before send by default.
- No hidden text is appended after preview.
- `current/` contains only canonical current files.

---

# Checkpoint: Full CLI dogfood pipeline

## Purpose

Prove the whole context pipeline without Electron.

## Implement

A single CLI path that performs:

```text
run creation
→ scanner_config.json
→ deterministic scan
→ skills catalog
→ flash input build
→ flash model call or mock
→ Markdown flash output parsing
→ context pack write
→ selected skills expansion
→ final prompt render
→ run display
```

## CLI surface

```powershell
vibecode prompt "add keyword hits scanner"
vibecode runs show latest
vibecode runs show latest --open output/final_prompt.md
```

## Produced artifacts

A complete run:

```text
.vibecode/runs/<run_id>/
  user_prompt.md
  run_manifest.json
  scanner_config.json
  scan/
  skills/
  flash/
    flash_input.md
    flash_output.md
    flash_output_meta.json
  output/
    context_pack.md
    final_prompt.md
```

## Required tests

Write tests first.

Suggested tests:

- End-to-end CLI with mock flash creates all expected artifacts.
- `runs show latest` displays key artifact paths.
- CLI returns useful diagnostics on Markdown flash validation failure.
- CLI can run in a fixture repo without Electron.
- Snapshot-style tests verify stable artifact names and core JSON fields.
- `.vibecode/` is not scanned as source.

## Success criteria

- The entire prompt/context pipeline works from CLI.
- The latest run is easy to inspect.
- Electron is not required to debug the core.
- A model or coding agent can use CLI-generated `final_prompt.md` manually.

---

# Checkpoint: Real PTY terminal prototype

## Purpose

Prove that VibecodeLight can host a real terminal, not a fake textbox.

## Implement

- PTY adapter.
- Windows PowerShell session support.
- Process lifecycle management.
- Read/write stream handling.
- Resize support.
- Multiline paste support.
- Session metadata.
- Transcript capture support for optional full transcript mode.

## CLI or test surface

A small terminal prototype command or dev harness is acceptable:

```powershell
vibecode terminal demo
```

## Produced artifacts

For terminal-related test runs:

```text
.vibecode/runs/<run_id>/terminal/
  terminal_transcript.md   # when full transcript mode is enabled
```

## Required tests

Write tests first where practical.

Suggested tests:

- PTY session starts in a requested working directory.
- Commands can be written and output can be read.
- Session can be resized.
- Session can be closed cleanly.
- Full transcript mode writes a full transcript when enabled.

Some PTY tests may be platform-specific or integration-level.

## Success criteria

- A real PowerShell session can run inside the PTY adapter.
- Basic commands work.
- Interactive CLI tools can be manually smoke-tested.
- Full transcript mode works when enabled.
- Terminal logic is isolated from context generation.

---

# Checkpoint: Electron shell with embedded terminal

## Purpose

Create the desktop shell that can open a repo and display a real terminal session.

## Implement

- Electron app shell.
- Repo selector/open workspace action.
- Embedded terminal view connected to PTY adapter.
- Working directory set to selected repo root.
- Basic session lifecycle.
- Bridge from UI to core actions.

No composer send is required yet.

## UI surface

- Open repo.
- Start terminal.
- Type commands in the real terminal.

## Required tests

Write tests first where practical.

Suggested tests:

- Electron/core bridge can open a workspace.
- Terminal starts in the selected repo root.
- UI calls core through defined APIs, not internal scanner modules.
- Smoke test verifies shell can launch without crashing.

Manual smoke tests:

```powershell
git status
pytest
pnpm test
uv run pytest
hermes
opencode
codex
```

## Success criteria

- Desktop shell opens a repo.
- Real terminal runs in that repo.
- Core remains usable from CLI.
- Terminal behavior is not simulated.
- GUI does not duplicate core context logic.

---

# Checkpoint: Composer preview overlay

## Purpose

Allow the user to write a Vibecode prompt over the terminal, generate a run, and preview the final prompt without sending it yet.

## Implement

- Composer overlay UI.
- User prompt input.
- Call into the same core pipeline used by CLI.
- Run creation from UI.
- Final prompt preview.
- Artifact summary display.
- Raw artifact access for debugging:
  - summary by default;
  - optional raw flash input/artifact view.

## UI surface

- Open composer.
- Write task prompt.
- Generate context/final prompt.
- Preview final prompt.
- Close composer.

## Produced artifacts

Same as CLI pipeline:

```text
.vibecode/runs/<run_id>/...
.vibecode/current/final_prompt.md
```

## Required tests

Write tests first where practical.

Suggested tests:

- Composer action calls core prompt pipeline.
- UI preview equals saved `final_prompt.md`.
- CLI and UI produce equivalent artifacts for the same fixture setup and mock flash response.
- Artifact summary shows run ID, selected files, selected skills, and command suggestions.

## Success criteria

- Composer uses the core pipeline, not custom UI logic.
- Generated `final_prompt.md` is visible before send.
- The user can inspect raw flash input if needed.
- UI and CLI use the same core pipeline.

---

# Checkpoint: Send final prompt into active terminal

## Purpose

Send exactly the previewed `final_prompt.md` into the active terminal session.

## Implement

- Send action from composer.
- Exact file-to-send read path.
- Prompt paste/write into PTY.
- Send metadata artifact.
- Default preview-required behavior.
- Auto-approve option.
- Send metadata capture and optional full transcript capture.

The initial implementation does not try to detect whether the terminal is shell, Hermes, OpenCode, Codex, or another interactive tool.

VibecodeLight behaves like communication with a real terminal. The user remains responsible for the active terminal state when sending a prompt.

## UI surface

- Preview final prompt.
- Send to active terminal.
- Optional auto-approve setting.

## Produced artifacts

```text
.vibecode/runs/<run_id>/terminal/
  send_metadata.json
  terminal_transcript.md   # when enabled
```

Example `send_metadata.json`:

```json
{
  "run_id": "...",
  "terminal_session_id": "...",
  "sent_file": "output/final_prompt.md",
  "sent_at": "...",
  "auto_approve": false
}
```

## Required tests

Write tests first where practical.

Suggested tests:

- Send reads the saved `final_prompt.md`.
- Send metadata identifies the exact sent file.
- Auto-approve still writes and sends the saved final prompt.
- - Full transcript is captured when enabled.
- Send metadata is mirrored to `.vibecode/current/send_metadata.json` only after send.

Manual tests:

- Send prompt into running Hermes session.
- Send prompt into running OpenCode session.
- Send prompt into running Codex session.

## Success criteria

- What is previewed is what is sent.
- Every send is tied to a run ID and terminal session ID.
- The user can inspect send metadata afterward.
- Default flow requires preview; auto-approve is explicit.
- No hidden prompt content is added after preview.

---

# Checkpoint: Previous run summary only

## Purpose

Keep prompt generation scoped to current-run scan material plus concise previous-run summary. Follow-up terminal-output context is deferred.

## Implement

- Previous run summary inclusion.
- No terminal-output inclusion flag or artifact.
- Full transcript remains opt-in only if implemented separately from prompt generation.

## CLI surface

```powershell
vibecode prompt "continue from previous run"
```

## Produced artifacts

```text
.vibecode/runs/<run_id>/scan/
  previous_run_summary.json
```

## Required tests

- Previous run summary is available to the next run.
- Terminal output is not included in flash input.
- No follow-up terminal artifacts are created.

---

# Checkpoint: Post-run state and per-run commit workflow

## Purpose

Capture repository state after a run and create a deterministic git commit for the run result.

## Implement

- Post-run git status capture.
- Changed files capture.
- Checks summary artifact.
- Deterministic commit message/body strategy.
- Failed validation marking.
- Commit metadata in run manifest or post-run artifact.
- Generated `.vibecode/` exclusion from commit.
- Later-revert metadata foundation.

## CLI surface

```powershell
vibecode run finalize latest
vibecode run commit latest
```

Command names may be adjusted, but CLI must support debugging the commit workflow.

## Produced artifacts

```text
.vibecode/runs/<run_id>/after/
  git_status_after.json
  changed_files_after.json
  checks_summary.md
```

Possible metadata:

```text
.vibecode/runs/<run_id>/after/commit_metadata.json
```

`commit_metadata.json` can be introduced if useful.

Generated `.vibecode/` artifacts are not committed.

## Required tests

Write tests first.

Suggested tests:

- Post-run git status is captured.
- Changed files are captured.
- Generated `.vibecode/` artifacts are not staged.
- Commit is created for a run with changed source files.
- Failed validation state is represented in checks summary and commit metadata/message/body.
- Unrelated changes are detected/reported where practical.
- Commit hash is recorded in run metadata or post-run metadata.

## Success criteria

- Every model run can be tied to a git commit.
- Failed validation state is not hidden.
- Runtime `.vibecode/` artifacts are not committed.
- The user can later identify which commit belongs to which run.
- The architecture has a clear path to revert a run later.

---

# Checkpoint: Hardening and real repo dogfood

## Purpose

Prove VibecodeLight on real repositories before adding multi-terminal/subagent complexity.

## Implement

- Dogfood scripts or documented dogfood commands.
- Fixture repos for Python and TypeScript.
- Real project trials.
- Report generator or manual report template.
- Live flash test command.
- Real terminal smoke test checklist.

## Dogfood scenarios

Test at least:

```text
fresh repo
dirty repo
Python repo
TypeScript repo
repo with SKILLS/
repo without config.yaml
repo with large docs
Hermes terminal session
OpenCode terminal session
Codex terminal session
failed validation run
per-run commit
```

## Produced artifacts

Dogfood reports can be stored under docs or run artifacts, for example:

```text
docs/dogfood/
  dogfood-<date>.md
```

or:

```text
.vibecode/runs/<run_id>/after/
  dogfood_summary.md
```

## Required tests

Write tests first where practical.

Suggested automated tests:

- Fixture Python repo end-to-end prompt with mock flash.
- Fixture TypeScript repo end-to-end prompt with mock flash.
- Dirty repo scan artifact test.
- Repo with SKILLS catalog test.
- Config-missing initialization test.
- Failed validation run creates marked commit metadata.

Special/manual tests:

- Real flash model call on tiny fixture repo.
- Real terminal prompt send into Hermes/OpenCode/Codex.
- Per-run commit inspection.

## Success criteria

- At least two real repos produce useful context packs.
- CLI and Electron flows use the same core pipeline.
- Run artifacts are complete and inspectable.
- Real terminal send works in practical agent sessions.
- Live-model tests identify provider/schema/tooling problems without breaking default tests.
- Per-run commits are understandable and reversible in principle.

---

# Checkpoint: Multi-terminal readiness

## Purpose

Prepare for future subagent visibility without implementing orchestration yet.

## Implement

- Multiple terminal session model.
- Session ID tracking.
- Run-to-terminal association.
- UI ability to display multiple sessions.
- Per-session prompt composer targeting.
- Per-run artifacts tied to the correct session.

This is readiness for future subagents, not full orchestration.

## UI surface

- Create/open multiple terminal sessions.
- Select active terminal session.
- Generate/send prompt to selected session.
- View which run belongs to which session.

## Produced artifacts

Run metadata should include:

```json
{
  "terminal_session_id": "...",
  "terminal_label": "..."
}
```

Send metadata should include the same session identity.

## Required tests

Write tests first where practical.

Suggested tests:

- Two terminal sessions have distinct IDs.
- Prompt sent to session A is not recorded as sent to session B.
- Runs preserve terminal session association.
- UI/core session selection uses explicit session IDs.
- Per-run commit still maps to the correct run/session.

## Success criteria

- Multiple terminals can exist without artifact confusion.
- Each prompt/run is tied to exactly one target session.
- The foundation exists for future subagent display.
- No full orchestration is required to satisfy this checkpoint.

---

# Document and format validation discipline

Whenever a checkpoint creates or changes a canonical document format, JSON schema, YAML config, CLI JSON output, Markdown flash section contract, or validation contract, implementation should include acceptance tests for valid and invalid cases.

Applies to:

```text
config.yaml
scanner_config.json
run_manifest.json
scan_manifest.json
file_inventory.json
git_status.json
commands.json
skills_catalog.json
flash_input_manifest.json
flash_output.md
flash_output_meta.json
selected_skills.json
send_metadata.json
git_status_after.json
changed_files_after.json
checks_summary.md
```

Required behavior:

- valid documents pass validation/parsing;
- invalid documents produce structured diagnostics;
- CLI `--json` output is valid JSON;
- Markdown flash output has stable sections;
- field names are stable;
- generated runtime files stay under `.vibecode/`;
- extension or filename should not be treated as stronger truth than the document’s internal type/version when such internal type exists.

---

# App-wide success criteria

VibecodeLight is successful when these are true.

## Reproducible prompt runs

For every prompt, the user can inspect:

```text
user_prompt.md
run_manifest.json
scanner_config.json
scan artifacts
skills catalog
flash_input.md
flash_output.md
context_pack.md
selected_skills.json
selected_skill_contents.md
final_prompt.md
send_metadata.json
terminal excerpt/transcript as configured
post-run git/check artifacts
commit metadata or linked commit hash
```

The run explains what happened.

## Transparent final prompt

`final_prompt.md` is the exact prompt that was sent to the terminal.

Preview mode and auto-approve mode both use the same saved `final_prompt.md` artifact.

## CLI-first debuggability

Core functionality works without Electron:

```powershell
vibecode init
vibecode scan "task"
vibecode context-build "task"
vibecode prompt "task"
vibecode runs show latest
vibecode skills list
```

If the GUI fails, the core can still be tested and debugged.

## Generated workspace discipline

`.vibecode/` is generated and ignored.

It is not scanned as target repo source.

`SKILLS/` is the explicit project skill snapshot outside `.vibecode/`.

## Useful deterministic scan

The deterministic scan captures:

- complete non-ignored repo tree;
- file inventory;
- git status and diff stat;
- config snapshot;
- manifests and dependencies;
- local environment snapshot;
- commands;
- docs and repo instructions;
- symbols;
- imports;
- entrypoints;
- tests;
- schemas;
- keyword hits;
- recent history;
- previous run summary;
- terminal context when included.

## Flash model as selector and compressor

The flash model receives scan material and read-only tools.

It returns structured Markdown containing:

- context pack;
- selected skills;
- relevant files;
- files to read with tools;
- relevant tests;
- commands to run;
- cautions.

Its output is saved as `flash_output.md`.

## Skills are controlled

Skills are managed in user profile and optionally copied to project `SKILLS/` by explicit command.

TypeScript builds the skills catalog.

Flash selects skills from metadata catalog.

Selected skills are expanded and included in the final prompt.

## Real terminal

The terminal is a real PTY-backed terminal.

It can run PowerShell, git, tests, Hermes, OpenCode, Codex, and other interactive CLI tools.

## Per-run commit visibility

Every model run creates or is tied to a deterministic git commit.

If validation fails, the failure is visible.

Generated `.vibecode/` artifacts are not committed.

The user can identify which commit belongs to which run.

## One-agent flow is reliable before subagents

The single-terminal flow must work reliably before multi-terminal/subagent workflows become a serious implementation target.

Required flow:

```text
repo selected
→ user prompt
→ new run
→ scanner_config.json
→ scan
→ flash input
→ flash output Markdown
→ context pack
→ selected skills
→ final prompt
→ preview
→ send to real terminal
→ send metadata and terminal excerpt/transcript
→ post-run artifacts
→ per-run commit
```

## Test discipline

Every checkpoint has tests.

Default tests are deterministic and mock model providers.

Live LLM and real terminal/agent tests exist, but run only by explicit command.

---

# Ready for real dogfood

VibecodeLight is ready for real dogfood when all of the following are true:

- CLI pipeline works end-to-end with mock flash.
- Live flash adapter works on a tiny fixture repo through explicit live test.
- Run artifacts are complete and inspectable.
- `flash_output.md` is structured and saved.
- `final_prompt.md` is exactly what gets sent.
- Electron shell can host a real terminal in the selected repo.
- Composer can generate and preview the same prompt pipeline as CLI.
- Prompt can be sent into Hermes/OpenCode/Codex terminal sessions.
- `.vibecode/` is ignored and excluded from target scanning.
- `SKILLS/` project snapshot is supported.
- Default transcript mode captures excerpt; full transcript mode can be enabled.
- Post-run git/check artifacts are captured.
- Per-run commits are created or clearly tied to runs.
- Failed validation state is visible.
- At least two real repos produce useful context packs.
- A developer can diagnose a bad run by reading `.vibecode/runs/<run_id>/` without guessing what happened.

---

# Practical build mantra

```text
Tests before code.
CLI before GUI.
Artifacts before automation.
Markdown flash output before JSON flash mode.
Real terminal before composer send.
Single-agent reliability before subagents.
Visible prompt before model execution.
Per-run commit before orchestration.
```
