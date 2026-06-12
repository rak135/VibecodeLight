# VibecodeMCP Tool Contract v1

## Status

Proposed target contract for the next VibecodeMCP redesign.

This document defines the intended agent-facing MCP surface, tool semantics, profile structure, migration rules, and acceptance tests.

The goal is not to preserve today's implementation shape. The goal is to give coding agents a small, obvious, safe, and efficient contract.

---

## Core Decision

VibecodeMCP will move from a large flat tool list to a small agent-facing tool contract.

The default agent-facing MCP surface will contain **14 tools**.

The old MCP tool names must not remain visible as default tools, debug tools, or legacy aliases after the migration is accepted.

The old internal core services may be reused. The old **MCP tool names** must not remain part of the agent-facing contract.

This is intentional.

Keeping the old tools around would keep confusing agents, preserve duplicate workflows, and defeat the point of the redesign.

---

## Non-Negotiable Principles

1. **Small tool surface over backward compatibility.**
   Agents should see a small, clean contract, not every internal subsystem.

2. **New agent-facing names are the contract.**
   The new names describe workflow intent: session, workspace, changes, build, handoff.

3. **Old MCP names are removed after migration.**
   There is no permanent `legacy`, `debug_full`, or alias profile exposing old names.

4. **Internal services can stay.**
   Existing TypeScript core services such as bootstrap, claims, intents, finalize, commit guard, CodeGraph, handoff, and team status can be reused behind the new tools.

5. **No `lock_token` in advisory mode.**
   The workflow handle is `intent_id`, bound to `agent_id` and exact claimed paths.

6. **No build work without claims.**
   Read-only work needs no claim. Build work must begin with `vibecode_build_start` and exact file claims.

7. **Commit remains CLI-guarded, not MCP-mutating.**
   MCP can recommend the exact commit guard command. MCP must not perform commits.

8. **Heartbeat is fallback-only during transition, then removed from the agent-facing MCP contract.**
   Agent liveness should primarily come from attributed MCP/CLI activity.

9. **GUI observability is required.**
   The user must see which agents used VibecodeMCP, which tools they called, which files they claimed, and which files are unclaimed/dirty.

10. **Final prompt / Composer is out of scope.**
    This contract is only for VibecodeMCP and coordination. It must not change the final prompt pipeline.

---

## Target Default MCP Tools

The default profile exposes exactly these 14 tools:

1. `vibecode_session_start`
2. `vibecode_workspace_snapshot`
3. `vibecode_project_instructions`
4. `vibecode_run_status`
5. `vibecode_artifact_read`
6. `vibecode_changes`
7. `vibecode_codegraph_search`
8. `vibecode_codegraph_explore`
9. `vibecode_codegraph_callers`
10. `vibecode_codegraph_impact`
11. `vibecode_build_start`
12. `vibecode_build_scope`
13. `vibecode_build_finish`
14. `vibecode_handoff`

No old MCP tool names should appear in the final default `tools/list`.

---

## Tool Definitions

## 1. `vibecode_session_start`

### Purpose

Start or resume an agent session.

This is the required first call for agents using VibecodeMCP.

### Mode

Metadata write.

### Input

```json
{
  "agent_id": "optional existing agent id",
  "agent_name": "optional human-readable name",
  "mode": "read_only | build",
  "task": "short task intent",
  "terminal_id": "optional selected terminal id",
  "resume": true
}
```

### Output

```json
{
  "ok": true,
  "agent_id": "agent_x",
  "session_id": "session_y",
  "mode": "build",
  "status": "active | resumed | stale_recovered | rejected",
  "last_activity_at": "2026-06-12T10:00:00.000Z",
  "recommended_next_tools": [
    "vibecode_workspace_snapshot",
    "vibecode_project_instructions"
  ],
  "warnings": [],
  "blockers": []
}
```

### Side Effects

- Registers or resumes an agent session.
- Sets or updates `last_activity_at`.
- Binds the current MCP server process/session to the resolved `agent_id` where possible.

### Internal Mapping

May reuse existing session/bootstrap/register/heartbeat services internally.

The old MCP names must not remain exposed after migration.

---

