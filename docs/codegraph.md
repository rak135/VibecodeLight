# CodeGraph integration for VibecodeLight

## Current implementation status

CodeGraph integration is optional.

Current behavior is intentionally narrow:

- Default mode is detect-only. VibecodeLight detects whether the `codegraph` command is available and whether the repository already has `.codegraph/`, but it does not extract CodeGraph context unless you explicitly opt in.
- `use-existing` mode is read-only. VibecodeLight uses an existing initialized CodeGraph index for bounded context extraction; it never auto-initializes, auto-syncs, auto-indexes, auto-watches, or auto-serves during prompt/context build.
- If `codegraph status --json` reports pending changes, VibecodeLight records a warning and still uses the existing index as-is. It never auto-syncs to make the index fresh.
- Missing CodeGraph, missing `.codegraph/`, or CodeGraph command failures are warnings/non-fatal fallback conditions, not scan failures.
- MCP is not implemented. It remains roadmap/future work documented in `docs/codegraph_mcp_roadmap.md`.

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

- MCP server support
- `vibecode mcp serve`
- agent config installation helpers
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
