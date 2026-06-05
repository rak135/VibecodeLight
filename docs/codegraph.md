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

### 6. Agent-facing read-only query commands

VibecodeLight exposes a small read-only query namespace on top of an existing
initialized CodeGraph index. These are **provider-agnostic shell commands**.
Any terminal agent (Claude Code, Codex, Hermes, opencode, anything that can run
a shell) can use them; they are not native MCP tools and VibecodeLight does not
ship its own CodeGraph MCP server for them. Native MCP integration for
individual agents remains optional future work.

```text
vibecode codegraph search   "<query>"            --repo <path> [--max-results <n>] [--json] [--timeout <ms>] [--run-id <id>]
vibecode codegraph context  "<query>"            --repo <path> [--max-nodes <n>] [--max-code <n>] [--json] [--timeout <ms>] [--run-id <id>]
vibecode codegraph files                         --repo <path> [--limit <n>] [--json] [--timeout <ms>] [--run-id <id>]
vibecode codegraph callers  "<symbol>"           --repo <path> [--limit <n>] [--json] [--timeout <ms>] [--run-id <id>]
vibecode codegraph callees  "<symbol>"           --repo <path> [--limit <n>] [--json] [--timeout <ms>] [--run-id <id>]
vibecode codegraph impact   "<path-or-symbol>"   --repo <path> [--limit <n>] [--json] [--timeout <ms>] [--run-id <id>]
```

#### Logging

Every agent-facing CodeGraph query command appends a single JSONL event to a
workspace-level log:

```text
<repo>/.vibecode/logs/codegraph_queries.jsonl
```

When a run id is available **and** its directory already exists, the same event
is also appended to a run-scoped log:

```text
<repo>/.vibecode/runs/<run_id>/terminal/codegraph_queries.jsonl
```

Run id resolution priority:

1. explicit CLI option `--run-id <id>`
2. environment variable `VIBECODE_RUN_ID` (optional fallback only)
3. no run id → workspace-level log only

The latest run is **never** used as a fallback. If a run id is provided but the
matching `.vibecode/runs/<run_id>/` directory does not exist, the query still
runs, the event is still appended to the workspace log, and the logging block
records `RUN_LOG_SKIPPED_RUN_NOT_FOUND`. No fake run directory is created.

Event fields include `subcommand`, `repo_root`, `command`, bounded `input`
metadata, `ok`, `exit_code`, `duration_ms`, `warnings`, `error`, and a
`result_summary` with byte counts and parsed-JSON indicators. Logs contain
**metadata only** — full stdout and stderr are not written by default, and
environment values and secrets are never logged. Logging failures do not fail
the query command; they are surfaced as warnings in the `--json` envelope under
`log.warnings`.

Upstream mapping (verified):

| Vibecode subcommand | Upstream `codegraph` subcommand | Notes                                              |
| ------------------- | ------------------------------- | -------------------------------------------------- |
| `search`            | `query`                         | `--max-results` → `--limit`                        |
| `context`           | `context`                       | `--json` → `--format json`                         |
| `files`             | `files`                         | `--limit` is applied locally on parsed JSON output |
| `callers`           | `callers`                       | direct                                             |
| `callees`           | `callees`                       | direct                                             |
| `impact`            | `impact`                        | `--limit` → upstream `--depth`                     |

Read-only guarantees (anti-scope, enforced in tests):

- never runs `codegraph init`, `sync`, `index`, `watch`, or `serve`
- never creates `.codegraph/`
- never writes to the repository
- never calls an LLM provider
- only the allowlisted upstream subcommands `query`, `context`, `files`,
  `callers`, `callees`, `impact` are spawned

Error envelope when CodeGraph is missing or unprepared:

- `CODEGRAPH_NOT_INSTALLED` — the `codegraph` binary is not on PATH; the message
  points the agent at `vibecode codegraph status --repo <path>`.
- `CODEGRAPH_NOT_INITIALIZED` — `.codegraph/` is missing for the repo; the
  message suggests `vibecode codegraph init --repo <path>`. The query command
  does **not** auto-initialize.
- `INVALID_ARGUMENT` — empty query/symbol or non-positive numeric flag.
- `CODEGRAPH_QUERY_FAILED` — the underlying upstream command exited non-zero;
  stderr is surfaced as `error.message`.

Default human output is bounded markdown with the upstream command echoed; the
`--json` envelope is stable:

```json
{
  "ok": true,
  "command": ["codegraph", "query", "--path", "<repoRoot>", "<query>", "--json"],
  "repoRoot": "<absolute path>",
  "query": "<query>",
  "stdoutText": "<bounded raw stdout>",
  "parsedJson": <parsed JSON when --json>,
  "warnings": ["..."],
  "error": { "code": "...", "message": "..." },
  "log": {
    "workspace_log": ".vibecode/logs/codegraph_queries.jsonl",
    "run_log": ".vibecode/runs/<run_id>/terminal/codegraph_queries.jsonl",
    "warnings": []
  }
}
```

