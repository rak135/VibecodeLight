# Multi-Agent Conflict Detection and Handoff Design

This document defines conflict detection, resolution, and handoff workflows for VibecodeLight multi-agent coordination.

It is a design contract, not implementation code. When this document conflicts with `ARCHITECTURE_DECISIONS.md` on concrete implementation details, `ARCHITECTURE_DECISIONS.md` wins.

---

## Authority

```text
1. AGENTS.md — operational guide
2. ARCHITECTURE_DECISIONS.md — implementation decisions, wins on conflicts
3. This document — multi-agent conflict design
4. ARCHITECTURE.md — module boundaries
```

---

## Core Constraints

```text
1. Claims are advisory-only — no filesystem locks
2. Agents may ignore protocol — Vibecode must detect violations
3. File watcher detects unauthorized edits in real time
4. Commit guard prevents unsafe commits when conflicts exist
5. User is final authority on all resolution decisions
6. Every conflict state change is persisted to .vibecode/
7. Conflict records are per-workspace, not per-run
```

---

## Data Model

### FileClaim

```typescript
interface FileClaim {
  claim_id: string;               // unique claim identifier
  agent_id: string;               // owning agent session id
  agent_name: string;             // human-readable agent label
  file_path: string;              // relative path from repo root
  claim_type: 'exclusive' | 'shared';
  claimed_at: string;             // ISO timestamp
  heartbeat_at: string;           // last heartbeat timestamp
  heartbeat_ttl_ms: number;       // ms before claim considered stale (default: 300000 = 5 min)
  status: ClaimStatus;
  run_id: string;                 // run that created this claim
  metadata: Record<string, unknown>;
}

type ClaimStatus =
  | 'active'       // claim is valid, heartbeat within TTL
  | 'stale'        // heartbeat expired, claim awaiting reclamation or release
  | 'relinquished' // agent voluntarily released
  | 'revoked'      // taken by user or higher-priority claim
  | 'conflicting'; // claim exists but another claim or edit conflicts
```

### AgentSession

```typescript
interface AgentSession {
  agent_id: string;
  agent_name: string;
  agent_type: 'claude' | 'codex' | 'hermes' | 'opencode' | 'custom';
  started_at: string;
  last_heartbeat_at: string;
  status: AgentStatus;
  claims: string[];               // claim_ids held by this agent
  terminal_session_id: string;
  pid: number | null;             // OS process id, null if unknown
}

type AgentStatus =
  | 'active'      // heartbeat within TTL
  | 'idle'        // active but no recent file edits
  | 'stale'       // heartbeat expired
  | 'terminated'  // process exited or agent disconnected
  | 'unknown';    // no process tracking available
```

### ConflictRecord

```typescript
interface ConflictRecord {
  conflict_id: string;
  conflict_type: ConflictType;
  detected_at: string;
  status: ConflictStatus;
  involved_claims: string[];      // claim_ids
  involved_agents: string[];      // agent_ids
  involved_files: string[];       // file paths
  resolution: ConflictResolution | null;
  resolved_at: string | null;
  resolved_by: string | null;     // 'user' | agent_id | 'system'
  auto_resolvable: boolean;
  severity: ConflictSeverity;
  description: string;
  evidence: ConflictEvidence;
}

type ConflictType =
  | 'claim_denied'
  | 'overlapping_path'
  | 'concurrent_edit'
  | 'stale_claim'
  | 'cross_dependency'
  | 'user_override'
  | 'handoff_request'
  | 'merge_repair'
  | 'validation_conflict';

type ConflictStatus =
  | 'detected'     // conflict identified, not yet addressed
  | 'pending'      // resolution in progress (handoff pending, user notified)
  | 'resolved'     // conflict resolved successfully
  | 'failed';      // resolution attempted but failed, requires manual intervention

type ConflictSeverity =
  | 'low'          // informational, no blocking
  | 'medium'       // should be resolved, workflow degraded
  | 'high'         // blocks commit or further work
  | 'critical';    // immediate attention required

interface ConflictEvidence {
  detector: string;               // 'claim_manager' | 'file_watcher' | 'commit_guard' | 'validation'
  timestamp: string;
  details: Record<string, unknown>;
}

interface ConflictResolution {
  strategy: ResolutionStrategy;
  applied_at: string;
  applied_by: string;
  result: string;
  artifacts: string[];            // paths to resolution artifacts
}

type ResolutionStrategy =
  | 'auto_relinquish'    // stale claim auto-released
  | 'auto_grant'         // second claim auto-granted (shared claim compatible)
  | 'user_takeover'      // user force-took a file
  | 'handoff_complete'   // agent A handed off to agent B
  | 'merge_manual'       // manual merge required
  | 'revert_and_retry'   // conflicting changes reverted, agent retries
  | 'split_files'        // agents assigned non-overlapping subsets
  | 'escalate';          // requires human decision
```

