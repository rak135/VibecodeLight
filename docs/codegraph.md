# CodeGraph integration for VibecodeLight

## Current implementation status

CodeGraph integration is optional.

Current behavior is intentionally narrow:

- Default mode is detect-only. VibecodeLight detects whether the `codegraph` command is available and whether the repository already has `.codegraph/`, but it does not extract CodeGraph context unless you explicitly opt in.
- `use-existing` mode is read-only. VibecodeLight uses an existing initialized CodeGraph index for bounded context extraction; it never auto-initializes, auto-syncs, auto-indexes, auto-watches, or auto-serves during prompt/context build.
- If `codegraph status --json` reports pending changes, VibecodeLight records a warning and still uses the existing index as-is. It never auto-syncs to make the index fresh.
- Missing CodeGraph, missing `.codegraph/`, or CodeGraph command failures are warnings/non-fatal fallback conditions, not scan failures.
- MCP integration is opt-in and limited to a self-test and a print-only config helper against the **existing upstream CodeGraph MCP server**. VibecodeLight does not implement its own CodeGraph MCP server. See "CodeGraph MCP integration (Phase 1A)" below and `docs/codegraph_mcp_roadmap.md` for later phases.

## What is implemented today

### 1. Detect-only by default

Every scan records external tool detection in:

```text
.vibecode/runs/<run_id>/scan/external_tools.json
```

For CodeGraph this records whether:

- the `codegraph` command is available;
- the repository has an initialized `.codegraph/` directory.

This is detection only. Prompt/context build does not call `codegraph init`, `index`, `sync`, `watch`, or `serve` by default.

### 2. Explicit read-only use of an existing index

When you explicitly choose `use-existing`, VibecodeLight runs read-only CodeGraph commands against the existing local index:

- `codegraph status --json`
- `codegraph context ...`

This produces bounded scan-side artifacts when successful:

```text
scan/codegraph_usage.json
scan/codegraph_context.md
scan/codegraph_repo_atlas.md
scan/codegraph_repo_atlas.json
scan/repo_atlas.md
scan/repo_atlas.json
```

Notes:

- `scan/codegraph_repo_atlas.md` and `scan/codegraph_repo_atlas.json` are the canonical CodeGraph-derived Repo Atlas artifacts.
- `scan/repo_atlas.md` and `scan/repo_atlas.json` are legacy compatibility aliases written alongside the canonical names.
- These scan-side Repo Atlas artifacts are CodeGraph-derived guidance.
- They are distinct from the flash-side artifacts written later in the pipeline, especially `flash/repo_atlas.md`, which is the bounded Repo Atlas actually passed into the flash model for that run.

### 3. Flash/context pipeline integration

When CodeGraph context is available, the prompt pipeline uses it as bounded guidance only.

CodeGraph output is never treated as source truth. The contract remains:

```text
Graph suggests.
Files verify.
Tests decide.
```

The pipeline keeps deterministic scanner artifacts and source files as the primary truth and uses CodeGraph only to improve orientation and relevance selection.

### 4. Explicit user controls

Prompt/context build selection:

```text
vibecode prompt --codegraph
vibecode prompt --no-codegraph
vibecode prompt --codegraph-mode use-existing
vibecode prompt --codegraph-mode detect-only
vibecode context-build "task" --codegraph-mode use-existing
vibecode context-build "task" --codegraph-mode detect-only
```

Behavior:

- `--codegraph` selects `use-existing`
- `--no-codegraph` selects `detect-only`
- conflicting CodeGraph flags return a structured error

Desktop composer behavior matches this split:

- ON = `use-existing`
- OFF = `detect-only`

### 5. Explicit maintenance commands

Maintenance is separate from prompt/context build and must be invoked explicitly:

```text
vibecode codegraph status
vibecode codegraph init
vibecode codegraph sync
vibecode codegraph reindex
```

These commands exist so the user can manage CodeGraph intentionally.

Prompt/context build never calls them automatically.

## CodeGraph MCP integration (Phase 1A)

VibecodeLight integrates with the **existing upstream CodeGraph MCP server**. It
does not implement its own CodeGraph MCP server in this phase.

The upstream MCP server is started by CodeGraph itself:

```text
codegraph serve --mcp
```

