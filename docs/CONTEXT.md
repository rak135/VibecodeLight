# VibecodeLight Context Architecture

## Purpose

VibecodeLight builds reproducible, task-specific context for AI coding agents.

Its job is not to replace Hermes, OpenCode, Codex, Git, test runners, or the shell. Its job is to prepare truthful repository material, let a flash model compress and select the relevant parts, render a visible final prompt, and send that prompt into a real terminal session.

The context system exists to solve one specific problem:

> AI agents waste time and make mistakes because they enter a repository without a reliable map, without clear project rules, without relevant files, and without task-specific context.

VibecodeLight fixes this by creating a fresh run package for every model prompt.

Every prompt should be reproducible:

- what the user asked,
- what repository state was scanned,
- what material the flash model received,
- what the flash model selected,
- which skills were selected,
- what final prompt was sent to the real terminal,
- what terminal metadata was captured,
- what post-run state existed,
- what commit captured the run result.

Nothing important should be hidden.

---

## Authority

`ARCHITECTURE_DECISIONS.md` is the implementation contract and source of truth for concrete implementation decisions.

This document defines the context architecture. If this document conflicts with `ARCHITECTURE_DECISIONS.md` on implementation details, `ARCHITECTURE_DECISIONS.md` wins.

`AGENTS.md` is the operational guide for agents.

---

## Core Principle

The context architecture is split into four responsibilities:

```text
TypeScript orchestration
  -> owns runs, config, skills, flash calls, tools, prompt rendering, terminal integration

Python deterministic scanner
  -> gathers truthful repository and environment material

Flash model
  -> selects, compresses, explains, and prepares task-specific context

Main model / terminal agent
  -> receives final_prompt.md, selected context, selected skills, and works in the real terminal
```

The deterministic scanner does not try to be clever. It does not invent relevance scores. It does not pretend to understand the task deeply. It gathers facts and evidence.

The flash model is allowed to use judgment. It can choose relevant files, relevant docs, relevant tests, and relevant skills. It can add cautions where appropriate. It can tell the main model which files it should inspect with tools.

The main model should not receive raw repository noise by default. It receives the processed context pack and exact instructions needed for the task.

---

## Prompt Lifecycle

For every prompt sent through VibecodeLight Composer:

```text
User writes prompt in Vibecode Composer
  -> TypeScript creates a new run package
  -> TypeScript writes scanner_config.json
  -> Python deterministic scanner writes scan artifacts
  -> TypeScript builds flash_input.md and flash_input_manifest.json
  -> TypeScript builds skills_catalog.json
  -> flash model creates flash_output.md
  -> TypeScript stores context_pack.md and selected skill artifacts
  -> TypeScript renders final_prompt.md
  -> user previews final_prompt.md by default
  -> VibecodeLight sends final_prompt.md into the active real terminal
  -> VibecodeLight captures terminal and post-run metadata
  -> the run result is captured by a deterministic git commit
```

The base rule:

> Every model prompt creates a new run package.

There is no hidden reuse of stale context. Future optimization may cache expensive scan pieces, but the conceptual behavior stays the same: every sent prompt has its own run package and final prompt artifact.

---

## Repository Scope

VibecodeLight works on one active repository selected by the user.

The selected repository is the scan target.

```text
one VibecodeLight workspace = one active selected repository
```

Multi-repo support may be added later, but it is not part of the core context architecture.

---

## `.vibecode/` Directory

`.vibecode/` is a generated VibecodeLight working directory.

It is not a human-maintained project source directory.

The target repository is scanned without `.vibecode/`.

This means:

- `.vibecode/` is excluded from repository scans,
- `.vibecode/` is where VibecodeLight stores generated run artifacts,
- users may read `.vibecode/` for debugging,
- users should not manually edit `.vibecode/` as source of truth,
- `.vibecode/` must be ignored by Git.

On initialization, VibecodeLight adds `.vibecode/` to `.gitignore` and reports that it did so.

The application may read its own previous run artifacts from `.vibecode/`, but this is separate from scanning the target repository as source material.

---

## Project Configuration

Human-maintained configuration is layered:

```text
%LOCALAPPDATA%\vibecodelight\config.yaml   # global provider registry/defaults
<repo>\.vibecode\config.yaml               # per-repo overrides (wins over global)
<repo>\config.yaml                         # project/scanner defaults
```

TypeScript owns this layered config model.

TypeScript:

- creates config files when needed,
- preserves existing content,
- reads them,
- validates them,
- resolves them into runtime settings,
- creates a per-run scanner config for Python.

Provider/model registry precedence is local workspace config over global user config. The repository-root `config.yaml` remains for project/scanner defaults rather than provider registry ownership. Secrets live only in `%LOCALAPPDATA%\vibecodelight\.env`.

Desktop GUI remembered pipeline toggles are stored in the global user config under `desktop.*`: `desktop.codegraph.mode`, `desktop.task_normalizer.enabled`, and `desktop.auto_approve.enabled`. These are Desktop GUI preferences only, not CLI defaults. CLI remains explicit for CodeGraph mode, Task Normalizer, and auto-approve (`--codegraph` / `--no-codegraph` / `--codegraph-mode`, `--task-normalizer` / `--no-task-normalizer`, `--auto-approve`). `desktop.auto_approve.enabled` is safety-sensitive: it only initializes the Desktop GUI toggle and does not become a CLI/global default. Actual sends record the current per-send `auto_approve` value in send metadata. The existing exception is CodeGraph Transport: `defaults.codegraph.transport` (`cli` / `mcp` / `auto`) is intentionally shared by the GUI and CLI settings command. Renderer localStorage is not a source of truth for pipeline-affecting remembered settings; keep it to pure UI/session state only.

Python scanner does not read the global or local YAML config directly.

Instead, TypeScript writes:

```text
.vibecode/runs/<run_id>/scanner_config.json
```

and passes that file to Python.

The scanner writes a snapshot of resolved scan configuration as:

```text
.vibecode/runs/<run_id>/scan/config_snapshot.json
```

This prevents TypeScript and Python from developing two different interpretations of project configuration.

---

## Skills Directory

Skills are not stored in `.vibecode/`.

Skills are VibecodeLight-managed user assets.

The primary skill source is the user profile, for example:

```text
%APPDATA%/VibecodeLight/skills/
  default/
  user/
```

A project may receive a snapshot copy of skills only when the user explicitly requests it.

Project-level copied skills live outside `.vibecode/`:

```text
SKILLS/
  skill-name/
    SKILL.md
    skill.yaml
```

Copying skills into a project is a snapshot operation.

It does not create automatic sync. VibecodeLight must not silently update or overwrite project skills. Any future update of project skills must be explicit.

---

## Skills Ownership

TypeScript owns the skills system.

TypeScript:

- reads user-profile skills,
- reads project `SKILLS/` snapshots,
- builds the canonical skills catalog,
- writes `skills/skills_catalog.json` for each run,
- processes flash-selected skills,
- writes `skills/selected_skills.json`,
- expands selected full skill content into `skills/selected_skill_contents.md`,
- inserts selected skill contents into the final prompt.

Python scanner:

- may see `SKILLS/` as ordinary repository files for tree, inventory, and docs,
- may include `SKILLS/` paths in `repo_tree.txt`,
- may include `SKILLS/` entries in `file_inventory.json`,
- must not build the canonical `skills_catalog.json`,
- must not copy skills,
- must not sync skills,
- must not manage skill selection.

Flash model receives skill metadata from the TypeScript-generated catalog. It does not receive the full content of all skills by default.

The main model receives the full content of selected skills.

---

## Deterministic Scan

The deterministic scan gathers raw, factual material. It does not decide final relevance.

The word `preflight` can be used as a product-level synonym for this deterministic scan phase.

There is no canonical `preflight.json` in the initial implementation.

Canonical artifacts live under:

```text
.vibecode/runs/<run_id>/scan/
```

The scanner output is written as multiple artifacts, not as one giant opaque file.

---

## TypeScript / Python Scan Boundary

TypeScript owns orchestration.

Python owns deterministic scanning.

RunStore creates and authorizes the scan output directory.

Python may write only inside that provided scan output directory:

```text
.vibecode/runs/<run_id>/scan/
```

All non-scan `.vibecode/` writes go through RunStore directly.

This is the precise write boundary:

```text
TypeScript:
  owns run lifecycle, config, skills, flash, prompt rendering, current mirror, terminal metadata

Python:
  owns deterministic scan implementation and scan artifact generation only

Python:
  may write only scan artifacts inside the provided scan output directory
```

Python scanner is read-only against the target repository.

---

## Scan Artifact Layout

A scan should produce many small files.

Canonical scan layout:

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

Each artifact should be inspectable without understanding hidden application state.

---

## What the Deterministic Scanner Collects