### WorkspaceConflictState

Stored at `.vibecode/coordination/state.json`:

```typescript
interface WorkspaceConflictState {
  version: number;
  workspace_root: string;
  last_updated: string;
  claims: FileClaim[];
  agents: AgentSession[];
  conflicts: ConflictRecord[];
  handoffs: HandoffRequest[];
  config: CoordinationConfig;
}

interface CoordinationConfig {
  heartbeat_ttl_ms: number;          // default: 300000 (5 min)
  heartbeat_check_interval_ms: number; // default: 30000 (30 sec)
  stale_claim_grace_ms: number;      // default: 60000 (1 min after stale)
  max_claims_per_agent: number;      // default: 50
  auto_revoke_stale: boolean;        // default: true
  commit_guard_enabled: boolean;     // default: true
  file_watcher_enabled: boolean;     // default: true
  escalation_timeout_ms: number;     // default: 120000 (2 min)
}
```

### HandoffRequest

```typescript
interface HandoffRequest {
  handoff_id: string;
  from_agent: string;               // agent_id
  to_agent: string;                 // agent_id
  file_paths: string[];
  reason: string;
  requested_at: string;
  status: HandoffStatus;
  accepted_at: string | null;
  completed_at: string | null;
  context_summary: string;          // from-agent summary of work done
  pending_changes: string[];        // files modified but not committed
}

type HandoffStatus =
  | 'requested'     // agent A asked, waiting for agent B
  | 'accepted'      // agent B agreed to take over
  | 'rejected'      // agent B declined
  | 'in_progress'   // handoff transfer active
  | 'completed'     // handoff done, claims transferred
  | 'failed';       // handoff could not complete
```

---

## Conflict Type Specifications

### 1. Claim Denied

**Scenario:** Agent B tries to claim `src/core/runs/store.ts`, but Agent A already holds an active exclusive claim on it.

**Conflict type:** `claim_denied`

**Conflict states:** `detected` → `pending` → `resolved` | `failed`

**Auto-resolvable:** No. The claiming agent must be notified and decide what to do.

**Handoff protocol:**

```text
1. Agent B calls vibecode claims add --file src/core/runs/store.ts --agent B
2. ClaimManager detects existing active claim by Agent A
3. ClaimManager creates ConflictRecord with type=claim_denied, severity=medium
4. ClaimManager returns CLAIM_DENIED response to Agent B:
   {
     "ok": false,
     "error": {
       "code": "CLAIM_DENIED",
       "message": "File src/core/runs/store.ts is claimed by Agent A (since 2026-06-06T10:00:00Z)",
       "details": {
         "existing_claim": { ... },
         "suggested_actions": ["request_handoff", "wait", "claim_shared"]
       }
     }
   }
5. Agent B may:
   a. Request handoff: vibecode handoff request --from A --to B --files src/core/runs/store.ts
   b. Wait and retry later
   c. Claim with shared access if compatible
   d. Escalate to user: vibecode conflicts escalate <conflict_id>
6. If Agent B ignores and edits anyway:
   - File watcher detects unauthorized edit
   - ConflictRecord updated to severity=high
   - Commit guard blocks Agent B's commit
   - User is notified
```

**User-visible messages:**

```text
⚠ Agent B wants to claim src/core/runs/store.ts, but Agent A already holds it.
  Agent A has been working on this file since 10:00 AM.
  
  Options:
  [1] Ask Agent A to hand off the file to Agent B
  [2] Wait for Agent A to finish
  [3] Force-take the file (Agent A loses claim)
  [4] Let both agents work (shared claim)
```

**MCP/CLI commands:**

```powershell
vibecode claims list                          # list all active claims
vibecode claims list --agent A                # claims for specific agent
vibecode claims add --file <path> --agent <id> [--type exclusive|shared]
vibecode claims release --claim <id>
vibecode claims status --file <path>          # who claims this file
vibecode conflicts list                       # all open conflicts
vibecode conflicts show <conflict_id>
vibecode conflicts resolve <conflict_id> --strategy <strategy>
```

**MCP tools:**