## 2. `vibecode_workspace_snapshot`

### Purpose

Return one compact bounded overview of the current workspace.

This should prevent agents from calling five orientation tools before doing useful work.

### Mode

Read-only.

### Input

```json
{
  "agent_id": "agent_x",
  "include": [
    "git",
    "claims",
    "agents",
    "run",
    "codegraph",
    "safety",
    "recommended_next"
  ],
  "max_items": 20
}
```

### Output

```json
{
  "ok": true,
  "repo": {
    "root": "C:/DATA/PROJECTS/VibecodeLight",
    "branch": "master",
    "head": "abc123",
    "dirty": true
  },
  "agent": {
    "agent_id": "agent_x",
    "mode": "build",
    "last_activity_at": "2026-06-12T10:00:00.000Z"
  },
  "workspace_safety": {
    "unclaimed_dirty_count": 0,
    "staged_unclaimed_count": 0,
    "foreign_claimed_dirty_count": 0,
    "conflict_count": 0
  },
  "claims_summary": {
    "owned": [],
    "foreign": [],
    "stale": []
  },
  "run": {
    "current_run_id": "optional",
    "artifacts_available": true
  },
  "codegraph": {
    "available": true,
    "stale_after_edits": false,
    "recommended_tools": [
      "vibecode_codegraph_search",
      "vibecode_codegraph_explore"
    ]
  },
  "recommended_next_tools": [],
  "warnings": [],
  "blockers": []
}
```

### Side Effects

None except implicit activity update for the calling agent.

### Internal Mapping

May reuse existing workspace info/status, git changes, team status, runtime awareness, and guidance services.

### Boundaries

This tool must stay bounded. It must not become a huge dump of every artifact or instruction file.

---

## 3. `vibecode_project_instructions`

### Purpose

Return relevant project instructions, repository rules, and operating constraints.

### Mode

Read-only.

### Input

```json
{
  "agent_id": "agent_x",
  "task": "optional task text",
  "max_chars": 12000,
  "include_sources": true
}
```

### Output

```json
{
  "ok": true,
  "instructions": [
    {
      "path": "AGENTS.md",
      "priority": "high",
      "excerpt": "...",
      "reason": "agent operating rules"
    }
  ],
  "conflicts": [],
  "warnings": []
}
```

### Side Effects

None except implicit activity update.

### Boundaries

Keep this separate from `workspace_snapshot` so the snapshot does not become bloated.

---

## 4. `vibecode_run_status`

### Purpose

Return current/latest/specific run status and artifact availability.

### Mode

Read-only.

### Input

```json
{
  "agent_id": "agent_x",
  "run_ref": "current | latest | <run_id>",
  "max_items": 20
}
```

### Output

```json
{
  "ok": true,
  "run_id": "run_123",
  "created_at": "2026-06-12T10:00:00.000Z",
  "task": "...",
  "scan_available": true,
  "artifacts": [
    {
      "key": "file_inventory",
      "artifact_type": "scan",
      "read_tool": "vibecode_artifact_read"
    }
  ],
  "terminal": {
    "send_metadata_available": true
  },
  "after": {
    "checks_summary_available": true,
    "commit": "optional"
  },
  "warnings": []
}
```

### Side Effects

None except implicit activity update.

---

## 5. `vibecode_artifact_read`

### Purpose

Read allowlisted run and scan artifacts through one external API.

### Mode

Read-only.

### Input

```json
{
  "agent_id": "agent_x",
  "run_ref": "current | latest | <run_id>",
  "artifact_type": "run | scan",
  "artifact_key": "file_inventory | git_status | context_pack | checks_summary",
  "cursor": "optional continuation cursor",
  "max_bytes": 12000
}
```

### Output

```json
{
  "ok": true,
  "artifact_type": "scan",
  "artifact_key": "file_inventory",
  "content": "...",
  "truncated": true,
  "next_cursor": "optional"
}
```

### Side Effects

None except implicit activity update.

### Important Implementation Rule

The external API is unified, but internal allowlists must stay separated by artifact type.

`run` artifacts and `scan` artifacts have different safety boundaries and should not be merged into one permissive allowlist.