For the other read-only subcommands (`context`, `files`, `callers`,
`callees`, `impact`), the default human output is upstream stdout passed
through verbatim under a small Vibecode header. **`search` is the
exception** — see below — because the upstream text renderer for `query`
formats raw rank scores as misleading percentages.

#### Search score handling (`vibecode codegraph search`)

Upstream `codegraph query` returns an **unbounded raw ranking score** per
result (e.g. `28.7184…`, `100.73`, …). It is not a probability, not a
confidence, and not a percentage. The score is only comparable **within a
single query result set**; do not compare scores across different queries.

Upstream's own text renderer multiplies that raw score by 100 and appends
`%`, which prints absurd values like `(2872%)` or `(10073%)`. Vibecode
search output deliberately does **not** treat these as percentages:

- `vibecode codegraph search` always invokes upstream with `--json` and
  renders its own text output. Search text output never contains `%`
  appended to a score, and never prints upstream's percentage formatting.
- The text output shows rank order, the node kind/name/path/line when
  available, and `raw_score` rounded to two decimals. When the result set
  contains more than one scored result, a `relative_score` (0..1 within
  the query result set) is shown alongside.
- A one-line note at the top of the search output reminds the reader the
  score is query-relative and not a percentage.

For other CodeGraph query subcommands, upstream stdout is still surfaced
verbatim — only `search` rewrites it.

The `--json` envelope for `search` preserves the original upstream
`score` field on every result and adds explicit score metadata:

- per-result fields (when the result contained a numeric `score`):
  - `raw_score` — copy of the upstream rank score
  - `relative_score` — `raw_score / max_score_in_this_result_set` (only
    added when the maximum score in the result set is > 0)
  - `rank` — 1-indexed position in the result set
  - `score_kind: "raw_upstream_rank_score"`
  - `score_is_percentage: false`
  - `score_scope: "query_relative"`
- an envelope-level `score_meta` block with `score_kind`,
  `score_is_percentage`, `score_scope`, the observed `max_score`, and a
  short human-readable `note`.

`relative_score` is only meaningful **within one query's result set**.
Do not compare `relative_score` values across different searches.

Stale index handling: query commands surface a warning if upstream reports
pending changes but still serve the query against the existing index. They do
not auto-sync. Use `vibecode codegraph sync --repo <path>` explicitly.

Guidance for agents:

- Use `rg`/`grep` for exact strings, error messages, UI labels, and literal
  text.
- Use these CodeGraph commands for symbol search, call relationships, subsystem
  discovery, and impact analysis.

#### Effective usage guidance

Real dogfood runs show that the read-only query commands are not all equally
useful for every question. Prefer the smallest command that answers the
question; do not overuse CodeGraph.

- **`context` first.** Use `context "<query>"` for subsystem mapping and
  architecture orientation. It is the most useful command for "where does X
  live and how does it connect".
- **`search` for broad discovery.** Use it to find candidate symbols when you
  do not yet know names, but expect possibly low-signal results for
  keyword-style queries — fall back to `rg`/`grep` for literal text.
- **`callers` / `callees` need an exact indexed symbol.** They return
  "symbol not found" for names the upstream index has not surfaced. Get the
  exact name from `context` or source before running them.
- **`impact` is symbol-oriented.** Treat it as a symbol query. Do not assume
  file paths are supported as input; verify against the upstream index before
  relying on that form.
- **Verify by reading source and tests.** After CodeGraph gives you a map,
  confirm exact behaviour by reading the relevant source files and the tests
  that pin them. Graph suggests, files verify, tests decide.
- **`rg`/`grep` remain better for literals.** Use them for exact strings,
  error messages, UI labels, and any literal text.

`trace` and `explore` are intentionally **not** implemented because upstream
CodeGraph does not expose matching subcommands. They will be added only when a
verified upstream command exists.

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
below). Future MCP work beyond the Codex installer (additional agents,
multi-agent control) lives in
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

CodeGraph has two different remembered settings with different ownership:

- `desktop.codegraph.mode` remembers the Desktop GUI ON/OFF toggle only. `detect-only` means GUI OFF and still detects availability without injecting CodeGraph context; `use-existing` means GUI ON. CLI prompt/context-build runs do not consume this Desktop GUI preference and remain controlled by explicit `--codegraph`, `--no-codegraph`, or `--codegraph-mode detect-only|use-existing` flags.
- `defaults.codegraph.transport` is the intentional exception: it is shared by the Desktop GUI **CodeGraph Transport** dropdown and the CLI `vibecode codegraph transport get|set|reset` command.

- CodeGraph Transport is a shared global setting. The desktop **CodeGraph
  Transport** dropdown in the composer header and the CLI command both
  read/write the same global user config key,
  `defaults.codegraph.transport`, in `%LOCALAPPDATA%/vibecodelight/config.yaml`
  (or the equivalent platform user config path). GUI remembers the setting by using global config, not localStorage. Missing or invalid values resolve to
  `cli` (default = cli).