```text
vibecode_claims_list        → list/filter claims
vibecode_claims_add         → attempt to claim a file
vibecode_claims_release     → release a claim
vibecode_claims_status      → check claim status for a file
vibecode_conflicts_list     → list open conflicts
vibecode_conflicts_resolve  → resolve a conflict
```

---

### 2. Overlapping Path Glob

**Scenario:** Agent A claims directory `src/core/runs/` (glob pattern). Agent B later claims file `src/core/runs/store.ts` which falls under that directory.

**Conflict type:** `overlapping_path`

**Conflict states:** `detected` → `pending` → `resolved` | `failed`

**Auto-resolvable:** Partially. If both claims are `shared`, auto-resolve. If one is `exclusive`, escalate.

**Handoff protocol:**

```text
1. Agent B calls vibecode claims add --file src/core/runs/store.ts --agent B
2. ClaimManager resolves glob claims: finds Agent A holds src/core/runs/*
3. Overlap check: does src/core/runs/store.ts fall under src/core/runs/*? → yes
4. If both claims are shared → auto_grant, no conflict
5. If Agent A has exclusive on the directory → ConflictRecord type=overlapping_path
6. Agent B receives OVERLAPPING_PATH error with details:
   {
     "code": "OVERLAPPING_PATH",
     "message": "File src/core/runs/store.ts is covered by Agent A's directory claim on src/core/runs/",
     "details": {
       "directory_claim": { "file_path": "src/core/runs/*", "claim_type": "exclusive" },
       "suggested_actions": ["narrow_agent_a_claim", "request_handoff", "user_override"]
     }
   }
7. Resolution options:
   a. Narrow Agent A's claim to specific files (exclude store.ts)
   b. Agent A releases directory claim, re-claims individual files
   c. User overrides: vibecode conflicts resolve <id> --strategy user_takeover --grant-to B
   d. Both agents work on non-overlapping subsets of the directory
```

**User-visible messages:**

```text
⚠ Agent B wants to claim src/core/runs/store.ts, but Agent A holds a directory claim on src/core/runs/*.
  
  Agent A's claim covers 12 files in that directory.
  
  Options:
  [1] Narrow Agent A's claim (exclude store.ts for Agent B)
  [2] Ask Agent A to release the directory claim
  [3] Force-assign store.ts to Agent B
  [4] Split: assign non-overlapping file subsets to each agent
```

**Additional CLI commands:**

```powershell
vibecode claims add --file "src/core/runs/*" --agent A --type exclusive
vibecode claims narrow --claim <id> --exclude "src/core/runs/store.ts"
vibecode claims split --directory src/core/runs/ --between A,B
```

---

### 3. Concurrent Edit (Same File Modified by Two Agents)

**Scenario:** Both Agent A and Agent B modify `src/core/runs/store.ts` independently. Detected at finalize time when commit guard compares working tree hashes.

**Conflict type:** `concurrent_edit`

**Conflict states:** `detected` → `pending` → `resolved` | `failed`

**Auto-resolvable:** No. This is the hardest conflict type. Always requires user decision or merge repair.

**Handoff protocol:**

```text
1. Agent A calls vibecode run finalize --run <run_id_a>
2. CommitGuard runs pre-commit checks:
   a. Computes git hash of store.ts at run start
   b. Computes current git hash of store.ts
   c. Checks if Agent B also modified store.ts (comparing Agent B's run start hash)
3. If both agents modified the same file → ConflictRecord type=concurrent_edit
4. finalize BLOCKED with CONCURRENT_EDIT error:
   {
     "ok": false,
     "error": {
       "code": "CONCURRENT_EDIT",
       "message": "src/core/runs/store.ts was modified by both Agent A and Agent B",
       "details": {
         "agent_a_changes": { "lines_added": 45, "lines_removed": 12 },
         "agent_b_changes": { "lines_added": 30, "lines_removed": 8 },
         "suggested_actions": ["merge_manual", "revert_agent_b", "revert_agent_a", "user_decide"]
       }
     }
   }
5. Resolution options:
   a. User inspects both diffs: vibecode conflicts show <conflict_id> --diff
   b. User chooses merge strategy
   c. One agent's changes are reverted
   d. Manual merge by user
   e. Merge repair run spawned
6. After resolution, affected agent's run is re-finalized
```

**User-visible messages:**

