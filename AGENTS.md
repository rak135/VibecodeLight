# AGENTS.md

This file is the operational working guide for coding agents operating in this repository.

It applies to Codex, OpenCode, Hermes, and any other agent or subagent working on VibecodeLight.

The goal is simple:

```text
Keep the repo modular.
Keep the implementation checkpoint-driven.
Keep runs reproducible.
Keep prompts visible.
Keep TypeScript and Python ownership clean.
Do not turn VibecodeLight into a tangled agent framework.
```

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

If the task or documents conflict, stop and report the conflict clearly instead of silently choosing one side.

---

# Required Project Context

Before implementation work, inspect the relevant project documents.

Recommended reading order:

```text
1. AGENTS.md
2. ARCHITECTURE_DECISIONS.md
3. IMPLEMENTATION_MAP.md
4. ARCHITECTURE.md when module boundaries are unclear
5. CONTEXT.md when context/scan/prompt artifacts are touched
6. VISION.md for product-level intent
```

You do not need to reread every document in full for every tiny edit, but you must understand the relevant checkpoint, ownership boundaries, generated artifact rules, and test expectations.

---

# Skill Discipline

Use the project skills when they are available.

Required skills for normal implementation work:

```text
test-driven-development
subagent-driven-development
```

Use this skill when debugging failures:

```text
systematic-debugging
```

Practical consequences:

```text
write tests before production code
verify the RED failure
implement the smallest GREEN change
run targeted tests
run broader relevant tests
refactor only after green
keep work scoped to the checkpoint
```

Do not bypass TDD just because the change looks small.

For bug fixes, reproduce the bug with a failing test first.

For debugging, isolate the failure, prove the cause, apply the smallest fix, and keep a regression test.

---

# Current Build Priority

The project must start with the documentation/baseline checkpoint, then the code scaffold checkpoint.

Initial priority:

```text
documentation/baseline alignment
repository scaffold
workspace init
run store
CLI smoke tests
Python scanner CLI skeleton
```

Do not start with advanced desktop UX.

Do not start with subagent orchestration.

Do not start with relevance scoring.

Do not start with full AST parsing.

Build the reproducible CLI/core path first.

---

# Implementation Order

Work only on the requested checkpoint and its direct acceptance tests.

Follow `IMPLEMENTATION_MAP.md`.

Practical order:

```text
CLI/core before real desktop behavior
run artifacts before terminal sending
deterministic scan before flash compression
single-agent flow before subagent orchestration
prompt preview before auto-send behavior
per-run commit visibility before orchestration
```

If a requested task asks for something outside the current checkpoint, report that clearly and implement only what is required.

---

# Repository Structure

Expected canonical structure:

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
      task_normalizer/

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

Add new modules under the correct subsystem.

Prefer small focused modules over large central files.

Do not introduce a competing top-level Python architecture.

---

# TypeScript / Python Ownership

Keep this boundary clean.

## TypeScript owns