The deterministic scanner gathers factual material. It does not perform model-like reasoning.

### 1. Run Metadata

Run metadata is primarily owned by TypeScript and stored in `run_manifest.json`.

The scanner may receive relevant run/task fields through `scanner_config.json` and reflect scan-specific config in `config_snapshot.json`.

Run-level fields include:

```json
{
  "run_id": "2026-05-16_001",
  "created_at": "2026-05-16T22:00:00+02:00",
  "repo_root": "C:/DATA/PROJECTS/SomeRepo",
  "task_raw": "user prompt from composer",
  "os": "windows",
  "shell": "powershell"
}
```

Purpose:

- identify the run,
- preserve the exact user prompt,
- connect artifacts to a repository state,
- make debugging and replay possible.

---

### 2. Git State

Collected commands:

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
git diff --name-only
git diff --cached --name-only
git diff --stat
```

Collected material:

```json
{
  "git": {
    "branch": "master",
    "head": "abc123",
    "dirty": true,
    "modified_files": [],
    "untracked_files": [],
    "staged_files": [],
    "diff_stat": "...",
    "how_to_get_full_diff": "git diff"
  }
}
```

The scanner sends changed file lists and diff stat to the flash model.

The full diff is not automatically included in the base behavior. The package includes instructions for how the agent can obtain the full diff when needed.

Reason:

- changed files matter for context,
- diff stat is useful and compact,
- full diffs can be large and should be pulled intentionally.

---

### 3. Complete Tree of Non-Ignored Paths

The scanner collects a complete tree of non-ignored paths and files.

There are no artificial tree-depth limits in the base design.

The tree respects ignore rules.

Excluded from the repository tree:

```text
.git/
.vibecode/
paths ignored by .gitignore or equivalent ignore sources
```

Example artifact:

```text
.
├── README.md
├── config.yaml
├── pyproject.toml
├── SKILLS/
├── src/
│   └── ...
├── tests/
│   └── ...
└── docs/
    └── ...
```

The tree is sent to the flash model so it can orient itself in the repository.

---

### 4. File Inventory

The file inventory stores metadata for every non-ignored file.

Fields:

```json
{
  "path": "src/app/cli.ts",
  "extension": ".ts",
  "language_guess": "typescript",
  "kind": "source",
  "bytes": 12400,
  "lines": 420,
  "is_test": false,
  "is_doc": false,
  "is_config": false,
  "is_manifest": false
}
```

Possible file kinds:

```text
source
test
doc
config
manifest
schema
script
asset
unknown
```

Purpose:

- give the flash model a map of repository material,
- help distinguish tests, docs, configs, manifests, scripts, and source files,
- avoid sending all file contents directly.

---

### 5. Ignore Rules

The scanner reads ignore sources such as:

```text
.gitignore
.dockerignore
.npmignore
.prettierignore
.eslintignore
language/tool-specific exclude rules
```

Output:

```json
{
  "ignore_sources": [
    ".gitignore",
    ".dockerignore"
  ],
  "ignored_roots": [
    ".git/",
    ".vibecode/",
    "node_modules/",
    ".venv/"
  ]
}
```

VibecodeLight respects ignore rules. Ignored paths are not part of the scanned repository material.

---

### 6. Config Snapshot

The scanner receives resolved scanner configuration from TypeScript.

It writes the received/resolved scan-relevant snapshot as:

```text
scan/config_snapshot.json
```

This is not the source config.

Source config:

```text
config.yaml
```

Per-run scanner input:

```text
scanner_config.json
```

Scan artifact snapshot:

```text
scan/config_snapshot.json
```

The purpose of `config_snapshot.json` is debugging and reproducibility.

---

### 7. Manifests and Declared Dependencies

The scanner finds and parses project manifests.

Examples:

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
```

Output:

```json
{
  "manifests": [
    {
      "path": "pyproject.toml",
      "kind": "python-project",
      "important_sections": ["project", "dependencies", "tool.pytest", "tool.ruff"]
    }
  ],
  "stack": {
    "languages": ["python"],
    "package_managers": ["uv"],
    "test_frameworks": ["pytest"],
    "linters": ["ruff"],
    "runtimes": ["python>=3.11"]
  },
  "dependencies": {
    "direct": ["typer", "pydantic", "rich"],
    "dev": ["pytest", "ruff"]
  }
}
```

The flash model should know the declared stack and dependency surface.

The main model should receive a cleaned stack summary, not raw lockfile noise.