```text
🔴 CONCURRENT EDIT DETECTED
  
  src/core/runs/store.ts was modified by:
  - Agent A: +45/-12 lines (run 2026-06-06_001)
  - Agent B: +30/-8 lines  (run 2026-06-06_002)
  
  Cannot commit safely until resolved.
  
  Options:
  [1] View Agent A's changes
  [2] View Agent B's changes  
  [3] View both diffs side-by-side
  [4] Keep Agent A's version (revert B)
  [5] Keep Agent B's version (revert A)
  [6] Open merge tool for manual resolution
  [7] Spawn merge repair run
```

**Additional CLI commands:**

```powershell
vibecode conflicts show <conflict_id> --diff            # show both diffs
vibecode conflicts show <conflict_id> --diff --agent A  # show one agent's diff
vibecode conflicts resolve <conflict_id> --strategy revert --target-agent B
vibecode conflicts resolve <conflict_id> --strategy merge_manual
vibecode merge repair --conflict <conflict_id>          # spawn repair run
```

---

### 4. Stale Claim (Agent Crashed)

**Scenario:** Agent A claimed 8 files but its process crashed or disconnected. Heartbeats stopped. Claims are stale.

**Conflict type:** `stale_claim`

**Conflict states:** `detected` → `pending` → `resolved` | `failed`

**Auto-resolvable:** Yes (if `auto_revoke_stale` is enabled). Stale claims are auto-released after grace period.

**Handoff protocol:**

```text
1. HeartbeatMonitor runs every 30s (configurable)
2. For each active claim: check (now - heartbeat_at) > heartbeat_ttl_ms
3. If expired:
   a. Claim status → 'stale'
   b. AgentSession status → 'stale'
   c. If auto_revoke_stale is true:
      - Wait grace period (stale_claim_grace_ms, default 60s)
      - If no heartbeat resumed → Claim status → 'revoked'
      - ConflictRecord created with type=stale_claim
   d. If auto_revoke_stale is false:
      - ConflictRecord created, severity=medium
      - Wait for user decision
4. Other agents can now claim the released files
5. If Agent A reconnects and tries to resume:
   - Receives STALE_CLAIM_LOST error
   - Must re-claim files
   - Any uncommitted changes are preserved in working tree
```

**User-visible messages:**

```text
ℹ Agent A appears to have disconnected (no heartbeat for 6 minutes).
  8 file claims released after grace period.
  
  Affected files:
  - src/core/runs/store.ts
  - src/core/runs/run_id.ts
  - src/core/runs/current.ts
  - ... (5 more)
  
  These files are now available for other agents to claim.
```

**If agent reconnects:**

```text
⚠ Agent A reconnected but its previous claims were released due to stale heartbeat.
  You must re-claim files you still need.
  Uncommitted changes in your working tree are preserved.
```

**Additional CLI commands:**

```powershell
vibecode agents list                           # list all known agents
vibecode agents status <agent_id>              # check agent status
vibecode claims release --agent <id> --all     # manually release all claims for an agent
vibecode agents reconnect <agent_id>           # agent re-registration
```

---

### 5. Cross-Dependency (Agent Needs Another Agent's File)

**Scenario:** Agent B needs to import from a module that Agent A is actively modifying. Agent B cannot build/test without Agent A's file being stable.

**Conflict type:** `cross_dependency`

**Conflict states:** `detected` → `pending` → `resolved` | `failed`

**Auto-resolvable:** Partially. Can auto-detect and suggest, but resolution requires coordination.

**Handoff protocol:**

```text
1. Agent B's task context includes import/dependency scan results
2. Vibecode detects: Agent B's task imports from src/core/runs/store.ts
3. src/core/runs/store.ts is actively claimed by Agent A
4. CrossDependencyDetector creates ConflictRecord:
   type=cross_dependency, severity=medium
5. Agent B is notified:
   {
     "code": "CROSS_DEPENDENCY",
     "message": "Your task depends on src/core/runs/store.ts which is being modified by Agent A",
     "details": {
       "dependency": "src/core/runs/store.ts",
       "blocking_agent": "Agent A",
       "dependency_type": "import",
       "suggested_actions": ["request_stable_snapshot", "wait", "reorder_tasks"]
     }
   }
6. Resolution options:
   a. Request stable snapshot: Agent A commits current state as checkpoint,
      Agent B gets a stable import target
   b. Wait: Agent B pauses until Agent A releases the file
   c. Reorder tasks: User reassigns tasks so dependent work happens after
   d. Shared claim: Both agents agree to coordinate on non-conflicting edits
   e. Agent B reimplements locally with a stub, integrates later
```

