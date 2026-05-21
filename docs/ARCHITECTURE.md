# VibecodeLight Architecture

## Purpose

VibecodeLight is a modular terminal workspace and context-pack system for AI-assisted development.

The application provides a real terminal as the primary working surface. Around that terminal, VibecodeLight builds reproducible prompt runs: it scans the selected repository, prepares a context package, allows a flash model to select relevant context and skills, renders a final prompt, shows that prompt to the user, sends it into the active terminal session, stores run artifacts, and captures the run result in git history.

The architecture is built around one rule:

> Every model prompt must be reproducible from stored artifacts and tied to a run result.

A prompt run must make it possible to answer:

- what repository was selected,
- what user prompt was written,
- what deterministic scan was performed,
- what flash model received,
- what flash model returned,
- what skills were selected,
- what final prompt was shown,
- what exact final prompt was sent to the terminal,
- what terminal output excerpt was captured afterward,
- what post-run repository state existed,
- what commit captured the run result.

The codebase must remain small, modular, and easy to debug. Modules should be replaceable or improvable without rewriting the whole application.

---

## Authority

`ARCHITECTURE_DECISIONS.md` is the implementation contract and source of truth for concrete implementation decisions.

This document defines module boundaries and architecture shape.

If this document conflicts with `ARCHITECTURE_DECISIONS.md` on concrete implementation details, `ARCHITECTURE_DECISIONS.md` wins.

`AGENTS.md` is the operational working guide for agents.

---

## Product Shape

VibecodeLight is not primarily an IDE. It is a working surface for agentic development.

The primary interaction is:

```text
selected repo
  -> real terminal
  -> Vibecode composer
  -> TypeScript run orchestration
  -> Python deterministic scan
  -> flash model context selection
  -> selected skills
  -> final prompt preview
  -> send into terminal
  -> store run artifacts
  -> capture post-run state
  -> create per-run commit
```

The real terminal remains real. Users can run Hermes, OpenCode, Codex, PowerShell, tests, git commands, package managers, and any other CLI tools inside it.

The composer is not a fake terminal. It is a controlled prompt-building layer that appears over or near the terminal and generates the prompt that will be sent into the terminal.

---

## Technology Direction

The application is built as:

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

This split is not optional. It prevents the hybrid project from becoming tangled.

Python does not own the application state.  
Python does not own prompt rendering.  
Python does not own the LLM provider.  
Python does not own skills.  
Python does not own `.vibecode/current`.

---

## Top-Level Repository Layout

Canonical structure:

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

The Python scanner lives under the scanning boundary:

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

There should not be a competing top-level Python architecture.

The TypeScript and Python sides communicate through:

```text
scanner_config.json
scan output directory
stdout JSON summary
exit codes
JSON/Markdown artifacts
```

---

## Main Layers

### App Layer

The app layer contains the desktop shell and CLI entrypoints.

```text
src/app/desktop/
src/app/cli/
```

Responsibilities:

- show the real terminal,
- show the composer,
- show final prompt preview,
- show summaries of run artifacts,
- call core services,
- send approved prompt into the active terminal,
- expose debug commands through CLI.

The app layer must remain thin.

It should not contain:

- repository scanning logic,
- skills catalog logic,
- flash input construction,
- final prompt rendering rules,
- run storage internals,
- provider-specific LLM logic.

### Core Layer

The core layer owns the product logic.

```text
src/core/
```

Responsibilities:

- workspace initialization,
- run artifact creation,
- scanner subprocess orchestration,
- skills catalog loading,
- flash input preparation,
- context pack handling,
- selected skill loading,
- final prompt rendering,
- terminal session metadata,
- post-run metadata,
- per-run commit workflow,
- validation and testable contracts.

The core layer should be usable from both the desktop app and CLI.

### Adapter Layer

The adapter layer isolates external systems.

```text
src/adapters/
```

Responsibilities:

- filesystem access,
- git command execution,
- PTY/process management,
- LLM provider calls,
- environment/package inspection.

Core modules should depend on adapter interfaces, not random provider implementations.