---

## 6. `vibecode_changes`

### Purpose

Return claim-aware workspace change classification.

This is the main read-only safety tool before and after build work.

### Mode

Read-only.

### Input

```json
{
  "agent_id": "agent_x",
  "intent_id": "optional",
  "include_diff_stat": true,
  "max_items": 50
}
```

### Output

```json
{
  "ok": true,
  "summary": {
    "claimed_by_agent": 2,
    "claimed_by_other_agent": 0,
    "unclaimed_dirty": 1,
    "staged_unclaimed": 0,
    "generated_or_ignored": 0
  },
  "files": [
    {
      "path": "src/foo.ts",
      "git_status": "modified",
      "classification": "claimed_by_agent | claimed_by_other_agent | unclaimed | staged_unclaimed | generated_or_ignored",
      "owner_agent_id": "optional",
      "intent_id": "optional",
      "severity": "ok | warning | blocker"
    }
  ],
  "blockers": [],
  "warnings": [],
  "recommended_next_tools": [
    "vibecode_build_finish"
  ]
}
```

### Side Effects

None except implicit activity update.

### Critical Rule

Unclaimed dirty files are a workspace-level safety problem.

Do not claim that Vibecode knows which agent physically edited an unclaimed file unless there is a reliable future isolation mechanism.

---

## 7. `vibecode_codegraph_search`

### Purpose

Find indexed symbols, files, and code entities.

### Mode

Read-only.

### Input

```json
{
  "agent_id": "agent_x",
  "query": "buildAgentHandoffPacket",
  "kind": "symbol | file | any",
  "max_results": 10
}
```

### Output

```json
{
  "ok": true,
  "tool": "vibecode_codegraph_search",
  "repo_root": "/path/to/repo",
  "warnings": [],
  "truncated": false,
  "duration_ms": 120,
  "data": {
    "parsed_json": [
      {
        "score": 0.95,
        "rank": 1,
        "raw_score": 0.95,
        "relative_score": 1.0,
        "score_kind": "raw_upstream_rank_score",
        "score_is_percentage": false,
        "score_scope": "query_relative",
        "node": {
          "kind": "function",
          "name": "buildAgentHandoffPacket",
          "filePath": "src/core/agent_session/handoff.ts",
          "startLine": 10,
          "endLine": 25
        }
      }
    ],
    "score_meta": {
      "score_kind": "raw_upstream_rank_score",
      "score_is_percentage": false,
      "score_scope": "query_relative",
      "max_score": 0.95,
      "note": "score is the upstream CodeGraph raw rank score: query-relative, not a percentage"
    }
  }
}
```

> **Note:** This tool does NOT return freshness/staleness. For CodeGraph index
> freshness, use `vibecode_workspace_snapshot` which reports
> `codegraph.index_freshness` (an enum: `not_indexed` or `unknown`). For exact
> literal search, use `grep` or `rg` instead.

### Side Effects

None except implicit activity update.

---

## 8. `vibecode_codegraph_explore`

### Purpose

Explore a subsystem, flow, or architectural area.

This is the agent-facing name for CodeGraph contextual exploration.

### Mode

Read-only.

### Input

```json
{
  "agent_id": "agent_x",
  "topic": "claim lifecycle and build finish",
  "paths": ["src/core/coordination"],
  "max_items": 20
}
```

### Output

```json
{
  "ok": true,
  "tool": "vibecode_codegraph_explore",
  "repo_root": "/path/to/repo",
  "warnings": [],
  "truncated": false,
  "duration_ms": 200
}
```

> **Note:** CodeGraph explore returns bounded markdown text context, not
> structured fields like `summary` or `key_files`. For index freshness, use
> `vibecode_workspace_snapshot`.

### Side Effects

None except implicit activity update.

---

## 9. `vibecode_codegraph_callers`

### Purpose

Find who calls or depends on a symbol before changing it.

### Mode

Read-only.

### Input

```json
{
  "agent_id": "agent_x",
  "symbol": "finalizeCheck",
  "path": "optional",
  "max_depth": 2,
  "max_items": 30
}
```

### Output