**User-visible messages:**

```text
⚠ Agent B's task depends on src/core/runs/store.ts, which Agent A is actively modifying.
  
  Dependency type: import from src/core/runs/store.ts
  Agent A last modified this file 2 minutes ago.
  
  Options:
  [1] Ask Agent A to commit a stable checkpoint
  [2] Pause Agent B until Agent A finishes
  [3] Reorder: let Agent A finish before Agent B starts
  [4] Let Agent B work with a local stub
```

**Additional CLI commands:**

```powershell
vibecode dependencies check --agent <id>           # check what this agent depends on
vibecode dependencies block --file <path>          # what agents are blocked by this file
vibecode handoff request --from A --to B --files <path> --context "stable checkpoint needed"
```

---

### 6. User Override (User Force-Takes a File)

**Scenario:** User decides Agent A should stop working on a file and takes control directly, or reassigns the file to Agent B.

**Conflict type:** `user_override`

**Conflict states:** `detected` → `resolved` (user overrides are immediate)

**Auto-resolvable:** N/A. User is the authority. This is always a manual resolution.

**Handoff protocol:**

```text
1. User invokes: vibecode claims takeover --file src/core/runs/store.ts --to user
   or: vibecode claims takeover --file src/core/runs/store.ts --to-agent B
2. ClaimManager:
   a. Revokes Agent A's claim immediately (status → 'revoked')
   b. Creates ConflictRecord type=user_override, resolved immediately
   c. If --to-agent B: grants claim to Agent B
   d. If --to user: no claim granted, file is unclaimed
3. Agent A is notified (via terminal or MCP callback):
   {
     "code": "CLAIM_REVOKED",
     "message": "Your claim on src/core/runs/store.ts was revoked by the user",
     "details": {
       "reason": "user_override",
       "reassigned_to": "user" | "Agent B"
     }
   }
4. Agent A must:
   a. Stop editing the file
   b. Discard or stash uncommitted changes to that file
   c. Continue with remaining claimed files
5. If Agent A had uncommitted changes:
   - Git stash created: git stash push -m "vibecode: revoked claim stash for Agent A"
   - User notified of stash location
   - Agent A informed to pull stash if needed later
```

**User-visible messages:**

```text
✓ File src/core/runs/store.ts taken from Agent A and assigned to you.
  Agent A has been notified and must stop editing this file.
  Agent A's uncommitted changes have been stashed (git stash list to inspect).
```

**Additional CLI commands:**

```powershell
vibecode claims takeover --file <path>                    # take to user
vibecode claims takeover --file <path> --to-agent <id>   # reassign to agent
vibecode claims takeover --agent <id> --all               # take all files from an agent
```

---

### 7. Handoff Request (Agent A Asks Agent B to Take Over)

**Scenario:** Agent A cannot complete its work (task too complex, context running low, better suited for Agent B). Agent A requests a handoff.

**Conflict type:** `handoff_request`

**Conflict states:** `detected` → `pending` → `resolved` | `failed`

**Auto-resolvable:** No. Requires both agents and possibly user agreement.

**Handoff protocol:**

```text
1. Agent A calls: vibecode handoff request --to B --files src/core/runs/store.ts \
   --reason "Context budget depleted, need fresh agent to complete refactoring"
2. HandoffManager creates HandoffRequest status=requested
3. Agent B is notified:
   {
     "code": "HANDOFF_REQUESTED",
     "message": "Agent A requests you take over src/core/runs/store.ts",
     "details": {
       "from_agent": "Agent A",
       "reason": "Context budget depleted",
       "files": ["src/core/runs/store.ts"],
       "context_summary": "Added run_id generation, working on current.ts mirroring",
       "pending_changes": ["src/core/runs/current.ts"]
     }
   }
4. Agent B may:
   a. Accept: vibecode handoff accept <handoff_id>
      - Agent A's claims transferred to Agent B
      - Agent A's run context summary available to Agent B
      - Agent A releases all claimed files
      - HandoffRequest status → 'completed'
   b. Reject: vibecode handoff reject <handoff_id>
      - HandoffRequest status → 'rejected'
      - Agent A must find another resolution
   c. Ignore (timeout after escalation_timeout_ms):
      - HandoffRequest status → 'failed'
      - Escalated to user
5. During handoff in_progress:
   - Both agents have shared read access
   - Only Agent B may write
   - Agent A must not modify handoff files
6. After handoff completed:
   - Agent A's claims are released
   - Agent B holds all transferred claims
   - Agent A's uncommitted changes are preserved in git stash if needed
```