---

## Dependency Direction

Allowed:

```text
app -> core
app -> adapters through app bridge
core -> core models
core -> adapter interfaces
adapters -> external systems
```

Forbidden:

```text
core -> app
scanning -> UI
prompting -> UI
skills -> UI
context -> desktop components
random modules -> direct writes into .vibecode/
random modules -> direct LLM provider calls
random modules -> direct PTY process manipulation
```

This is what keeps the program understandable.

---

## Core Modules

## `core/models`

This module contains typed contracts shared across the application.

Expected model groups:

```text
RunManifest
WorkspaceConfig
WorkspacePaths
ScannerConfig
ScanManifest
GitScanResult
FileInventoryItem
ManifestScanResult
EnvironmentScanResult
CommandScanResult
InstructionDocument
DocumentationDocument
SymbolRecord
ImportRecord
EntrypointRecord
TestRecord
SkillMetadata
SkillSelection
FlashInputManifest
MarkdownFlashOutput
FlashOutputMetadata
ContextPack
PromptPackage
TerminalSessionInfo
SendMetadata
PostRunState
CliResponse
StructuredError
```

Rules:

- No UI imports.
- No provider imports.
- No filesystem side effects.
- Every cross-module payload should have a model/schema.

This prevents the codebase from degenerating into anonymous dictionaries passed between unrelated modules.

---

## `core/workspace`

Owns the selected repository and workspace paths.

Responsibilities:

- locate the selected repo root,
- load `config.yaml`,
- initialize `.vibecode/`,
- ensure `.vibecode/` is present in `.gitignore`,
- expose paths to run storage,
- expose project `SKILLS/` path,
- distinguish source repository content from generated VibecodeLight artifacts.

Important rule:

```text
.vibecode/ is generated workspace state.
It is not scanned as part of the target repository.
```

On initialization, VibecodeLight should add `.vibecode/` to `.gitignore` and notify the user.

Recommended files:

```text
core/workspace/
  paths.ts
  config.ts
  initializer.ts
  locator.ts
```

### Config Ownership

`config.yaml` is the only human-maintained project config.

TypeScript owns it.

TypeScript creates, preserves, reads, validates, and resolves `config.yaml`.

Python scanner receives only a per-run scanner input:

```text
.vibecode/runs/<run_id>/scanner_config.json
```

The scan artifact snapshot of the resolved scan config is:

```text
.vibecode/runs/<run_id>/scan/config_snapshot.json
```

There is no `.vibecode/config.json`.

---

## `core/runs`

Owns prompt run persistence.

Every composer send creates a new run package.

Responsibilities:

- create run IDs,
- create run folder structure,
- write `user_prompt.md`,
- write `run_manifest.json`,
- write `scanner_config.json`,
- authorize scan output directory,
- write flash input artifacts,
- write flash output artifacts,
- write selected skills artifacts,
- write final prompt artifacts,
- write terminal artifacts,
- write post-run artifacts,
- update `.vibecode/current/`,
- load previous run summary.

Recommended files:

```text
core/runs/
  run_id.ts
  run_store.ts
  current.ts
  previous_summary.ts
  artifact_writer.ts
```

Precise write boundary:

```text
RunStore creates and authorizes the scan output directory.
Python may write only inside that provided scan output directory.
All non-scan .vibecode writes go through RunStore directly.
```

No scanner, prompt renderer, or UI component should randomly write files into `.vibecode/` on its own.

---

## `.vibecode/` Artifact Structure

Generated workspace folder:

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

Rules:

- `.vibecode/` is generated.
- `.vibecode/` is ignored by git.
- `.vibecode/` is not scanned as source repo content.
- `.vibecode/current/` is convenience only.
- Historical truth lives in `.vibecode/runs/<run_id>/`.
- Generated `.vibecode/` artifacts are not committed.

---

## `core/scanning`

Owns TypeScript-side orchestration of the Python deterministic scanner.

TypeScript scanning module responsibilities:

```text
create scanner_config.json
call Python scanner subprocess
pass repo/task/out paths
receive stdout JSON summary
validate scan manifest presence
surface structured diagnostics
```

Python owns the actual deterministic repository inspection.

The scanner does not decide what is important in an intelligent sense. It collects facts and evidence.

The flash model later decides which files, docs, skills, and cautions are relevant to the current user prompt.

Recommended TypeScript files:

```text
core/scanning/
  index.ts
  scanner_subprocess.ts
  scanner_config.ts
```

Recommended Python scanner files:

```text
core/scanning/python/
  pyproject.toml
  vibecode_scanner/
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

Python scanner input:

```text
repo path
task text
scanner_config.json
scan output directory
```

Python scanner output:

```text
stdout JSON summary
scan artifacts under scan/
exit code
```

---

## Deterministic Scanner Output

The Python scanner writes canonical scan artifacts:

```text
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

The scanner output includes:

1. git status and diff stat,
2. complete tree of non-ignored paths,
3. file inventory,
4. ignore rules,
5. config snapshot,
6. manifests and declared dependencies,
7. local environment and installed package summary,
8. build/test/lint/run commands,
9. AGENTS/CONTRIBUTING/instruction files,
10. documentation files,
11. architecture/vision/decision docs,
12. regex-based symbol index,
13. import/dependency map,
14. entrypoints,
15. test inventory,
16. tooling/config files,
17. API/schema/domain artifacts,
18. keyword hits from the user prompt,
19. recent git history,
20. previous Vibecode run summary,
21. terminal excerpt for follow-up repair prompts when included,
22. provenance metadata.

### Tree Scan

The tree scan should include the complete tree of non-ignored paths and files.

It should respect:

- `.gitignore`,
- common ignored folders,
- `.vibecode/` exclusion.

The tree is not artificially shortened in the foundational design.

### Git Scan

Collect:

```text
git branch --show-current
git rev-parse HEAD
git status --short
git diff --name-only
git diff --cached --name-only
git diff --stat
```

The scan should include instructions for how to get the full diff, but not automatically include the whole diff.

### Manifest and Dependency Scan

Collect and parse important manifests:

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

The scanner should identify:

- languages,
- runtimes,
- package managers,
- declared direct dependencies,
- dev dependencies,
- test frameworks,
- linters,
- formatters,
- build systems.

### Environment Scan

The environment scan is separate from the repository scan.

Repository scan answers:

```text
What does the project declare?
```

Environment scan answers:

```text
What appears to be installed locally?
```

Possible commands:

```text
python --version
pip freeze
uv pip list
node --version
npm list --depth=0
pnpm list --depth=0
cargo --version
go version
```

The architecture should keep these facts clearly separated.

### Command Scan

Collect build/test/lint/run commands from:

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

Output should preserve command provenance.

Example:

```json
{
  "test": [
    {
      "command": "pytest",
      "source": "pyproject.toml"
    }
  ]
}
```

### Instruction Scan

Collect:

```text
AGENTS.md
CLAUDE.md
GEMINI.md
CONTRIBUTING.md
.github/pull_request_template.md
.github/ISSUE_TEMPLATE/*
docs/CONTRIBUTING.md
```

These documents provide rules and conventions for agents and contributors.

### Documentation Scan

Collect full content for primary documentation files when present:

```text
README.md
docs/*.md
docs/**/*.md
VISION.md
ARCHITECTURE.md
ARCHITECTURE_DECISIONS.md
IMPLEMENTATION_MAP.md
ROADMAP.md
DESIGN.md
CHANGELOG.md
```

Primary docs are intentionally included generously at first. If this becomes too large, limits can be introduced later based on actual failure modes.

### Symbol Scan

Start with regex-based symbol extraction. Full AST parsing can be introduced later.

Extract common symbols:

Python:

```text
class X
def y(...)
async def z(...)
@app.command
@app.route
```

TypeScript/JavaScript:

```text
export function
export class
export interface
export type
function X
const X =
```

Output should include source path, symbol name, kind, signature/line excerpt, line number, and extraction method.