```text
main CLI command: vibecode
workflow orchestration
workspace initialization
global/local Vibecode config
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

## Python owns

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

Python may write only inside the scan output directory provided by TypeScript:

```text
.vibecode/runs/<run_id>/scan/
```

All non-scan `.vibecode/` writes go through RunStore directly.

Python must not write:

```text
config.yaml
.gitignore
SKILLS/
.vibecode/current/
.vibecode/runs/<run_id>/output/
.vibecode/runs/<run_id>/flash/
.vibecode/runs/<run_id>/skills/
.vibecode/runs/<run_id>/terminal/
.vibecode/runs/<run_id>/after/
target repo source files
```

---

# CLI Contracts

The main CLI is owned by TypeScript:

```text
vibecode
```

The internal scanner CLI is owned by Python:

```text
vibecode-scan
python -m vibecode_scanner
```

## Public/stable CLI

```powershell
vibecode init
vibecode scan "task"
vibecode prompt "task"
vibecode runs list
vibecode runs show latest
vibecode skills list
vibecode skills copy <skill-id>
vibecode mcp serve --repo <path>
vibecode mcp tools
vibecode mcp config --agent codex --repo <path> --print
vibecode mcp config --agent codex --repo <path> --json
vibecode mcp install --agent codex --repo <path> --dry-run
vibecode mcp install --agent codex --repo <path> --yes
vibecode mcp doctor --agent codex --repo <path>
vibecode mcp config --agent claude --repo <path> --print
vibecode mcp config --agent claude --repo <path> --json
vibecode mcp install --agent claude --repo <path> --dry-run
vibecode mcp install --agent claude --repo <path> --yes
vibecode mcp doctor --agent claude --repo <path>
vibecode agent-guidance status --agent claude --repo <path> --json
vibecode agent-guidance status --agent codex --repo <path> --json
vibecode agent-guidance apply --agent claude --repo <path> --dry-run --json
vibecode agent-guidance apply --agent claude --repo <path> --yes --json
vibecode agent-guidance apply --agent codex --repo <path> --dry-run --json
vibecode agent-guidance apply --agent codex --repo <path> --yes --json
vibecode agent-guidance preflight --repo <path> --terminal --json
vibecode agent-guidance preflight --repo <path> --terminal --mode check_only --json
vibecode agent-guidance preflight --repo <path> --terminal --mode auto_repair --json
```

`vibecode mcp serve` starts a repo-bound stdio MCP server exposing the
VibecodeMCP v1 public surface: exactly 14 tools. MCP-capable agents entering
this repo should **start with `vibecode_session_start` and
`vibecode_workspace_snapshot`** to establish identity, learn the bound repo,
CodeGraph status, git state, claims, and current run; then use the v1
CodeGraph/run/artifact tools for deeper navigation. Build-mode agents must
claim exact paths with `vibecode_build_start` before editing and finish with
`vibecode_build_finish`; MCP does not commit. MCP-capable agents should prefer
these tools over grep/find for repo navigation and over opening
`.vibecode/runs/...` files by hand. Agents without MCP support use the
equivalent CLI commands
(`vibecode codegraph status|search|context|files|callers|callees|impact`
and `vibecode runs list` / `vibecode runs show latest --artifact <name>`).
Both call the same Vibecode core services. Approvals / permission settings
remain controlled by the MCP client/agent (Codex `/mcp`, Claude managed
approvals UI) — Vibecode does not manage Claude or Codex approvals.

`vibecode mcp config|install|doctor --agent codex` manages only Codex
`[mcp_servers.vibecode]` configuration. It preserves unrelated Codex settings,
does not write secrets, backs up existing config before writes, and reports
that Codex must be restarted or reloaded after installation.

`vibecode mcp config|install|doctor --agent claude` uses the Claude Code CLI
(`claude mcp add-json`) to register only the repo-bound VibecodeMCP stdio
server. Default Claude scope is `local`; `--scope user|project` is explicit.
Vibecode does not manage Claude approvals or permissions and does not mutate
Claude settings, allowedTools/deniedTools, hooks, or permission profiles.

## Debug/internal CLI

```powershell
vibecode doctor
vibecode run create "task"
vibecode context-build "task"
vibecode flash validate <path>
vibecode flash run latest
vibecode terminal demo
```

## Internal scanner CLI

```powershell
vibecode-scan --help
vibecode-scan --repo . --task "task"
python -m vibecode_scanner --repo . --task "task"
```

Agent-facing commands should support `--json` where relevant.

When adding CLI behavior, keep output stable and machine-readable.

Use structured diagnostics, not raw tracebacks, for expected user or validation errors.

---

# Config Rules

Never treat <repo>/config.yaml as Vibecode configuration.

Vibecode-owned config layers are:

```text
1. Global user config: %LOCALAPPDATA%/vibecodelight/config.yaml
2. Repo-local Vibecode config: <repo>/.vibecode/config.yaml
3. Explicit per-run options / CLI flags / GUI state passed into the run
4. Generated run artifacts under <repo>/.vibecode/runs/<run_id>/
5. Renderer localStorage for pure UI state only, never semantic pipeline settings
6. Dedicated Agent Guidance config: %LOCALAPPDATA%/vibecodelight/agent-guidance-config.yaml
```

Agent Guidance config (layer 6) is a separate file, never merged into the root global config.yaml or .vibecode/config.yaml. It stores enable/disable, default guidance text, per-tool notes for terminal agents, and Terminal Agent Preflight policy. It is inspectable/editable/resettable from the desktop Settings UI. VibecodeMCP exposes this editable guidance through `vibecode_mcp_guidance`, compact workspace guidance status, SDK server instructions when supported, and bounded per-tool description suffixes. This layer does NOT inject hidden text into the PTY, does NOT mutate final_prompt.md after preview, and does NOT modify Claude/Codex approvals or permissions. `vibecode agent-guidance apply` only ensures Claude/Codex point at the repo-bound VibecodeMCP server; it does not write guidance into AGENTS.md, CLAUDE.md, root config.yaml, terminal stdin, or approval/permission settings. Terminal Agent Preflight runs when opening new Vibecode terminals to check or safely repair supported agent VibecodeMCP config according to this dedicated policy; it does not start agents and does not send text into the terminal. Existing MCP sessions may need restart/reconnect after guidance changes.

Terminal Agent Preflight settings live in the same dedicated file:

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

The root config.yaml belongs to the target project. VibecodeLight must not create, read, write, or interpret <repo>/config.yaml as Vibecode settings. If root config.yaml appears in scans/context, it is only an ordinary target project file.

TypeScript owns the global user config and repo-local `.vibecode/config.yaml` resolution.

Python scanner receives resolved scanner configuration through:

```text
.vibecode/runs/<run_id>/scanner_config.json
```

Python must not independently interpret `config.yaml`.

The scanner writes the resolved scan-side snapshot to:

```text
.vibecode/runs/<run_id>/scan/config_snapshot.json
```

Do not introduce:

```text
.vibecode/config.json
scan/config.json
```

---

# Generated Files and Ignored Paths

`.vibecode/` is generated working state.

It must be ignored by git.

It must not be scanned as source repository content.

Do not commit:

```text
.vibecode/
node_modules/
dist/
build/
coverage/
__pycache__/
.venv/
temporary logs
generated run artifacts
```

Agents may read generated files for debugging.

Agents may temporarily modify generated files only when debugging the generated-artifact pipeline, and must then either revert the change or clearly report the exact manual change needed for reproduction.

Do not treat generated artifacts as canonical source.

---

# SKILLS Directory

`SKILLS/` is a project-level skills snapshot.

It is outside `.vibecode/`.

Do not auto-sync skills.

Do not silently rewrite skills.

Only copy or modify skills when the task explicitly asks for it.

Primary skills live in the user profile. `SKILLS/` contains project snapshots copied by explicit user action.

Commit behavior for `SKILLS/` is controlled by project configuration and task intent.

---

# Artifact Rules

Every prompt/run must be reproducible.

A run should create artifacts under:

```text
.vibecode/runs/<run_id>/
```

Canonical run layout:

```text
.vibecode/runs/<run_id>/
  user_prompt.md
  task_intent.json          # task normalizer output
  task_intent.md            # human-readable task intent summary
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