**User-visible messages:**

```text
📋 Handoff Request
  
  Agent A → Agent B
  Files: src/core/runs/store.ts, src/core/runs/current.ts
  Reason: Context budget depleted, need fresh agent
  Context: Added run_id generation, working on current.ts mirroring
  
  Agent B: Accept or reject this handoff?
  [1] Accept
  [2] Reject
  [3] Let user decide
```

**Additional CLI commands:**

```powershell
vibecode handoff request --from <agent_id> --to <agent_id> --files <paths> --reason <text>
vibecode handoff accept <handoff_id>
vibecode handoff reject <handoff_id>
vibecode handoff list                           # list pending handoffs
vibecode handoff status <handoff_id>
```

**MCP tools:**

```text
vibecode_handoff_request    → create handoff request
vibecode_handoff_accept     → accept a handoff
vibecode_handoff_reject     → reject a handoff
vibecode_handoff_list       → list pending handoffs
```

---

### 8. Merge Repair Run (Conflict Needs Manual Resolution)

**Scenario:** A concurrent edit conflict (type 3) was not auto-resolvable. The user spawns a merge repair run to get an AI-assisted merge.

**Conflict type:** `merge_repair`

**Conflict states:** `detected` → `pending` → `resolved` | `failed`

**Auto-resolvable:** No. Always user-initiated.

**Handoff protocol:**

```text
1. User invokes: vibecode merge repair --conflict <conflict_id>
2. MergeRepairManager:
   a. Creates a new run with task="merge repair for <conflict_id>"
   b. Collects both agents' diffs for the conflicting files
   c. Builds merge context:
      - Original file (before either agent modified)
      - Agent A's version with diff
      - Agent B's version with diff
      - Both agents' task descriptions
      - Import/dependency context
   d. Flash model receives merge context and produces merge strategy
   e. Final prompt includes merge instructions
   f. User previews merge prompt
   g. Merge prompt is sent to terminal for execution
3. Merge repair run creates artifacts under:
   .vibecode/runs/<merge_run_id>/
     merge/
       original_file.ts
       agent_a_version.ts
       agent_b_version.ts
       agent_a_diff.txt
       agent_b_diff.txt
       merge_strategy.md
4. After merge:
   a. Tests are run against merged result
   b. If tests pass → conflict resolved
   c. If tests fail → conflict failed, manual intervention required
   d. Both agents notified of resolution
5. ConflictRecord updated:
   - resolution.strategy = 'merge_manual'
   - resolution.artifacts = merge run artifacts
```

**User-visible messages:**

```text
🔧 Merge Repair Run Created
  
  Run ID: 2026-06-06_003 (merge repair)
  Conflict: concurrent_edit on src/core/runs/store.ts
  Original: 120 lines (before either agent)
  Agent A: +45/-12 lines
  Agent B: +30/-8 lines
  
  Preview the merge prompt, then send to terminal for resolution.
```

**Additional CLI commands:**

```powershell
vibecode merge repair --conflict <conflict_id>
vibecode merge status <merge_run_id>
vibecode merge artifacts <merge_run_id>           # show merge artifacts
```

---

### 9. Validation Conflict (Tests Pass for One Agent but Fail Due to Another's Changes)

**Scenario:** Agent A's tests pass in isolation. Agent B's changes break Agent A's tests. Detected during post-run validation or commit guard.

**Conflict type:** `validation_conflict`

**Conflict states:** `detected` → `pending` → `resolved` | `failed`

**Auto-resolvable:** Partially. Can detect and report, but resolution requires coordination.

**Handoff protocol:**

```text
1. Agent A runs tests: all pass
2. Agent B makes changes to shared module
3. Agent A tries to finalize:
   a. CommitGuard runs Agent A's test suite
   b. Tests now fail (due to Agent B's changes)
   c. ConflictRecord type=validation_conflict
4. finalize BLOCKED with VALIDATION_CONFLICT:
   {
     "ok": false,
     "error": {
       "code": "VALIDATION_CONFLICT",
       "message": "Agent A's tests fail after Agent B modified shared module",
       "details": {
         "failing_tests": ["test_run_store_creation", "test_current_mirror"],
         "caused_by_changes_in": ["src/core/runs/store.ts"],
         "modified_by": "Agent B",
         "suggested_actions": ["coordinate_fix", "revert_agent_b_changes", "user_decide"]
       }
     }
   }
5. Resolution options:
   a. Agent B fixes the breaking change (preferred)
   b. Agent A adapts to Agent B's changes
   c. Agent B's changes are reverted
   d. User decides who should adapt
   e. Both agents coordinate on a compatible interface
6. If Agent B is still active:
   - Agent B receives VALIDATION_BREAKAGE alert:
     {
       "code": "VALIDATION_BREAKAGE",
       "message": "Your changes break Agent A's tests in run 2026-06-06_001",
       "details": {
         "affected_agent": "Agent A",
         "failing_tests": ["test_run_store_creation"],
         "your_changes": ["src/core/runs/store.ts"]
       }
     }
   - Agent B may fix, revert, or escalate
7. After resolution:
   - Both agents' tests must pass
   - ConflictRecord resolved
   - Both agents can finalize
```