---

### 8. Local Runtime Environment

Repository declarations and local environment state are different things.

VibecodeLight should separate them.

Potential environment commands:

```powershell
python --version
pip freeze
uv pip list
node --version
npm list --depth=0
pnpm list --depth=0
cargo --version
go version
```

Output:

```json
{
  "environment": {
    "python_version": "3.11.15",
    "node_version": "22.x",
    "installed_packages_source": "uv pip list",
    "installed_direct_packages": []
  }
}
```

The context pack should clearly distinguish:

```text
repo declares X
local environment has Y
```

This prevents the model from confusing project requirements with accidental local state.

---

### 9. Build, Test, Lint, Run, and Format Commands

The scanner extracts commands from:

```text
package.json scripts
pyproject.toml
Makefile
justfile
tox.ini
noxfile.py
.github/workflows/*.yml
README.md
AGENTS.md
scripts/
```

Output:

```json
{
  "commands": {
    "install": ["uv sync"],
    "run": ["vibecode"],
    "test": ["pytest"],
    "lint": ["ruff check ."],
    "format": ["ruff format ."],
    "typecheck": [],
    "build": ["python -m build"]
  },
  "command_sources": {
    "test": ["pyproject.toml", "README.md"],
    "lint": ["pyproject.toml"]
  }
}
```

These commands are part of the feedback layer.

An agent without build/test/lint commands is operating blind.

---

### 10. Repository Instructions

The scanner finds instruction and contribution files.

Examples:

```text
AGENTS.md
CLAUDE.md
GEMINI.md
CONTRIBUTING.md
README.md development sections
.github/pull_request_template.md
.github/ISSUE_TEMPLATE/*
docs/CONTRIBUTING.md
```

Output:

```json
{
  "repo_instructions": [
    {
      "path": "AGENTS.md",
      "content": "...",
      "source_type": "agent-instructions"
    },
    {
      "path": "CONTRIBUTING.md",
      "content": "...",
      "source_type": "contributor-rules"
    }
  ]
}
```

These files define project rules, workflow rules, commit expectations, testing expectations, and agent-specific boundaries.

They are high-priority context.

---

### 11. Documentation

The scanner finds important documentation files.

Examples:

```text
README.md
docs/*.md
docs/**/*.md
VISION.md
ARCHITECTURE.md
ROADMAP.md
DESIGN.md
ADR
CHANGELOG.md
```

Base behavior:

> Main documentation files in `docs/` are sent whole.

Output:

```json
{
  "docs": [
    {
      "path": "README.md",
      "content": "...",
      "headings": ["Overview", "Install", "Usage"]
    },
    {
      "path": "docs/VISION.md",
      "content": "...",
      "headings": ["Purpose", "Architecture"]
    }
  ]
}
```

The base design intentionally avoids premature trimming. If large documentation becomes a real problem, document-size handling can be improved later.

---

### 12. Architecture and Decision Documents

The scanner marks architecture and decision documents separately.

Examples:

```text
docs/ARCHITECTURE.md
docs/VISION.md
docs/ARCHITECTURE_DECISIONS.md
docs/IMPLEMENTATION_MAP.md
docs/DESIGN.md
docs/ADR/*
docs/DECISIONS/*
```

Output:

```json
{
  "architecture_docs": [
    {
      "path": "docs/ARCHITECTURE.md",
      "content": "...",
      "provenance": "file"
    }
  ]
}
```

These files explain why the repository is shaped the way it is.

They are especially useful when the task touches architecture, boundaries, generated files, repository conventions, or long-running product direction.

---

### 13. Symbol Index

The base version uses regex-based symbol extraction.

AST parsing can be added later.

Python patterns:

```text
class X
def y(...)
async def z(...)
@app.command
@app.route
```

TypeScript / JavaScript patterns:

```text
export function
export class
export interface
export type
const X =
function X
```

Output:

```json
{
  "symbols": [
    {
      "path": "src/app/cli.ts",
      "name": "runPrompt",
      "kind": "function",
      "signature": "export function runPrompt(...): ...",
      "line": 42,
      "source": "regex"
    }
  ]
}
```

The symbol index is an orientation map, not a perfect compiler-grade representation.

---

### 14. Import and Dependency Map

The scanner includes a practical import map.

Collected relations:

```text
local imports
external imports
file-to-module relations
```

Output:

```json
{
  "imports": [
    {
      "from": "src/app/cli.ts",
      "to": "src/core/runs/store.ts",
      "kind": "local"
    },
    {
      "from": "src/app/cli.ts",
      "to": "commander",
      "kind": "external"
    }
  ]
}
```

The goal is practical orientation.

It does not need to be a perfect call graph.

---

### 15. Entrypoints

The scanner detects application entrypoints.

Examples:

```text
console_scripts in pyproject.toml
package.json bin/scripts
main.py
__main__.py
src/app/cli/*
server/app startup files
```

Output:

```json
{
  "entrypoints": [
    {
      "path": "src/app/cli/index.ts",
      "type": "cli",
      "source": "package.json bin"
    }
  ]
}
```

Entrypoints are important for both flash and main models because they explain where the application begins.

---

### 16. Test Inventory

The scanner detects tests and performs simple test-source pairing.

Detected patterns:

```text
tests/
test_*.py
*_test.py
*.test.ts
*.spec.ts
__tests__/
pytest config
jest/vitest config
```

Output:

```json
{
  "tests": [
    {
      "path": "tests/core/runs/store.test.ts",
      "test_names": [
        "creates run folder with manifest"
      ],
      "likely_targets": [
        "src/core/runs/store.ts"
      ]
    }
  ]
}
```

Pairing rules are intentionally simple:

```text
test_preflight.py -> preflight.py
store.test.ts -> store.ts
```

The test inventory tells the flash model which tests may matter and tells the main model how to validate changes.

---

### 17. Tooling and Config Files

The scanner detects tooling configuration.

Examples:

```text
.editorconfig
.prettierrc
.eslintrc
eslint.config.*
ruff config
mypy config
pytest config
tsconfig.json
vite.config.*
electron-vite config
```

Output:

```json
{
  "tooling": {
    "formatters": ["ruff", "prettier"],
    "linters": ["ruff", "eslint"],
    "typecheckers": ["mypy", "tsc"],
    "configs": [
      "pyproject.toml",
      "tsconfig.json"
    ]
  }
}
```

This helps models follow project style and verification rules.

---

### 18. API, Schema, and Domain Artifacts

The scanner identifies files that define data shape or domain contracts.

Examples:

```text
openapi.yaml
schema.prisma
*.graphql
migrations/
pydantic models
zod schemas
json schema
protobuf
SQL schema
schemas/*.schema.json
```

Output:

```json
{
  "schemas": [
    {
      "path": "schemas/run_manifest.schema.json",
      "kind": "json-schema",
      "symbols": ["RunManifest"]
    }
  ]
}
```

This is especially important for VibecodeLight because context packs and run packages are themselves structured data.

---

### 19. Keyword Hits From User Prompt

The scanner creates mechanical keyword hits from the user prompt.

It does not produce relevance scores.

Example prompt:

```text
add skills selection to context pack
```

Output:

```json
{
  "keyword_hits": [
    {
      "keyword": "skills",
      "paths": [
        "SKILLS/",
        "src/core/skills/catalog.ts",
        "tests/core/skills/catalog.test.ts"
      ]
    },
    {
      "keyword": "context",
      "paths": [
        "src/core/context/flash_input_builder.ts"
      ]
    }
  ]
}
```

This is evidence for the flash model, not a final decision.

There should be no fake precision like:

```json
{"score": 0.873}
```

That would create false confidence and make the system harder to debug.

---

### 20. Recent Git History

The scanner includes a compact recent history.

Commands:

```powershell
git log --oneline -20
git diff --stat
```

Output:

```json
{
  "recent_history": [
    {
      "commit": "abc123",
      "message": "feat: add prompt composer"
    }
  ]
}
```

Recent history is helpful context but not primary truth.

---

### 21. Previous Vibecode Run Summary

TypeScript may include a summary of the previous VibecodeLight run in the run package.

The scanner can receive or reference it through run artifacts, but it does not scan `.vibecode/` as source repo content.

Output:

```json
{
  "previous_run": {
    "run_id": "2026-05-16_000",
    "user_prompt": "...",
    "selected_files": [],
    "selected_skills": [],
    "agent_result_summary": "...",
    "checks_summary": "..."
  }
}
```

Reason:

- one previous summary helps continuity,
- full run history would quickly become noise,
- `.vibecode/` remains generated state, not scanned repository source.

---

### 22. Previous Run Summary Scope

Follow-up terminal-output inclusion is deferred. Prompt generation uses current-run scan material plus the bounded previous run summary only.

---

### 23. Provenance Metadata