### Import Scan

Collect simple import relations:

- local imports,
- external imports,
- file-to-module relationships where feasible.

This is an orientation map, not a perfect compiler-grade graph.

### Entrypoint Scan

Collect:

```text
console_scripts in pyproject.toml
package.json bin/scripts
main.py
__main__.py
src/app/cli/*
server startup files
app startup files
```

### Test Scan

Collect:

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

Perform simple test-source pairing, for example:

```text
tests/test_preflight.py -> src/.../preflight.py
store.test.ts -> store.ts
```

No relevance scoring is required.

### Keyword Hits

Extract keywords from the user prompt and perform mechanical path/symbol/doc heading matches.

This is not relevance scoring.

The output should say:

```text
This keyword matched these files/symbols.
```

It should not claim:

```text
This file is 87% relevant.
```

---

## `core/skills`

Owns VibecodeLight-managed skills.

Skill rules:

- TypeScript owns the skills system.
- Primary skills are stored in the user profile.
- Project skills can be copied explicitly into `SKILLS/` in the project root.
- Project `SKILLS/` is outside `.vibecode/`.
- `.vibecode/` never owns source skills.
- Copying skills into `SKILLS/` creates a snapshot.
- No silent sync or silent overwrite.
- Whether `SKILLS/` is committed or ignored is configurable.

Recommended user-profile structure:

```text
<UserProfile>/VibecodeLight/skills/
  default/
    skill-id/
      SKILL.md
      skill.yaml
  user/
    skill-id/
      SKILL.md
      skill.yaml
```

Recommended project snapshot structure:

```text
SKILLS/
  skill-id/
    SKILL.md
    skill.yaml
```

Recommended modules:

```text
core/skills/
  skill_store.ts
  catalog.ts
  copy.ts
  selected.ts
  validators.ts
```

### Skill Catalog

The flash model receives the skill catalog, not the full content of all skills.

Catalog metadata should include:

```text
id
title
summary
tags
source
path
scope
```

The flash model selects relevant skills for each prompt.

Then VibecodeLight loads the full content of the selected skills and includes it in the prompt package.

Python scanner may see `SKILLS/` as ordinary repository files. It must not build the canonical skills catalog.

---

## `core/context`

Owns flash input construction and context pack handling.

Recommended modules:

```text
core/context/
  flash_input_builder.ts
  flash_input_manifest.ts
  flash_tool_context.ts
  markdown_flash_output_parser.ts
  context_pack_store.ts
```

Responsibilities:

- gather scan artifacts,
- gather skill catalog,
- gather previous run summary,
- include terminal excerpt only when relevant,
- create `flash_input_manifest.json`,
- create human-readable `flash_input.md`,
- call flash model through LLM adapter,
- store `flash_output.md`,
- optionally extract `flash_output_meta.json`,
- store `context_pack.md`,
- store `selected_skills.json`.

### Flash Model Role

The flash model receives deterministic material and can use read-only tools.

Its job is to produce a structured Markdown output:

```text
flash_output.md
```

Required initial sections:

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

Future JSON flash output may be introduced later, but Markdown is the initial contract.

If JSON mode is later introduced, `flash_output.json` must be schema-validated before use.

The flash model may decide which repository files are relevant.

The flash model may decide which skills are relevant.

The flash model may provide cautions, but cautions should be labeled as cautions unless they are directly supported by deterministic facts.

---

## Flash Model Tools

The architecture must support read-only flash tools.

Initial tool set:

```text
read_file(path)
list_dir(path)
read_artifact(name)
search_text(query)
```

Possible future read-only tools:

```text
read_symbol(path, symbol)
search_symbols(query)
search_docs(query)
get_git_diff(path)
get_test_file_for(path)
```

Rules:

- Tools are read-only.
- Tool calls are logged.
- Tool responses are stored or reproducible.
- Tools must respect the workspace boundary.
- Tools must not expose `.vibecode/` as target repo content unless reading VibecodeLight artifacts explicitly through `read_artifact`.
- Tools are owned and authorized by TypeScript.