**User-visible messages:**

```text
🔴 VALIDATION CONFLICT
  
  Agent A's tests pass, but Agent B's changes broke them.
  
  Failing tests (Agent A):
  - test_run_store_creation
  - test_current_mirror
  
  Caused by Agent B's changes to:
  - src/core/runs/store.ts (+30/-8)
  
  Options:
  [1] Ask Agent B to fix the breaking change
  [2] Ask Agent A to adapt to the new interface
  [3] Revert Agent B's changes to store.ts
  [4] View both agents' changes side-by-side
  [5] Spawn merge repair run
```

**Additional CLI commands:**

```powershell
vibecode conflicts validate                     # run all agents' test suites
vibecode conflicts validate --agent <id>        # run one agent's tests
vibecode conflicts show <conflict_id> --tests   # show failing tests
```

---

## Cross-Cutting Concerns

### Commit Guard Integration

The commit guard is the final safety net. Before any per-run commit:

```text
1. Check all claims for the files being committed
2. Check if any concurrent_edit conflicts are unresolved
3. Check if any validation_conflicts are unresolved
4. Check if any claims are stale
5. If any high/critical conflicts exist → BLOCK commit
6. If only low/medium conflicts → WARN but allow commit
7. Record conflict state in commit metadata
```

```powershell
# Commit guard pre-check (runs automatically before commit)
vibecode commit guard --run <run_id>
# Returns:
# {
#   "ok": true|false,
#   "blocks": [...],
#   "warnings": [...],
#   "conflicts": [...]
# }
```

### File Watcher Integration

The file watcher detects unauthorized edits:

```text
1. File watcher monitors all claimed files
2. When a file is modified:
   a. Check if the modifying agent holds a claim for that file
   b. If no claim exists → WARNING (unclaimed edit)
   c. If another agent holds the claim → UNAUTHORIZED_EDIT conflict
   d. Log the edit with timestamp and agent context
3. Unauthorized edits create ConflictRecord with severity=high
4. Commit guard blocks commits containing unauthorized edits
```

### Heartbeat Protocol

```text
1. Each agent sends heartbeat every 30s (configurable)
2. Heartbeat contains:
   - agent_id
   - timestamp
   - list of currently active claims
   - process id (if available)
3. HeartbeatMonitor checks all claims:
   - (now - heartbeat_at) > heartbeat_ttl_ms → stale
   - stale + grace period → revoked
4. Heartbeats stored in .vibecode/coordination/heartbeats/<agent_id>.json
5. HeartbeatMonitor runs as background service in TypeScript
```

### Agent Registration

```text
1. When an agent starts working through Vibecode:
   a. vibecode agents register --name <name> --type <type>
   b. AgentSession created with status='active'
   c. Agent receives agent_id
2. Agent must re-register if it reconnects after disconnection
3. Agent registration creates initial heartbeat
4. On clean shutdown: vibecode agents unregister --agent <id>
```

### MCP Integration

All coordination tools are exposed through VibecodeMCP:

```text
MCP Server: vibecode-mcp (repo-bound stdio)

Tools:
  vibecode_claims_list        - List file claims with filters
  vibecode_claims_add         - Attempt to claim a file
  vibecode_claims_release     - Release a claim
  vibecode_claims_status      - Check claim status for a path
  vibecode_claims_takeover    - User force-take a file
  vibecode_agents_list        - List registered agents
  vibecode_agents_status      - Check agent status
  vibecode_conflicts_list     - List open conflicts
  vibecode_conflicts_show     - Show conflict details
  vibecode_conflicts_resolve  - Resolve a conflict
  vibecode_handoff_request    - Request handoff
  vibecode_handoff_accept     - Accept handoff
  vibecode_handoff_reject     - Reject handoff
  vibecode_dependencies_check - Check agent dependencies
  vibecode_commit_guard       - Run commit guard pre-check
  vibecode_merge_preview      - Preview merge repair context
```