- Inspect and change it without starting CodeGraph:

  ```text
  vibecode codegraph transport get --json
  vibecode codegraph transport set cli|mcp|auto
  vibecode codegraph transport reset --json
  ```

  CLI `prompt` and `context-build` runs, plus desktop preview/run requests, read
  this persisted setting whenever CodeGraph mode is `use-existing` and no
  internal test seam override is provided. prompt-level transport flags are intentionally not the primary UX;
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

## VibecodeMCP server (Phase MCP-1)

VibecodeLight now ships its own native MCP server, `vibecode mcp serve --repo <path>`. It is distinct from upstream CodeGraph's MCP server: `codegraph serve --mcp` is the upstream code-intelligence server that VibecodeLight may *call* (via the existing CodeGraph MCP transport in the prompt pipeline), while `vibecode mcp serve` is a Vibecode-owned protocol adapter that any MCP client (Claude Code, Codex, OpenCode, Hermes, anything that speaks MCP) can connect to. The two coexist; one does not replace the other.

Phase MCP-1 is read-only and stdio-only. The server is bound to one repository at startup and tools do not accept a `repo` argument. Tool handlers call the same in-process core services as the CLI (`getCodeGraphStatus`, `runCodeGraphSearch`, `runCodeGraphContextQuery`, `runCodeGraphFiles`, `runCodeGraphCallers`, `runCodeGraphCallees`, `runCodeGraphImpact`) — no shell-out, no CLI text parsing, provider-agnostic by construction.

Exposed tools:

```text
vibecode_codegraph_status
vibecode_codegraph_search
vibecode_codegraph_context
vibecode_codegraph_files
vibecode_codegraph_callers
vibecode_codegraph_callees
vibecode_codegraph_impact
```

Per-call usage is recorded as bounded, secret-free JSONL at `<repo>/.vibecode/logs/mcp_tool_usage.jsonl`. stdout is reserved exclusively for the MCP JSON-RPC stream; diagnostic logs go to stderr (controlled by `--log-level info|warn|silent`).

Anti-scope for MCP-1:

- HTTP transport, multi-repo workspaces (future phase);
- broad auto-write to external agent configs;
- terminal write / shell exec / file write / git commit tools;
- arbitrary file or repo path arguments on tools;
- upstream CodeGraph maintenance (`init`/`sync`/`index`/`watch`) — explicit CLI/Desktop actions only.

Agents with MCP support use these tools. Agents without MCP support use the `vibecode codegraph ...` CLI commands above. Both paths call the same Vibecode core services.

## What is intentionally not implemented

The following are not part of the current implementation:

- a VibecodeLight-owned CodeGraph MCP server that proxies upstream CodeGraph
  (Phase 1A integrates with the upstream `codegraph serve --mcp` server as
  a client; VibecodeMCP exposes its own Vibecode-native tools instead)
- HTTP transport for VibecodeMCP (Phase MCP-1 is stdio only)
- run/artifact MCP tools (Phase MCP-2)
- non-Codex agent config installation helpers
- background watch/serve/index orchestration during prompt build
- automatic CodeGraph installation or updates
- automatic writes to external agent configs without explicit `--yes`
- terminal/shell/write/git tools on the MCP surface

### Codex MCP install

Codex is the first managed MCP client. `vibecode mcp config --agent codex --repo <path> --print` prints the TOML block for `[mcp_servers.vibecode]`; `--json` returns the same data in a stable envelope. `vibecode mcp install --agent codex --repo <path> --dry-run` previews the change without writing, and `--yes` creates or updates only `[mcp_servers.vibecode]` in Codex `config.toml`, preserving unrelated settings and backing up existing config first. `vibecode mcp doctor --agent codex --repo <path>` checks the installed block and the expected read-only tool list.

Default scope is user config (`$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when `CODEX_HOME` is unset). `--scope project` targets `<repo>/.codex/config.toml` and warns that Codex must trust the project before loading project config. Codex must be restarted or reloaded after install; use `/mcp` inside the Codex TUI to verify the active server.

### Claude Code MCP install

Claude Code is a managed MCP client for VibecodeMCP. `vibecode mcp config --agent claude --repo <path> --print` prints the JSON stdio server config and the equivalent `claude mcp add-json vibecode <server-json> --scope <scope>` command. `--json` returns a stable envelope with `server_config`, `claude_command`, `claude_args`, and warnings. `vibecode mcp install --agent claude --repo <path> --dry-run` previews the command without calling Claude, and `--yes` runs the Claude CLI from the repo root using argv execution, not shell string concatenation. `vibecode mcp doctor --agent claude --repo <path>` checks `claude --version`, `claude mcp list`, `claude mcp get vibecode`, and the expected read-only VibecodeMCP tool list.

Claude support uses Claude Code MCP config through `claude mcp add-json`. Default scope is `local`, which is private to the user/project. `--scope user` is global across projects while still binding the server to the provided repo path. `--scope project` writes project-shared MCP config and may trigger Claude project-server approval/trust behavior for `.mcp.json`. Vibecode does not manage Claude MCP approvals or approval/permission settings; Claude Code and user settings own that behavior. The installer does not mutate `.claude/settings.json`, allowedTools/deniedTools, hooks, or permission profiles, and it adds no write/shell/git/terminal tools.

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