Important facts should carry source information.

Example:

```json
{
  "fact": "Project uses pytest.",
  "source": {
    "path": "pyproject.toml",
    "section": "tool.pytest.ini_options"
  }
}
```

Provenance matters because VibecodeLight is meant to reduce model guesswork.

Facts without source become model-shaped noise.

---

## Secret Handling and Responsibility

The initial design does not include aggressive secret redaction or fixed filename censorship.

VibecodeLight respects ignore rules and does not scan ignored paths.

The user is responsible for what remains in the non-ignored repository tree.

Design statement:

```text
Initial VibecodeLight does not perform aggressive secret redaction or fixed filename censorship.
It respects ignore rules.
Users must keep secrets out of non-ignored repository files.
Provider secrets must live outside committed project files.
```

This keeps the base application lightweight and easier to debug.

Future hardening can add secret scanning and redaction, but it is not part of the initial context architecture.

---

## What the Flash Model Receives

The flash model receives a structured bundle of scan outputs, skill metadata, and controlled read-only tools.

It gets repository truth and available skill metadata.

It does not receive the full content of every source file by default.

Instead, it receives enough information to decide what is relevant.

The flash model may use tools to read file contents when needed.

Base behavior is one-step:

```text
scan material + skill catalog -> flash model -> flash_output.md + context pack + selected skills
```

A later flow may introduce more structured staged selection, but the base architecture starts with a simpler one-step flow.

---

## Flash Model Tools

The flash model may use read-only tools.

Initial tools:

```text
read_file(path)
list_dir(path)
read_artifact(name)
search_text(query)
```

Rules:

- tools are read-only,
- tool calls are logged,
- tool access respects workspace boundaries,
- tools do not modify the repository,
- tools do not modify `.vibecode/`,
- tools do not modify `SKILLS/`,
- tools are owned and authorized by TypeScript.

Tool call log:

```text
.vibecode/runs/<run_id>/flash/tool_calls.json
```

The flash model should not freely browse the filesystem. It should use controlled tools exposed by VibecodeLight.

---

## Flash Output

The initial flash output is Markdown-first.

Canonical initial artifact:

```text
.vibecode/runs/<run_id>/flash/flash_output.md
```

It should use stable sections:

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

Future JSON output is allowed later:

```text
.vibecode/runs/<run_id>/flash/flash_output.json
.vibecode/runs/<run_id>/flash/flash_validation.json
```

But JSON flash output is not the initial contract.

If JSON mode is introduced later, it must be schema-validated before use.

---

## Flash Model Responsibilities

The flash model produces:

```text
task summary
relevant files
files to read with tools
relevant tests
commands to run
selected skills
cautions
context pack
```

Cautions are not the same as deterministic facts.

When a caution is based on model judgment, it should be presented as a caution, not as a hard rule.

The flash model is a context compiler. It does not modify the repository.

---

## What the Main Model Receives

The main model or active terminal agent receives the final prompt.

The final prompt should include:

```text
user task
context_pack.md
selected skills full content
selected relevant files
files to inspect with tools
selected docs / architecture notes
commands to run
git status summary
cautions
instructions about how to retrieve more information if needed
expected final report format
```

The main model should not receive every raw scan artifact by default.

It receives the compressed, task-specific context chosen by the flash model and assembled by VibecodeLight.

---

## Final Prompt Assembly

The flash model produces the context pack and selected skills.

The final prompt is assembled by TypeScript from:

```text
stable VibecodeLight prompt template
user prompt
context_pack.md
selected skill contents
selected files
git summary
commands
cautions
```

Future behavior may allow user-selectable prompt assembly modes.

For now, the important invariant is:

> The final prompt shown to the user is the prompt sent into the real terminal.

No hidden prompt material should be added after preview.

---

## Prompt Format

The base final prompt format is Markdown.

Future adapters may customize prompt format for Hermes, OpenCode, Codex, or other agents.

Base rule:

```text
Markdown first, adapter-specific formats later.
```

---

## Full Run Artifact Layout

VibecodeLight writes multiple artifacts per run.

Canonical structure:

```text
.vibecode/
  current/
    run_manifest.json
    context_pack.md
    selected_skills.json
    final_prompt.md
    send_metadata.json   # only after send

  runs/
    <run_id>/
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

The structure is intentionally explicit.

Debugging should be easy.

Each artifact should be inspectable without understanding hidden application state.

---

## Flash Input Manifest

The flash input manifest points to the scan artifacts and skills catalog used to build the flash prompt.

Example:

```json
{
  "run_id": "2026-05-16_001",
  "task": "add skill selection",
  "inputs": {
    "repo_tree": "scan/repo_tree.txt",
    "file_inventory": "scan/file_inventory.json",
    "git_status": "scan/git_status.json",
    "diff_stat": "scan/git_diff_stat.txt",
    "manifests": "scan/manifests.json",
    "environment": "scan/environment.json",
    "commands": "scan/commands.json",
    "repo_instructions": "scan/repo_instructions.json",
    "docs": "scan/docs.json",
    "symbols": "scan/symbols.json",
    "imports": "scan/imports.json",
    "entrypoints": "scan/entrypoints.json",
    "tests": "scan/tests.json",
    "skills_catalog": "skills/skills_catalog.json"
  }
}
```

`flash_input.md` is a human-readable rendering of the most important material sent to the flash model.

Both machine-readable and human-readable inputs are useful:

- JSON helps validation and reproducibility,
- Markdown helps inspection and debugging.

---

## Current Run Pointers

`.vibecode/current/` mirrors or points to the most recent important run artifacts.

It exists for convenience.

The authoritative historical record is inside:

```text
.vibecode/runs/<run_id>/
```

`current/` should never be the only source of truth.

Canonical current files:

```text
run_manifest.json
context_pack.md
final_prompt.md
selected_skills.json
send_metadata.json   # only after send
```

Raw scan and flash input artifacts remain in the historical run folder.

---

## Skills Selection Flow

Skills flow:

```text
TypeScript loads user-profile skills
TypeScript loads project SKILLS/ snapshot if present
TypeScript builds skills catalog
flash model receives catalog metadata
flash selects relevant skills
TypeScript loads full content of selected skills
selected skill contents are added to final prompt
```

The main model receives the full content of selected skills.

For every new prompt, a fresh selected skills list is created.

This means skills are task-specific.

A skill selected for one prompt is not automatically selected for the next prompt unless the flash model selects it again.

---

## Source Material Available to Main Model

The main model should be told how to inspect more material.

For example:

```text
If you need exact implementation details, read these files with tools:
- src/core/skills/catalog.ts
- src/core/context/flash_input_builder.ts
- tests/core/skills/catalog.test.ts