### Artifact Layout for Coordination

```text
.vibecode/
  coordination/
    state.json                    # WorkspaceConflictState
    config.json                   # CoordinationConfig overrides
    heartbeats/
      <agent_id>.json             # per-agent heartbeat state
    conflicts/
      <conflict_id>.json          # individual conflict records
      <conflict_id>/
        evidence/                 # detector output, diffs, etc.
    handoffs/
      <handoff_id>.json           # individual handoff records
    claims/
      <claim_id>.json             # individual claim records
```

### Conflict Resolution Priority

When multiple strategies are possible:

```text
1. User decision (always wins)
2. Handoff completion (agent-to-agent agreement)
3. Auto-revoke stale claims (system cleanup)
4. Auto-grant shared claims (no exclusivity conflict)
5. Escalation to user (timeout or unresolvable)
```

### Severity Escalation Rules

```text
low → medium:
  - Conflict exists for > 5 minutes without resolution
  - Affected agent is still active and editing

medium → high:
  - Agent edited a file despite conflict
  - Commit attempted with unresolved conflict
  - Two or more agents affected

high → critical:
  - Multiple concurrent edits detected
  - Tests failing due to conflict
  - Data loss risk (uncommitted changes at risk)
```

### State Machine Summary

```text
FileClaim:
  active → stale (heartbeat expired)
  stale → active (heartbeat resumed)
  stale → revoked (grace period expired)
  active → relinquished (agent releases)
  active → revoked (user override)
  active → conflicting (conflict detected)

AgentSession:
  active → idle (no recent edits)
  idle → active (edit detected)
  active → stale (heartbeat expired)
  stale → active (reconnected)
  stale → terminated (process confirmed dead)

ConflictRecord:
  detected → pending (resolution started)
  pending → resolved (resolution succeeded)
  pending → failed (resolution failed)
  detected → resolved (immediate user override)

HandoffRequest:
  requested → accepted (target agent accepts)
  requested → rejected (target agent declines)
  requested → failed (timeout)
  accepted → in_progress (transfer started)
  in_progress → completed (transfer done)
  in_progress → failed (transfer error)
```

---

## Implementation Checkpoints

This design should be implemented in phases aligned with `IMPLEMENTATION_MAP.md`:

```text
Phase 1: Core coordination primitives
  - FileClaim model and ClaimManager
  - AgentSession model and AgentRegistry
  - WorkspaceConflictState persistence
  - Basic CLI: claims add/release/list/status

Phase 2: Conflict detection
  - ClaimDenied detector
  - OverlappingPath detector
  - StaleClaim detector (HeartbeatMonitor)
  - CommitGuard integration

Phase 3: File watcher and concurrent edit detection
  - FileWatcher for claimed files
  - ConcurrentEdit detector at finalize time
  - ValidationConflict detector (test runner integration)

Phase 4: Handoff protocol
  - HandoffRequest model and HandoffManager
  - CrossDependency detector
  - MCP tool integration

Phase 5: User override and merge repair
  - UserOverride flow (claims takeover)
  - MergeRepair run spawning
  - Full MCP tool surface

Phase 6: Desktop UI integration
  - Conflict notification UI
  - Handoff approval UI
  - Merge repair preview UI
```

---

## Testing Strategy

Each conflict type requires:

```text
1. Unit test: detector correctly identifies the conflict
2. Unit test: state transitions work as specified
3. Integration test: CLI command produces expected output
4. Integration test: MCP tool returns expected response
5. Integration test: commit guard blocks when expected
6. Scenario test: full workflow from detection to resolution
7. Edge case: agent ignores protocol and edits anyway
8. Edge case: agent crashes during handoff
9. Edge case: user overrides during active handoff
```

Expected test commands:

```powershell
# TypeScript
pnpm test -- --grep "conflict|claim|handoff|coordination"

# Python (if coordination logic extends to scanner)
uv run pytest -k "conflict or claim or coordination"
```

---

## Summary

```text
Advisory claims + file watcher + commit guard = safe multi-agent coordination

No hard locks. No hidden state. Every conflict is visible.
User is always final authority.
Every resolution is recorded as an artifact.
Every agent can be interrupted, handed off, or overridden.
The system detects violations even when agents ignore protocol.
```