`final_prompt.md` is the truth.

What is in `final_prompt.md` is what gets sent to the terminal.

Do not add hidden prompt text after preview.

---

# `.vibecode/current/`

`.vibecode/current/` is only a convenience mirror/pointer.

Historical truth is always:

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

Do not put raw scan or flash-input truth only in `current/`.

Read raw material from the historical run folder.

---

# Flash Model Rules

TypeScript owns LLM providers and flash model calls.

Python scanner must not call LLM providers.

Default tests must not call real model providers.

Live model calls are allowed only through explicit live test commands or explicit user request.

Flash tools are read-only:

```text
read_file(path)
list_dir(path)
read_artifact(name)
search_text(query)
```

All flash tool calls must be logged:

```text
.vibecode/runs/<run_id>/flash/tool_calls.json
```

---

# Markdown-First Flash Output

Initial flash output is Markdown-first.

Canonical initial artifact:

```text
.vibecode/runs/<run_id>/flash/flash_output.md
```

Expected stable sections:

```text
Task Summary
Relevant Files
Files To Read With Tools
Relevant Tests
Commands To Run
Selected Skills
Cautions
Context Pack
```

Optional extracted metadata:

```text
.vibecode/runs/<run_id>/flash/flash_output_meta.json
```

Future JSON flash output is allowed, but it must be schema-validated when introduced.

