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

### State shape

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

`agents` is populated by Phase 2 (agent sessions) and `claims` by Phase 3A
(advisory claims). `conflicts` and `handoffs` remain empty — they belong to
later, not-yet-implemented phases. Reading status is **read-only**: a missing
state file yields a stable empty status and writes nothing. Mutating services
(register/heartbeat, claim add/release) write only this single `state.json` and
touch no source files.

---

## Phase 1: read-only status

Phase 1 ships read-only coordination **status**.

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

## Phase 2: agent sessions and heartbeats

Phase 2 adds persistent agent sessions with heartbeat-based liveness. Agents
register, heartbeat, and are listed with a computed, stale-aware status. The
core services live in `src/core/coordination/agents.ts` and
`src/core/coordination/heartbeat.ts`.

- **Registration** records an agent session (id, name, type) in the generated
  state.
- **Heartbeat** refreshes the agent's last-seen timestamp.
- **Status computation** derives `active` / `idle` / `stale` / `terminated`
  from the heartbeat age against a fixed TTL; status is computed on read and is
  never persisted as a frozen value.

CLI:

```powershell
vibecode agents register --repo <path> --name <name> --type <type> --json
vibecode agents heartbeat --repo <path> --agent <agent_id> --json
vibecode agents list --repo <path> --json
vibecode agents status --repo <path> --agent <agent_id> --json
```

MCP tools:

```text
vibecode_agent_register
vibecode_agent_heartbeat
vibecode_agents_list
vibecode_agent_status
```

CLI and MCP are thin adapters over the same core services. The MCP tools are
repo-bound and never shell out to the CLI.

---

## Phase 3A: advisory file claims

Phase 3A adds **advisory** file claims. The core service is
`src/core/coordination/claims.ts`. Claims are plain generated state — they are
**not** locks: the core never touches source files and never creates per-file
lock artifacts.

- **`add`** creates a claim for an *active* agent on a repository-relative path.
  Modes are `exclusive` and `shared`. Exclusive claims conflict with any
  overlapping claim; shared claims are compatible with other shared claims and
  conflict only with exclusive ones. Overlap is path-prefix aware (claiming a
  directory overlaps files beneath it).
- **`list`** returns claims with a computed, stale-aware status (a claim owned
  by a stale/terminated agent stops blocking).
- **`status`** reports, for a path, the matching claims and whether a shared or
  exclusive claim is currently possible.
- **`release`** marks a claim released.
- **Path validation** rejects empty/absolute/escaping paths and refuses to claim
  generated `.vibecode/` state or `.git` internals.
- **Stale or terminated agents cannot create claims**; only `active`/`idle`
  agents may claim.

When `add` is denied, both adapters surface the same structured details
(requested path/mode, the blocking/conflicting claims including their owning
agent ids, and suggested actions). The CLI flattens these into its error
envelope's `details`; the MCP `CLAIM_DENIED` error carries them as structured
`error.details`. Neither adapter requires the client to parse the message
string.

CLI:

```powershell
vibecode claims add --repo <path> --agent <agent_id> --path <rel-path> --mode <exclusive|shared> --json
vibecode claims list --repo <path> [--agent <agent_id>] [--include-released] --json
vibecode claims status --repo <path> --path <rel-path> --json
vibecode claims release --repo <path> --claim <claim_id> --json
```

MCP tools:

```text
vibecode_claim_add
vibecode_claims_list
vibecode_claim_status
vibecode_claim_release
```

CLI and MCP are thin adapters over the same core service. The MCP tools are
repo-bound (they never accept a repo argument) and never shell out to the CLI.

---

## Not yet implemented

The following are specified in `docs/MULTI_AGENT_CONFLICT_DESIGN.md` and
`docs/MULTI_AGENT_UI_DESIGN.md` but are **not** built yet:

```text
file watcher (unauthorized-edit evidence)
finalize guard
commit guard
handoffs
conflict persistence / event log
desktop coordination UI panel
prompt protocol injection
```

Claims remain **advisory only**: there are no hard source-file locks. None of
the future phases above introduce hard source-file locks either.