The flash model should not freely browse the filesystem. It should use controlled tools exposed by VibecodeLight.

---

## `core/prompting`

Owns final prompt rendering.

Recommended modules:

```text
core/prompting/
  renderer.ts
  templates.ts
  prompt_package.ts
  preview.ts
```

Important distinction:

```text
context_pack.md = flash model context output
final_prompt.md = deterministic prompt rendered from stored pieces
```

The final prompt is assembled from:

- original user prompt,
- context pack,
- selected skill contents,
- relevant file list,
- commands to run,
- cautions,
- instruction block,
- optional target-tool formatting.

Default behavior:

```text
final_prompt.md must be created and previewable before send.
```

The user may enable auto-approve, but preview-required is the safer default.

Prompt renderer rules:

- no hidden prompt text after preview,
- no mutation after approval,
- what is shown is what is sent,
- all final prompts are stored.

---

## `core/terminal`

Owns terminal session metadata and transcript policy.

It does not own low-level PTY process handling.

Recommended modules:

```text
core/terminal/
  session.ts
  transcript.ts
  send_policy.ts
```

Responsibilities:

- identify active terminal session,
- track working directory,
- track whether transcript logging is enabled,
- provide recent terminal excerpt for follow-up repair prompts when requested,
- expose send metadata to the run package.

### Terminal Mode

The initial implementation does not try to detect whether the terminal is shell, Hermes, OpenCode, Codex, or another interactive tool.

Initial policy:

```text
VibecodeLight behaves like communication with a real terminal.
The user remains responsible for the active terminal state when sending a prompt.
```

Future adapters or send policies may improve target-specific behavior, but no complex automatic terminal-mode detection is part of the initial architecture.

---

## `adapters/pty`

Owns real terminal process communication.

Recommended modules:

```text
adapters/pty/
  pty_session.ts
  windows_pty.ts
  process_io.ts
  paste.ts
```

Responsibilities:

- spawn shell,
- connect to real PTY,
- write prompt text,
- read output,
- resize,
- terminate process,
- handle encoding,
- handle Windows-specific PTY behavior,
- support multiline paste/send behavior.

This is likely one of the hardest technical areas.

Keep it isolated.

Do not mix PTY code with context generation or UI state.

---

## `adapters/llm`

Owns model provider access.

Recommended modules:

```text
adapters/llm/
  base.ts
  openrouter.ts
  openai.ts
  local.ts
  tool_runner.ts
  schemas.ts
```

Provider support should be generic from the beginning, even if the first implementation only supports one provider.

Core should call an interface such as:

```text
FlashModel.generateContext(input, tools) -> MarkdownFlashOutput
```

Core should not know whether the provider is OpenRouter, OpenAI, local, or a custom endpoint.

Live provider tests are explicit only.

Default tests use mocks.

---

## `adapters/git`

Owns git command execution.

Recommended modules:

```text
adapters/git/
  git_cli.ts
  status.ts
  diff.ts
  history.ts
  commit.ts
```

Core scanners and post-run logic should ask the git adapter for structured data, rather than shelling out directly from random files.

Git adapter responsibilities:

- status,
- diff stat,
- changed files,
- history,
- deterministic per-run commit creation,
- later revert support.

---

## `adapters/env`

Owns local environment inspection.

Recommended modules:

```text
adapters/env/
  python.ts
  node.ts
  rust.ts
  go.ts
```

Environment scan must be separate from declared project dependencies.

---

## CLI Architecture

The CLI is not optional decoration. It is the debug and reproducibility interface.

The desktop app can fail. Electron can fail. PTY can fail. The core must still be testable.

### Public/stable CLI

```text
vibecode init
vibecode scan "task"
vibecode prompt "task"
vibecode runs list
vibecode runs show latest
vibecode skills list
vibecode skills copy <skill-id>
```

### Debug/internal CLI

```text
vibecode doctor
vibecode run create "task"
vibecode context-build "task"
vibecode flash validate <path>
vibecode flash run latest
vibecode terminal demo
```