Phase 1A adds two read-only helper commands:

```text
vibecode codegraph mcp self-test --repo <path>
vibecode codegraph mcp self-test --repo <path> --json
vibecode codegraph mcp config --agent claude --repo <path> --print
```

### Self-test

`vibecode codegraph mcp self-test` spawns the upstream CodeGraph MCP server
through stdio using the official `@modelcontextprotocol/sdk` stdio client
transport, performs the MCP `initialize` handshake, calls `tools/list`, and
verifies that the expected CodeGraph tools are exposed. The expected tools are:

```text
codegraph_status
codegraph_context
codegraph_search
codegraph_files
```

Additional upstream tools (for example `codegraph_trace`, `codegraph_callers`,
`codegraph_callees`, `codegraph_impact`, `codegraph_node`, `codegraph_explore`)
are accepted and surfaced verbatim in the result.

The self-test:

- never calls `codegraph init/sync/index/watch`
- never mutates the repository
- never calls a live LLM
- shuts the upstream child process down cleanly
- returns a structured diagnostic on failure (no stack dump in normal CLI use)

`--json` returns a canonical envelope of the form:

```json
{
  "ok": true,
  "transport": "stdio",
  "serverCommand": "codegraph serve --mcp",
  "repoRoot": "...",
  "tools": ["codegraph_status", "codegraph_context", "..."],
  "expectedToolsPresent": true,
  "missingTools": [],
  "warnings": []
}
```

### Config print

`vibecode codegraph mcp config --agent claude --print` prints a stdio MCP config
snippet that points at the upstream CodeGraph server. Phase 1A supports
`--agent claude`; other agents (for example `codex`, `opencode`, `hermes`)
return a structured `AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED` diagnostic instead of
a guessed snippet. The command is print-only — it never writes files and never
modifies external agent configs.

### What Phase 1A does not change

- CodeGraph mode defaults remain unchanged (detect-only by default).
- Prompt/context build still never calls `codegraph init/sync/index` for MCP
  reasons.

Phase 1B adds an optional MCP transport for the prompt/context pipeline (see
below). Future MCP work (agent config install, multi-agent control) lives in
`docs/codegraph_mcp_roadmap.md`.

## CodeGraph MCP transport (Phase 1B)

Phase 1B adds an **optional MCP transport** to the prompt/context pipeline. The
existing CLI adapter remains the stable default; MCP is opt-in.

CodeGraph integration has two independent concepts:

- **CodeGraph mode**: `detect-only` (default) or `use-existing`. Controls
  whether the pipeline queries CodeGraph at all.
- **CodeGraph transport**: `cli` (default), `mcp`, or `auto`. Controls *how*
  the pipeline queries CodeGraph when mode is `use-existing`.

Behaviour by transport (use-existing only):

- `cli` — invokes the existing CodeGraph CLI adapter (`codegraph context …`).
  Stable, deterministic, no MCP server is spawned.
- `mcp` — spawns the upstream MCP server (`codegraph serve --mcp`), performs
  the MCP handshake, and calls the `codegraph_context` tool. On failure the
  pipeline emits a warning and continues *without* CodeGraph context — there
  is **no silent fallback** in strict `mcp` mode.
- `auto` — prefers MCP. If the MCP call fails, the pipeline emits a
  `codegraph_transport_fallback` warning event, falls back to the CLI
  adapter, and records `fallback_used: true` in `scan/codegraph_usage.json`.

`detect-only` never queries CodeGraph, regardless of the transport setting.
The requested transport is still recorded in `scan/codegraph_usage.json`
(`transport_requested`) with `transport_used: "none"` and `used_for_context:
false`.

### How the transport is selected

- Desktop: the **CodeGraph Transport** dropdown in the composer header
  (next to the CodeGraph ON/OFF toggle). The choice is persisted in
  `localStorage` under `vibecode.codegraphTransport` and restored when the app
  reopens. Invalid persisted values fall back to `cli`.