```json
{
  "ok": true,
  "callers": [
    {
      "path": "src/app/mcp/tools/finalize_check_tool.ts",
      "symbol": "handleFinalizeCheck",
      "relationship": "calls"
    }
  ],
  "warnings": []
}
```

### Side Effects

None except implicit activity update.

---

## 10. `vibecode_codegraph_impact`

### Purpose

Estimate impact before changing shared code, public APIs, coordination logic, tool contracts, or broad architecture.

### Mode

Read-only.

### Input

```json
{
  "agent_id": "agent_x",
  "targets": [
    {
      "path": "src/core/coordination/finalize_check.ts",
      "symbol": "finalizeCheck"
    }
  ],
  "max_depth": 3,
  "max_items": 50
}
```

### Output

```json
{
  "ok": true,
  "impacted_files": [],
  "impacted_symbols": [],
  "test_candidates": [],
  "risk_level": "low | medium | high",
  "warnings": []
}
```

### Side Effects

None except implicit activity update.

### Policy

Keep this in the default profile.

Impact analysis is more important for safe build work than generic CodeGraph browsing tools.

---

## 11. `vibecode_build_start`

### Purpose

Start build work and explicitly claim exact files.

This is the required entry gate for any implementation/editing task.

### Mode

Coordination write.

### Input

```json
{
  "agent_id": "agent_x",
  "task": "Implement MCP profile filtering",
  "paths": [
    "src/app/mcp/tool_registry.ts",
    "tests/app/mcp/tool_registry.test.ts"
  ],
  "dry_run": false,
  "intent_id": "optional existing intent id"
}
```

### Output

```json
{
  "ok": true,
  "intent_id": "intent_123",
  "claimed_paths": [
    "src/app/mcp/tool_registry.ts"
  ],
  "denied_paths": [],
  "warnings": [],
  "blockers": [],
  "recommended_next_tools": [
    "vibecode_codegraph_explore",
    "vibecode_changes"
  ]
}
```

### Side Effects

If `dry_run=false`:

- Creates or extends a claim intent.
- Claims exact paths for the build agent.
- Updates agent activity.

### Blocks

- Agent is not in `build` mode.
- Path is a directory.
- Path is a glob.
- Path is inside `.git/`, `.vibecode/`, generated, ignored, or otherwise unsafe.
- Path is actively claimed by another build agent.
- Path classification is uncertain.

### Explicit Non-Goal

No `lock_token`.

Use `intent_id` as the workflow handle.

---

## 12. `vibecode_build_scope`

### Purpose

Modify an existing build scope.

Use this when the agent discovers it needs to edit additional exact files, or when it can safely release clean files.

### Mode

Coordination write.

### Input

```json
{
  "agent_id": "agent_x",
  "intent_id": "intent_123",
  "add_paths": ["src/app/mcp/server_stdio.ts"],
  "release_paths": ["tests/old.test.ts"],
  "dry_run": false
}
```

### Output

```json
{
  "ok": true,
  "intent_id": "intent_123",
  "added_claims": [],
  "released_claims": [],
  "blocked": [],
  "warnings": []
}
```

### Side Effects

If `dry_run=false`:

- Adds exact path claims under the same intent.
- Releases only safe clean claims requested by the owning agent.
- Updates agent activity.

### Rules

- No automatic claim inference from diff.
- No directory claims.
- No glob claims.
- No releasing dirty files unless a future explicit policy says otherwise.

---

## 13. `vibecode_build_finish`

### Purpose

Run the final claim-aware safety check before commit, release, or handoff.

This is the main macro tool that replaces the old multi-call finish dance.

### Mode

Read-only by default.

Optional coordination write only if `release_clean_claims=true`.

### Input

```json
{
  "agent_id": "agent_x",
  "intent_id": "optional",
  "release_clean_claims": false,
  "include_commit_guard_command": true
}
```

### Output