### Internal scanner CLI

```text
vibecode-scan --help
vibecode-scan --repo . --task "task"
python -m vibecode_scanner --repo . --task "task"
```

Expected CLI capabilities:

- run deterministic scan,
- generate run package,
- call flash model,
- render final prompt,
- print artifact paths,
- reproduce failures outside the desktop UI.

Codex/LLM models building the app should be able to use CLI commands to test and debug behavior.

---

## Config

Project config file:

```text
config.yaml
```

It lives in the selected repo root.

Recommended initial shape:

```yaml
repo:
  name: ""

context:
  include_previous_run_summary: true
  include_terminal_excerpt_for_followups: true

skills:
  project_dir: "SKILLS"
  project_skills_policy: "configurable"

commands:
  preferred_test: ""
  preferred_lint: ""
  preferred_build: ""

models:
  flash_provider: ""
  flash_model: ""
```

Keep this file small.

It should provide overrides, not become a giant policy engine.

TypeScript owns config. Python receives only `scanner_config.json`.

---

## Prompt Run Flow

```text
1. User writes prompt in Vibecode composer.
2. RunStore creates a new run.
3. Workspace loads config and paths.
4. TypeScript writes scanner_config.json.
5. Python scanner writes deterministic scan artifacts.
6. TypeScript builds skills catalog from user profile and project SKILLS/ snapshot.
7. Previous run summary is loaded.
8. Terminal excerpt is included only when relevant or explicitly requested.
9. FlashInputBuilder creates flash input artifacts.
10. Flash model receives flash input and read-only tools.
11. Flash model returns structured flash_output.md.
12. TypeScript parses/stores context pack, selected skills, relevant files, commands, cautions.
13. Selected skill contents are loaded.
14. PromptRenderer builds final_prompt.md.
15. User previews final_prompt.md by default.
16. User approves, or auto-approve sends it directly if enabled.
17. PTY adapter sends the prompt into the active terminal.
18. RunStore saves terminal excerpt and send metadata.
19. RunStore/Git adapter saves post-run git/check artifacts.
20. VibecodeLight creates a deterministic git commit for the run result.
```

---

## What Goes to the Flash Model

The flash model receives scan material and read-only tool access.

It receives:

- task prompt,
- run metadata,
- git state,
- diff stat,
- complete non-ignored repo tree,
- file inventory,
- manifest/dependency summary,
- environment summary,
- commands,
- repo instructions,
- docs,
- architecture docs,
- symbol index,
- import map,
- entrypoints,
- tests,
- tooling,
- schemas,
- keyword hits,
- recent history,
- previous run summary,
- terminal excerpt when relevant,
- skills catalog.

It may use read-only tools to inspect file contents or artifacts.

It returns structured Markdown:

```text
flash_output.md
```

containing:

- task summary,
- selected skills,
- relevant files,
- files to read with tools,
- relevant tests,
- commands to run,
- cautions,
- context pack.

---

## What Goes to the Main Model / Agent

The main model or terminal agent receives the rendered final prompt.

The final prompt includes:

- original user task,
- task-specific context pack,
- selected skill contents,
- relevant files,
- files the agent should inspect,
- suggested commands/checks,
- cautions,
- explicit instruction to use tools/read files as needed,
- instruction to keep changes scoped,
- instruction to report what was changed and how it was validated.

The main model should not receive the entire raw scan by default.

It should receive the curated and transparent output of the flash/context pipeline.

---

## Terminal Logging Policy

Default:

```text
store short terminal excerpts after prompt sends
```

Optional:

```text
store full terminal transcript
```

The full transcript can become large and may contain sensitive information. It should be opt-in.

The terminal excerpt is useful for:

- failed tests,
- traceback context,
- agent final reports,
- follow-up repair prompts.

Terminal artifacts live under:

```text
terminal/
```

Post-run git/check artifacts live under:

```text
after/
```

---

## Per-Run Commit Policy

Each model run is expected to create a deterministic git commit that captures the run result.

