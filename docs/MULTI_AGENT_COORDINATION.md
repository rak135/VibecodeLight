# Multi-Agent Coordination

This document describes the **implemented** multi-agent coordination surface in
VibecodeLight. It is the operational counterpart to the design contracts in
`docs/MULTI_AGENT_CONFLICT_DESIGN.md` (conflict/handoff data model) and
`docs/MULTI_AGENT_UI_DESIGN.md` (desktop UI). Where this document and the design
docs disagree on what exists *today*, this document wins for current behavior;
the design docs remain the target for later phases.

---

## Core model

```text
Coordination is advisory.
No source files are hard-locked.
The user (and later, guards) remain the final authority.
Every coordination state change is persisted as generated state.
```

VibecodeLight does **not** take filesystem locks on source files. Agents
coordinate through advisory claims, watcher evidence, a finalize guard, and a
commit guard (later phases). Vibecode detects protocol violations rather than
preventing edits by locking.

---

## Ownership

- **TypeScript core owns coordination state and logic.** All coordination
  services live under `src/core/coordination/`. The CLI and the MCP server are
  thin adapters that call the same core services — logic is never duplicated in
  the CLI or MCP layers.
- **The Python scanner does not own coordination state.** It only continues to
  exclude `.vibecode/` (and therefore `.vibecode/coordination/`) from scans.

---

## Generated state

Coordination state is **generated working state**, not source:

```text
.vibecode/coordination/state.json
```

- It lives under `.vibecode/`, which is git-ignored and excluded from repository
  scanning (`.vibecode` is in the scanner's hard exclusion list).
- It is never committed and never treated as canonical source.
- Human-maintained configuration stays in the existing config layers (root
  `config.yaml` belongs to the target project; Vibecode config lives in the
  global user config and `.vibecode/config.yaml`). There is **no**
  `.vibecode/coordination/config.json`.

### State shape (Phase 1)

```json
{
  "version": 1,
  "workspace_root": "<repo root>",
  "last_updated": "<iso timestamp>",
  "agents": [],
  "claims": [],
  "conflicts": [],
  "handoffs": []
}
```

The collections are intentionally empty in Phase 1. Reading is **read-only**: a
missing state file yields a stable empty status and writes nothing. Generated
state is only created by the explicit, idempotent
`initializeCoordinationState`, which writes that single `state.json` and touches
no source files.

---

## First slice: status only

Phase 1 ships read-only coordination **status** and nothing else.

CLI:

```powershell
vibecode coordination status --repo <path> --json
```

MCP tool:

```text
vibecode_coordination_status
```

Both call the shared core service `src/core/coordination/status.ts` and return
equivalent data: workspace root, the state-file path and whether it exists, the
schema version, the last-updated timestamp, and counts of
agents/claims/conflicts/handoffs. The MCP tool is repo-bound (it never accepts a
repo argument) and never shells out to the CLI.

---

## Later phases (not yet implemented)

```text
agent sessions / registration
heartbeats
claims add / release (advisory)
file watcher (unauthorized-edit evidence)
finalize guard
commit guard
handoffs
desktop coordination UI panel
prompt protocol injection
```

These are specified in `docs/MULTI_AGENT_CONFLICT_DESIGN.md` and
`docs/MULTI_AGENT_UI_DESIGN.md`. None of them introduce hard source-file locks.