- CLI: the same conceptual setting is persisted in the global user config
  (`%LOCALAPPDATA%/vibecodelight/config.yaml`) at
  `defaults.codegraph.transport`. Inspect and change it without starting
  CodeGraph:

  ```text
  vibecode codegraph transport get --json
  vibecode codegraph transport set cli|mcp|auto
  vibecode codegraph transport reset --json
  ```

  CLI `prompt` and `context-build` runs read this persisted setting whenever
  CodeGraph mode is `use-existing` and no internal test seam override is
  provided. prompt-level transport flags are intentionally not the primary UX;
  use the persisted setting instead. The internal `runContextBuild` helper still
  accepts `codegraphTransport` and an injectable `codegraphMcpRunner` for tests.

Behavior summary:

- `cli` remains the default and uses the existing CLI adapter.
- `mcp` is strict: no fallback to CLI; failures are surfaced and the run
  continues without CodeGraph context.
- `auto` prefers MCP and falls back to CLI on MCP failure, recording
  `fallback_used: true` in `scan/codegraph_usage.json`.
- `detect-only` never calls CodeGraph context through CLI or MCP, regardless of
  the selected transport.

Verification:

```text
vibecode codegraph mcp self-test --repo <path> --json
vibecode context-build "task" --codegraph-mode use-existing --json
vibecode runs show latest --artifact codegraph
```

### `scan/codegraph_usage.json` (Phase 1B fields)

```jsonc
{
  "mode": "use-existing",
  "used": true,
  "used_for_context": true,
  "transport_requested": "auto",
  "transport_used": "cli",
  "mcp_attempted": true,
  "fallback_used": true,
  "fallback_reason": "MCP context failed; fell back to CLI. …",
  "reason": "EXISTING_INDEX",
  "warnings": ["CodeGraph MCP failed; fell back to CLI."],
  "context_artifact": "scan/codegraph_context.md",
  "artifact": "scan/codegraph_context.md"
}
```

Legacy `artifact` and `used` fields are preserved alongside the new
`context_artifact` / `used_for_context` fields for back-compat.

### What Phase 1B does not change

- CLI remains the default transport; nothing about existing CLI behaviour
  changes.
- MCP is never required; the pipeline still works without `codegraph` on PATH.
- Prompt/context build still never calls `codegraph init/sync/index/watch`,
  regardless of transport.
- Task Normalizer behaviour and `final_prompt.md` rendering are unchanged.
- There is no VibecodeLight-owned CodeGraph MCP server; the MCP transport
  talks to the upstream `codegraph serve --mcp` process only.

## Current artifact map

### Scan-side detection/use artifacts

```text
scan/external_tools.json          # detect-only availability/init state
scan/codegraph_usage.json         # whether CodeGraph context was used and why
scan/codegraph_context.md         # bounded read-only context from existing index
scan/codegraph_repo_atlas.md      # canonical CodeGraph-derived Repo Atlas (markdown)
scan/codegraph_repo_atlas.json    # canonical CodeGraph-derived Repo Atlas (json)
scan/repo_atlas.md                # legacy alias of codegraph_repo_atlas.md
scan/repo_atlas.json              # legacy alias of codegraph_repo_atlas.json
```

### Flash-side artifacts that may consume CodeGraph-derived guidance

```text
flash/repo_atlas.md
flash/task_slice.md
flash/relevance_selection.json
flash/flash_input_budget.json
```

The important distinction is:

- `scan/codegraph_repo_atlas.*` = CodeGraph-derived scan artifacts
- `flash/repo_atlas.md` = flash-input artifact for this specific run

## What is intentionally not implemented

The following are not part of the current implementation:

- a VibecodeLight-owned CodeGraph MCP server (Phase 1A integrates with the
  upstream `codegraph serve --mcp` server only)
- `vibecode mcp serve` (VibecodeLight MCP gateway)
- agent config installation helpers (Phase 2 — Phase 1A only prints snippets)
- HTTP server mode
- background watch/serve/index orchestration during prompt build
- automatic CodeGraph installation or updates
- automatic writes to external agent configs

If you see those ideas elsewhere, treat them as roadmap material, not current supported behavior.

## Roadmap / future work

Future MCP/server/tooling ideas are preserved in:

```text
docs/codegraph_mcp_roadmap.md
```

Planned phase ordering for that future work:

1. Phase 1: flash model tools first
2. Phase 2: main model / terminal agent tools later

That roadmap is intentionally separate so this file stays aligned with the code that exists today.