If tests or validation fail, the run/commit must clearly mark the failed validation state.

The failure state may be recorded in:

```text
run metadata
after/checks_summary.md
agent final report
commit message or commit body
```

Generated `.vibecode/` artifacts are not committed.

The commit captures repository changes, not VibecodeLight runtime artifacts.

Later UI/CLI should provide a way to revert changes from a run.

This rule makes every run visible in git history.

---

## Secret Handling

Initial VibecodeLight does not perform aggressive secret redaction or fixed filename censorship.

It respects ignore rules.

Users must keep secrets out of non-ignored repository files.

Provider secrets must live outside committed project files.

VibecodeLight is not a secret scanner.

Future hardening can add secret scanning/redaction, but it is not part of the initial architecture.

---

## Testing Strategy

Every core module should be testable independently.

Required test groups:

```text
scanner subprocess tests
run store tests
workspace init tests
skills catalog tests
skills copy tests
flash input builder tests
markdown flash output parser tests
prompt renderer tests
LLM adapter mocked tests
PTY adapter integration tests
CLI command tests
git commit workflow tests
```

Examples:

```text
test_tree_scan_respects_gitignore
test_workspace_init_adds_vibecode_to_gitignore
test_run_store_writes_expected_artifacts
test_skills_catalog_reads_user_profile_and_project_snapshot
test_flash_input_manifest_references_scan_artifacts
test_prompt_renderer_does_not_mutate_after_preview
test_cli_context_generates_reproducible_run
test_per_run_commit_marks_failed_validation
```

The CLI must be usable by coding agents and humans to reproduce failures without launching the desktop app.

Default tests must not call live LLM providers.

Live tests are explicit only.

Expected commands:

TypeScript:

```powershell
pnpm test
pnpm test:live
pnpm lint
pnpm typecheck
pnpm build
```

Python scanner:

```powershell
cd src/core/scanning/python
uv run pytest
uv run pytest -m live
uv run ruff check .
```

---

## Schema and Validation Strategy

Canonical cross-language schemas live under:

```text
schemas/
```

TypeScript and Python may have local model definitions, but JSON Schema files are the cross-language contract.

Important schemas:

```text
run_manifest.schema.json
scanner_config.schema.json
scan_manifest.schema.json
git_status.schema.json
file_inventory.schema.json
commands.schema.json
skills_catalog.schema.json
selected_skills.schema.json
send_metadata.schema.json
cli_response.schema.json
error.schema.json
```

Prepare for future:

```text
flash_output.schema.json
```

but the initial flash implementation is Markdown-first.

CLI JSON output should use stable response envelopes:

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

---

## Growth Path

The architecture should be ready for:

- multiple terminal sessions,
- subagent terminal sessions,
- different model providers,
- richer flash tools,
- more advanced context selection,
- JSON flash output,
- AST-based symbol extraction,
- better terminal transcript handling,
- per-run revert support,
- optional orchestration.

But these should grow from the existing module boundaries, not be hacked into the UI or one central orchestrator.

Future subagents should use the same primitives:

```text
new terminal session
new prompt run
new context pack
selected skills
final prompt
run artifacts
terminal transcript/excerpt
post-run artifacts
per-run commit
```

No separate hidden subagent system is needed at the start.

---

## Design Discipline

The codebase should remain boring and explicit.

Good shape:

```text
small modules
clear contracts
typed payloads
stored artifacts
CLI reproducibility
read-only flash tools
thin UI
adapter boundaries
Markdown-first flash output
per-run git visibility
```

Bad shape:

```text
large central files
hidden prompt mutation
UI-owned business logic
scanners making model-like decisions
provider calls scattered through core
terminal process code mixed with prompt generation
unlogged tool calls
unreproducible runs
ambiguous config ownership
Python managing skills
generated artifacts committed by accident
```

The core idea is simple:

> VibecodeLight is a modular context-and-terminal workspace where every prompt run is built from deterministic scanners, flash-model context selection, selected skills, transparent prompt rendering, a real terminal, stored artifacts, and a per-run commit.