If JSON mode is active in the future and validation fails, do not create `final_prompt.md` from invalid JSON output.

Initial implementation must not require `flash_output.json`.

---

# Testing Rules

Use TDD for implementation work.

Required flow:

```text
RED: write or update tests first
RED: run and confirm expected failure
GREEN: implement smallest behavior that passes
GREEN: run targeted tests
REGRESSION: run broader relevant tests
REFACTOR: clean only while tests remain green
```

Default tests use mocks for model providers.

Live provider tests are explicit only.

## TypeScript commands

Expected commands:

```powershell
pnpm install
pnpm test
pnpm test:live
pnpm lint
pnpm typecheck
pnpm build
```

Some commands may not exist in the earliest scaffold. When unavailable, report that clearly.

## Python scanner commands

Expected commands:

```powershell
cd src/core/scanning/python
uv sync
uv run pytest
uv run pytest -m live
uv run ruff check .
```

Some commands may not exist in the earliest scaffold. When unavailable, report that clearly.

## Live tests

Use live tests only when explicitly requested:

```powershell
pnpm test:live
uv run pytest -m live
```

Live tests should be token-efficient.

Provider secrets must not be committed.

---

# Test Discipline

Test public behavior, artifact contracts, safety boundaries, parser/validator behavior, and real regressions.

Do not test:
- private helper names or internal structure
- incidental import paths or source-grep patterns
- exact growing-list counts (use named constants or derive from canonical lists like `VIBECODE_MCP_TOOL_NAMES.length`)
- cosmetic DOM/theme/layout assertions
- node_modules layout

Characterization tests must self-declare with a top-of-file comment explaining:
- what exact temporary behavior they pin
- which canonical test should replace it
- when it should be removed
- "Do not add new assertions here."

Default tests must not call live providers. Tests using fake/mock adapters must be named `fake_*` or `mock_*`, not `live_*`. Real `live_*` tests are allowed only when explicitly gated by an environment variable and excluded from default provider calls.

Every new test must justify the protected invariant: what breaks if this test is removed?

---

# Development Environment

Primary development environment is Windows PowerShell.

Use cross-platform paths where possible.

Do not assume WSL.

Do not introduce Docker or WSL as a required development dependency unless explicitly requested.

Keep the project runnable on a normal Windows development machine.

---

# Documentation Edits

Agents may update documentation when implementation changes the documented contract.

Allowed:

```text
update README when CLI commands change
update README when setup/test commands change
update README when generated artifact expectations change
update ARCHITECTURE_DECISIONS.md only when an implementation decision is explicitly changed
update IMPLEMENTATION_MAP.md only when checkpoint criteria are intentionally changed
```

Do not casually rewrite architecture documents.

Do not edit these unless the task explicitly asks for architecture or documentation changes:

```text
VISION.md
CONTEXT.md
ARCHITECTURE.md
IMPLEMENTATION_MAP.md
ARCHITECTURE_DECISIONS.md
```

If a code change forces a documentation change, make the smallest required doc update and explain it in the final report.