```json
{
  "ok": true,
  "status": "ready_to_commit | blocked | warnings_only | ready_to_release | no_claimed_changes",
  "owned_dirty_files": [],
  "owned_clean_files": [],
  "unclaimed_dirty_files": [],
  "foreign_claimed_dirty_files": [],
  "staged_blockers": [],
  "release_eligible_claims": [],
  "commit_guard": {
    "allowed": true,
    "command": "vibecode commit guard --agent agent_x --message \"...\""
  },
  "warnings": [],
  "blockers": [],
  "recommended_next_tools": [
    "vibecode_handoff"
  ]
}
```

### Side Effects

- Default: none except implicit activity update.
- If `release_clean_claims=true`: releases only clean claims owned by the same agent/intent.

### Blocks

- Unclaimed dirty source files.
- Staged unclaimed files.
- Staged files claimed by other agents.
- Uncertain git/path classification.
- Invalid or read-only agent for build finish.
- No claimed committable files when commit readiness is requested.

### Commit Boundary

This tool must not create commits.

It may return the exact CLI commit guard command.

---

## 14. `vibecode_handoff`

### Purpose

Prepare or consume handoff guidance.

This is visibility only. It does not transfer ownership.

### Mode

Read-only.

### Input

```json
{
  "agent_id": "agent_x",
  "mode": "prepare | guide",
  "from_agent_id": "optional",
  "for_agent_id": "optional",
  "max_items": 30
}
```

### Output

```json
{
  "ok": true,
  "handoff_state": "ready | blocked | ready_after_release | previous_agent_not_ready | ready_for_new_agent",
  "ownership_transferred": false,
  "must_claim_explicitly": true,
  "summary": "...",
  "claimed_paths": [],
  "blocked_paths": [],
  "required_actions": [],
  "safe_next_commands": [],
  "warnings": [],
  "blockers": []
}
```

### Side Effects

None except implicit activity update.

### Rule

A next agent must call `vibecode_build_start` and claim exact paths independently.

---

## Profiles

## Default

The normal profile for coding agents.

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

## `codegraph_full`

Optional expanded CodeGraph profile.

```text
default +
vibecode_codegraph_callees
vibecode_codegraph_files
vibecode_codegraph_status
vibecode_codegraph_usage
```

## `ops`

Operator/maintainer profile for coordination troubleshooting.

```text
default +
vibecode_team_status
vibecode_conflicts_list
vibecode_conflict_detail
vibecode_conflict_resolve
vibecode_claims_reap
vibecode_evidence_list
vibecode_evidence_scan
vibecode_agents_list
vibecode_coordination_status
vibecode_tool_profile
```

## No Permanent Legacy Profile

There must be no permanent profile exposing the old MCP tool names.

During implementation, a temporary internal migration harness may exist in tests or local development, but it must not be shipped as an agent-facing profile.

The accepted migration is complete only when old MCP tool names are removed from public `tools/list`, catalog, guidance, install config, docs, and agent-facing tests.

---

## Old Tool Removal Policy

The old MCP tools should be removed from the agent-facing registry once equivalent new tools pass tests.

Old handler logic can be moved behind internal functions.

Do not keep aliases such as:

```text
vibecode_session_bootstrap
vibecode_workspace_info
vibecode_workspace_status
vibecode_mcp_guidance
vibecode_git_changes
vibecode_finalize_check
vibecode_claims_add_bulk
vibecode_claim_intents_list
vibecode_handoff_prepare
vibecode_handoff_guide
```

as public MCP tools after migration.

If an old tool is needed temporarily during implementation, it must be marked as temporary and removed before the phase is closed.

---

## Advisory Claim Enforcement

Vibecode is advisory in this phase.

It does not prevent raw filesystem edits.

It enforces safety at the gates it controls:

- `vibecode_build_start`
- `vibecode_build_scope`
- `vibecode_changes`
- `vibecode_build_finish`
- CLI commit guard
- GUI observability

### Blocks

- Build work without a build-mode agent.
- Build work without exact file claims.
- Directory/glob/generated/ignored claims.
- Foreign active claims on the same path.
- Unclaimed dirty source files at finish.
- Staged unclaimed files at finish/commit.
- Uncertain classification.

### Warnings

- Foreign dirty claimed files outside current agent scope.
- Stale clean claims.
- CodeGraph stale after edits.
- Unclaimed dirty files unrelated to current isolated commit.

### GUI Display