If you need the full diff, run:
- git diff
```

This is better than dumping everything into the final prompt.

The final context should orient the model and tell it where to look next.

---

## Division Between Scan, Flash, and Main Model

### TypeScript Orchestration

Responsible for:

```text
run lifecycle
config.yaml
scanner_config.json
skills catalog
flash input
flash model invocation
flash tools
selected skill expansion
final prompt rendering
current mirror
terminal metadata
post-run metadata
per-run commit workflow
```

### Python Deterministic Scanner

Responsible for:

```text
git status
non-ignored repo tree
file inventory
ignore rules
config snapshot
manifests and dependencies
local environment snapshot
commands
repo instructions
docs
architecture docs
symbol index
import map
entrypoints
test inventory
tooling configs
schemas
keyword hits
recent history
scan artifact generation
```

Not responsible for:

```text
final relevance judgment
skills catalog ownership
LLM calls
prompt rendering
terminal integration
commits
writing outside scan/
```

### Flash Model

Responsible for:

```text
choosing relevant files
choosing selected skills
building context pack
listing files to read with tools
listing relevant tests
listing commands to run
adding cautions
compressing raw material into useful task context
```

Not responsible for:

```text
modifying the repository
claiming uncertain cautions as facts
silently adding hidden prompt material after preview
```

### Main Model / Terminal Agent

Responsible for:

```text
reading exact files when needed
implementing or reviewing
running checks
reporting changes
following selected skills and repo instructions
respecting the final prompt
```

---

## Terminal Sending

VibecodeLight sends `final_prompt.md` into the active terminal session.

The initial implementation does not try to detect whether the terminal is shell, Hermes, OpenCode, Codex, or another interactive tool.

Initial policy:

```text
VibecodeLight behaves like communication with a real terminal.
The user remains responsible for the active terminal state when sending a prompt.
```

Send metadata is stored in:

```text
terminal/send_metadata.json
```

Optional full transcript is stored in:

```text
terminal/terminal_transcript.md
```

Full transcript is configurable because it can become large and may contain sensitive information.

---

## Post-Run State

Post-run git and check artifacts live under:

```text
after/
```

Canonical post-run artifacts:

```text
after/git_status_after.json
after/changed_files_after.json
after/checks_summary.md
```

These files answer:

```text
what changed
which files changed
what validation ran
what failed
```

They are separate from terminal artifacts.

---

## Per-Run Git Commit

Each model run is expected to create a deterministic git commit that captures the run result.

If tests or validation fail, the run/commit must clearly mark the failed validation state.

The failure state can be recorded in:

```text
run metadata
after/checks_summary.md
agent final report
commit message or commit body
```

Generated `.vibecode/` artifacts are not committed.

The commit captures repository changes, not VibecodeLight runtime artifacts.

VibecodeLight should later provide UI/CLI support to revert changes from a run.

This policy is intentionally strict because it makes every run visible in git history.

---

## Handling Large Context

The base design intentionally allows the flash model to receive a generous amount of material.

This is acceptable as long as output quality remains good.

The system can later add limits or multi-step selection if real usage shows degradation.

Base posture:

```text
Do not prematurely over-optimize context trimming.
Keep the system transparent and easy to debug first.
Tune limits later from real failures.
```

The tree itself has no artificial limit beyond ignored paths.

File contents may become a future tuning point, but the base version does not introduce complicated limits upfront.

---

## Minimal Context Contract

A valid VibecodeLight run should produce at least:

```text
user_prompt.md
run_manifest.json
scanner_config.json
scan/scan_manifest.json
scan/repo_tree.txt
scan/file_inventory.json
scan/git_status.json
scan/git_diff_stat.txt
scan/config_snapshot.json
scan/manifests.json
scan/commands.json
scan/repo_instructions.json
scan/docs.json
scan/symbols.json
scan/imports.json
scan/entrypoints.json
scan/tests.json
skills/skills_catalog.json
flash/flash_input_manifest.json
flash/flash_input.md
flash/flash_output.md
output/context_pack.md
output/final_prompt.md
```

After send, it should also produce:

```text
terminal/send_metadata.json
after/git_status_after.json
after/changed_files_after.json
after/checks_summary.md
```

If any required artifact cannot be produced, the run should report that honestly.

Fake success is worse than failure.

---

## Architectural Invariants

The context system depends on these invariants:

1. `ARCHITECTURE_DECISIONS.md` wins on concrete implementation details.
2. Human-maintained config is layered: global `%LOCALAPPDATA%\vibecodelight\config.yaml`, local `<repo>\.vibecode\config.yaml` overrides, and repository-root `config.yaml` for project/scanner defaults.
3. `.vibecode/` is generated and ignored.
4. The target repository scan excludes `.vibecode/`.
5. Every sent prompt creates a new run package.
6. The final prompt is visible before send by default.
7. The visible final prompt is what gets sent to the real terminal.
8. Deterministic scan artifacts are saved under `scan/`.
9. There is no canonical `preflight.json`.
10. Flash input and flash output are saved.
11. Initial flash output is Markdown-first: `flash_output.md`.
12. JSON flash output is a future extension and must be validated if introduced.
13. TypeScript owns skills catalog and selected skill expansion.
14. Python scanner does not manage skills.
15. Selected skills are task-specific.
16. Full selected skill contents are included for the main model.
17. No relevance scoring is faked in the deterministic layer.
18. Keyword hits are evidence, not final decisions.
19. Provenance is attached to important facts where practical.
20. The main model receives compressed, task-specific context, not raw repository noise by default.
21. The user can inspect raw flash input and final prompt.
22. The terminal remains real; VibecodeLight prepares and sends prompts into it.
23. Terminal send artifacts live under `terminal/`.
24. Post-run git/check artifacts live under `after/`.
25. Every model run should create a deterministic git commit.
26. Failed validation state must be visible if tests fail.
27. Generated `.vibecode/` artifacts are not committed.
28. Initial VibecodeLight does not perform aggressive secret redaction; it respects ignore rules.

---

## Summary

VibecodeLight context architecture is built around a simple but strict idea:

> Deterministic truth first, flash-model compression second, visible final prompt third, per-run commit fourth.

TypeScript orchestrates the workflow.

Python scanner builds the factual repository map.

The flash model selects relevant files, relevant skills, tests, commands, and cautions.

VibecodeLight assembles a visible final prompt.

The real terminal agent receives that prompt and works in the actual repository.

The run result is captured by artifacts and git history.

The system should remain transparent, debuggable, and reproducible.

That is the real context architecture.