## README update rule

If the implementation changes user-facing commands, setup steps, test commands, generated artifact locations, or development workflow, perform a minimal README update.

Do not rewrite the whole README.

Keep the existing README structure.

Make the smallest targeted change that keeps README accurate.

Do not add fake badges, fake links, or marketing filler.

---

# Modularity Rules

Prefer adding small focused modules to the correct subsystem.

Good:

```text
src/core/scanning/python/vibecode_scanner/scan/tree_scan.py
src/core/runs/store.ts
src/core/prompting/renderer.ts
src/adapters/llm/openrouter.ts
```

Avoid dumping unrelated behavior into large central files.

Keep UI thin.

Keep scanner deterministic.

Keep provider calls out of scanner code.

Keep prompt rendering in TypeScript.

Keep repo modification logic out of Python scanner.

---

# Temporary Debugging Changes

Agents may read ignored/generated files for debugging.

Agents may make temporary debugging edits only when necessary to isolate a problem.

If you make such a change:

```text
1. explain why
2. keep it local and minimal
3. revert it before finalizing unless explicitly requested
4. report exactly what was changed and how to reproduce the test
```

Do not commit temporary debugging changes.

---

# Secret Handling

Initial VibecodeLight does not perform aggressive secret redaction or fixed filename censorship.

It respects ignore rules.

Users are responsible for keeping secrets out of non-ignored repository content.

Provider secrets must live outside committed project files.

Do not commit provider secrets, API keys, tokens, `.env`, or local credential files.

VibecodeLight is not a secret scanner.

---

# Per-Run Commit Policy

Each model run is expected to create a deterministic git commit that captures the run result.

If tests or validation fail, the run/commit must clearly mark the failed validation state.

Generated `.vibecode/` artifacts are not committed.

The commit captures repository changes, not VibecodeLight runtime artifacts.

Later UI/CLI should provide a way to revert changes from a run.

This policy is product-level and must not be silently weakened into “commit proposal only”.

---

# Agent Commit Discipline

For coding-agent implementation tasks, create a scoped commit after successful implementation work unless explicitly told not to.

Do not push.

Do not open a PR unless explicitly asked.

Before committing:

```text
git status
run relevant tests
ensure no unrelated files are included
ensure generated files are not committed
ensure .vibecode/ is ignored
```

Commit message should be concise and scoped.

Prefer conventional style when reasonable:

```text
feat(cli): add workspace init command
test(scanner): cover repo tree scan
fix(runs): preserve current run pointer
docs(readme): update CLI command list
```

Do not commit broken tests unless the task explicitly requires committing a failed-validation run state.

Do not commit unrelated cleanup.

For implementation work, if tests fail and the task is not specifically testing failed-run behavior, report the failure instead of pretending success.

---

# Final Report Required

Every implementation task must end with a concise final report.

Include:

```text
summary of what changed
changed files
tests run
test results
known limitations
generated artifacts created, if relevant
README update performed, if relevant
commit hash, if committed
anything not done
```

Do not claim success if tests were not run.

If tests could not be run, say why.

If live tests were not run, say that they were not requested or not available.

If you found a document conflict, mention it clearly.

---

# Handling Ambiguity

If the task is ambiguous, implement the smallest behavior that satisfies the current checkpoint and existing docs.

If the task conflicts with `ARCHITECTURE_DECISIONS.md`, stop and report the conflict.

If a required command or package script does not exist yet, either add it if the checkpoint requires it or report it as not yet available.

Do not invent broad new architecture without explicit instruction.

Do not silently reinterpret the TypeScript/Python boundary.

---

# Practical Build Mantra

```text
Tests before code.
CLI before GUI.
Artifacts before automation.
Markdown flash output before JSON flash mode.
Real terminal before composer send.
Single-agent reliability before subagents.
Visible prompt before model execution.
Per-run commit before orchestration.
Minimal README updates when behavior changes.
```