- Green: own claimed dirty files.
- Yellow: foreign claimed dirty files.
- Red: unclaimed dirty files.
- Red: staged unclaimed files.
- Gray: generated/ignored files.
- Badge: stale claim / blocked / ready to commit / ready to handoff.

### Attribution Rule

Do not state that an unclaimed dirty file was created by a specific agent unless future isolation/worktree/process tracking proves it.

In shared advisory mode, unclaimed dirty files are workspace-level safety alarms.

---

## Activity and Heartbeat Policy

The final agent-facing contract should not require heartbeat calls.

Liveness should be based on:

- attributed MCP calls,
- attributed CLI commands,
- session start/resume,
- build claim operations,
- optional future terminal/process signals,
- optional future file watcher signals.

### Required Data

Every MCP tool call should record:

```json
{
  "timestamp": "2026-06-12T10:00:00.000Z",
  "agent_id": "agent_x",
  "session_id": "session_y",
  "tool": "vibecode_changes",
  "ok": true,
  "duration_ms": 42
}
```

### Heartbeat Transition

Heartbeat may exist internally during migration, but it must not remain an agent-facing MCP tool in the final contract.

---

## CodeGraph Usage Policy

CodeGraph stays in the default read layer.

Use CodeGraph for:

- architecture exploration,
- subsystem context,
- symbol lookup,
- callers,
- impact analysis,
- pre-refactor reasoning.

Use grep/search/read for:

- exact strings,
- error messages,
- config keys,
- test names,
- raw text not indexed by CodeGraph,
- files edited after the last CodeGraph index.

Do not trust CodeGraph blindly when the index is stale.

`workspace_snapshot` and CodeGraph tools should surface staleness clearly.

---

## GUI Observability Requirements

The GUI must expose the state that proves agents are using Vibecode correctly.

Required panels or sections:

1. Agents
   - agent id/name/model/program if known,
   - mode,
   - last activity,
   - last MCP tool,
   - MCP call count,
   - CLI call count,
   - stale/active/blocked status.

2. Claims
   - path,
   - owning agent,
   - intent id,
   - clean/dirty,
   - age,
   - conflict/stale status.

3. Tool Usage
   - recent calls,
   - agent,
   - tool,
   - ok/error,
   - duration,
   - timestamp.

4. Workspace Safety
   - unclaimed dirty files,
   - staged unclaimed files,
   - foreign claimed dirty files,
   - conflicts,
   - stale claims.

5. Readiness
   - ready to commit,
   - blocked,
   - ready to release,
   - ready to handoff.

GUI must use core/IPC services, not MCP resources, as the primary data path.

---

## MCP Resources

MCP resources are optional and later-phase only.

They must not be required for the GUI.

Candidate resources:

```text
vibecode://workspace/current
vibecode://run/current
vibecode://claims/active
vibecode://agents/active
vibecode://events/recent
vibecode://tool-usage/recent
vibecode://codegraph/status
vibecode://handoff/current
```

Do not build the main observability architecture on resources until Claude/Codex/OpenCode client support is verified.

---

## Migration Plan

## Phase 1 — Contract and New Registry

Implement the new tool registry with only the new names.

- Add the 14 default tools.
- Wire them to existing core services where possible.
- Remove old tool names from public `tools/list`.
- Update tool catalog metadata to describe only the new contract.
- Update MCP install/guidance docs to reference only new tools.

No old public legacy profile.

## Phase 2 — Tool Equivalence Tests

For each new tool, prove equivalence or superset behavior over the old internal service it replaces.

Examples:

- `vibecode_build_start` creates the same safe claims/intents as current bulk-claim internals.
- `vibecode_build_finish` catches the same blockers as current finalize/commit-guard readiness flow.
- `vibecode_handoff` covers previous prepare/guide states.
- `vibecode_artifact_read` preserves run/scan allowlist boundaries.

## Phase 3 — Activity Attribution

- Add `agent_id` to MCP tool usage events.
- Update activity on every attributed tool call.
- Update activity on relevant CLI calls.
- Stop requiring explicit heartbeat in agent guidance.

## Phase 4 — GUI Observability

Build the GUI panels for agents, claims, tool usage, safety, and readiness.

## Phase 5 — Dogfood

Dogfood with Claude, Codex, DeepSeek/OpenCode style agents:

- read-only orientation,
- build start with claims,
- parallel non-overlap,
- conflict denial,
- unclaimed dirty blocker,
- build finish,
- commit guard,
- handoff,
- stale/activity tracking.

## Phase 6 — Remove Temporary Compatibility Code

Any temporary adapters used during implementation must be removed before closing the migration.

The final shipped MCP surface must not expose old MCP tool names.

---

## Required Tests

### Registry / Tools List

- Default `tools/list` exposes exactly the 14 target tools.
- Old MCP tool names are absent from default `tools/list`.
- Old MCP tool names are absent from shipped profile lists.
- Tool catalog contains metadata for all new tools.
- Tool catalog contains no old public tool entries.

### Session

- `vibecode_session_start` registers a build agent.
- `vibecode_session_start` registers a read-only agent.
- Reusing an active `agent_id` resumes safely.
- Terminated or invalid agent state is rejected or recovered according to policy.

### Build Start / Scope

- `build_start` claims exact files atomically.
- `build_start` rejects read-only agents.
- `build_start` rejects directories.
- `build_start` rejects globs.
- `build_start` rejects generated/ignored paths.
- `build_start` rejects foreign active claims.
- `build_scope` adds exact paths under an existing intent.
- `build_scope` releases only safe clean claims.

### Changes / Finish

- `changes` classifies claimed-by-agent files.
- `changes` classifies foreign-claimed files.
- `changes` classifies unclaimed dirty files.
- `changes` classifies staged unclaimed files as blockers.
- `build_finish` blocks unclaimed dirty source files.
- `build_finish` blocks staged unclaimed files.
- `build_finish` returns exact commit guard command when ready.
- `build_finish` can release clean claims only when explicitly requested.

### Artifact Read

- `artifact_read` reads allowed run artifacts.
- `artifact_read` reads allowed scan artifacts.
- Run artifact allowlist and scan artifact allowlist remain separate.
- Continuation works for large artifacts.
- Disallowed artifacts are rejected.

### CodeGraph

- CodeGraph tools are read-only.
- `codegraph_explore` maps to current context behavior or equivalent.
- `codegraph_impact` returns bounded impact results.
- Stale index warnings are surfaced.

### Activity

- Every MCP call with bound `agent_id` records tool usage.
- Every MCP call with bound `agent_id` updates `last_activity_at`.
- Unbound calls do not crash and are not falsely attributed.
- Heartbeat is not present in final agent-facing tools.

### GUI

- Agents panel renders last activity and last tool.
- Claims panel renders ownership and clean/dirty state.
- Tool usage panel renders recent attributed calls.
- Safety panel renders unclaimed dirty and staged blockers.
- GUI does not mutate coordination state from observability panels.

---

## Agent Workflow Contract

## Read-Only Work

```text
1. vibecode_session_start(mode=read_only)
2. vibecode_workspace_snapshot
3. vibecode_project_instructions
4. CodeGraph/artifact tools as needed
5. No build tools
6. No claims
7. No source edits
```

## Build Work

```text
1. vibecode_session_start(mode=build)
2. vibecode_workspace_snapshot
3. vibecode_project_instructions if needed
4. vibecode_build_start(paths=[exact files])
5. CodeGraph/search/read as needed
6. Edit only claimed paths
7. vibecode_changes
8. vibecode_build_scope if additional files are needed
9. vibecode_build_finish
10. Run CLI commit guard if ready
11. vibecode_handoff if needed
```

---

## Final Decision Summary

- New MCP tool names become the real contract.
- Old MCP tool names are not kept as public legacy/debug tools.
- Existing core services should be reused internally.
- `intent_id` is the workflow handle; no `lock_token`.
- Build mode requires exact path claims.
- Heartbeat is removed from the final agent-facing contract after activity attribution works.
- CodeGraph remains default for search/explore/callers/impact.
- GUI observability is required before the migration is considered complete.
- MCP resources are optional later work.
- Final prompt/Composer is out of scope.
