import {
  getAgentOperatingMode,
  getAgentTask,
  type AgentOperatingMode,
} from '../coordination/agent_operating_mode.js';
import { HEARTBEAT_TTL_MS } from '../coordination/heartbeat.js';
import type { AgentSession, AgentStatus } from '../coordination/types.js';
import {
  getAgentRecoveryGuidance,
  type AgentRecoveryGuidance,
} from './recovery_guidance.js';

/**
 * Phase 3B — agent runtime awareness / preflight (read-only, pure).
 *
 * Dogfoods showed agents losing track of their own runtime state: stale MCP
 * server sessions, heartbeats gone stale during long test runs, shared trees
 * full of unrelated WIP, and uncertainty about whether the commit guard would
 * isolate a commit or hard-block. This module answers those questions in ONE
 * compact, bounded summary an agent reads before editing, committing, or
 * continuing after long-running work.
 *
 * Hard rules:
 *   - pure function over already-loaded data — no filesystem, no git, no
 *     scanner, no writes, no heartbeat/claim/release/reap mutation;
 *   - bounded output (fixed sections, capped task text, deduped short lists);
 *   - mirrors — never weakens — the real policies: finalize stays conservative
 *     (any unclaimed/stale-overlap dirty file blocks readiness) while the
 *     commit guard MAY still make an isolated claimed-files-only commit
 *     (Phase 3A) when no unclaimed file is staged;
 *   - recommendations are real, safe commands only: no raw git mutation, no
 *     cross-agent release, no force cleanup, no `.vibecode` editing;
 *   - the `server` section is filled by the MCP adapter (the live server knows
 *     its own identity); core/CLI report `null` because the CLI always runs
 *     the current build.
 */

/** Heartbeat age after which the preflight recommends a heartbeat (half TTL). */
export const RUNTIME_HEARTBEAT_RECOMMEND_AFTER_MS = Math.floor(HEARTBEAT_TTL_MS / 2);

/** Cap on the task text echoed in the agent section. */
export const RUNTIME_AWARENESS_TASK_MAX_CHARS = 200;

/** Hard cap on each recommendation list. */
export const RUNTIME_AWARENESS_MAX_RECOMMENDATIONS = 12;

export type RuntimeNoticeSeverity = 'info' | 'warning' | 'high' | 'block';

export interface RuntimeNotice {
  code: string;
  severity: RuntimeNoticeSeverity;
  message: string;
}

/** Claim-aware changed-file counts the preflight needs (full-tree counts, never capped samples). */
export interface RuntimeWorkspaceCounts {
  total: number;
  claimed_by_agent: number;
  claimed_by_other_agent: number;
  unclaimed: number;
  stale_claim_overlap: number;
  generated_or_ignored: number;
  /** Unclaimed/stale-overlap changed files already staged in the git index. */
  staged_unclaimed: number;
}

/** Narrow view of the shared git changes summary used as preflight input. */
export interface RuntimeAwarenessChanges {
  /** False when git changed files could not be determined (fail closed). */
  ok: boolean;
  dirty: boolean;
  counts: RuntimeWorkspaceCounts;
}

/** Minimal triage view used to count conflicts involving the current agent. */
export interface RuntimeConflictTriage {
  requesting_agent_id: string | null;
  blocking_agent_id: string | null;
  triage_status: string;
}

export interface AgentRuntimeAwarenessInput {
  /** Resolved session (computed stale-aware status), even when terminated; null when missing/unregistered. */
  agent: AgentSession | null;
  /** The agent_id the caller asked about (for missing-agent reporting). */
  requestedAgentId?: string | null;
  changes: RuntimeAwarenessChanges;
  /** Count of the agent's active work intents (full count, not a capped sample). */
  activeIntentsCount: number;
  /** Count of intents releasable right now (clean-tree condition already applied). */
  releasableIntentsCount: number;
  /** Phase 3C: count of the agent's own ACTIVE claims (dirty or clean). Default 0. */
  activeClaimsCount?: number;
  /** Triage summaries of unresolved conflicts. */
  conflictTriages?: readonly RuntimeConflictTriage[];
  staleCoordinationPresent: boolean;
  /** Clock (ISO-8601). */
  now: string;
}

/** Identity of the LIVE MCP server build; filled by the MCP adapter only. */
export interface RuntimeAwarenessServer {
  server_name: string;
  server_version: string;
  tool_count: number;
  started_at: string;
  repo_root: string;
}

export interface AgentRuntimeAwareness {
  agent: {
    registered: boolean;
    agent_id: string | null;
    status: AgentStatus | null;
    operating_mode: AgentOperatingMode | null;
    task: string | null;
    task_truncated: boolean;
    heartbeat_age_ms: number | null;
    heartbeat_ttl_ms: number;
    needs_heartbeat: boolean;
  };
  /** Null from core/CLI; the MCP session_bootstrap adapter fills it for the live server. */
  server: RuntimeAwarenessServer | null;
  workspace: {
    git_available: boolean;
    dirty: boolean;
    /** Non-generated dirty files NOT claimed by this agent exist (shared-tree WIP). */
    shared_tree_dirty: boolean;
    changed_counts: RuntimeWorkspaceCounts;
  };
  commit_guard: {
    /** Valid, fresh build session — allowed to claim/edit. */
    can_edit: boolean;
    /** Finalize check would not be blocked (conservative gate, unchanged by Phase 3A/3B). */
    finalize_ready: boolean;
    /** Finalize ready AND at least one committable claimed file. */
    commit_guard_ready: boolean;
    /** Finalize blocked ONLY by unclaimed dirty files, none staged, claimed files committable (Phase 3A). */
    isolated_commit_possible: boolean;
    staged_unclaimed_blockers: number;
    committable_count: number;
  };
  coordination: {
    active_intents_count: number;
    releasable_intents_count: number;
    conflicts_involving_agent_count: number;
    still_blocking_conflicts_involving_agent_count: number;
    stale_coordination_present: boolean;
  };
  recommended_next_tools: string[];
  recommended_cli_commands: string[];
  warnings: RuntimeNotice[];
  blockers: RuntimeNotice[];
  checked_at: string;
  /**
   * Phase 3C: session continuity / safe resume guidance — one primary
   * resume_state plus explicit flags and exact safe next commands. Read-only;
   * never auto-resumes, auto-claims, auto-releases, or cleans up.
   */
  recovery: AgentRecoveryGuidance;
}

function notice(code: string, severity: RuntimeNoticeSeverity, message: string): RuntimeNotice {
  return { code, severity, message };
}

const REGISTER_COMMAND =
  'vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json';

/** Bounded, deduped list builder. */
class Recommendations {
  readonly tools: string[] = [];
  readonly commands: string[] = [];

  tool(...names: string[]): void {
    for (const name of names) {
      if (this.tools.length >= RUNTIME_AWARENESS_MAX_RECOMMENDATIONS) return;
      if (!this.tools.includes(name)) this.tools.push(name);
    }
  }

  command(...commands: string[]): void {
    for (const command of commands) {
      if (this.commands.length >= RUNTIME_AWARENESS_MAX_RECOMMENDATIONS) return;
      if (!this.commands.includes(command)) this.commands.push(command);
    }
  }
}

/**
 * Build the compact runtime/preflight awareness summary. Pure and read-only:
 * the inputs are never mutated and nothing is loaded, spawned, or written.
 */
export function getAgentRuntimeAwareness(input: AgentRuntimeAwarenessInput): AgentRuntimeAwareness {
  const warnings: RuntimeNotice[] = [];
  const blockers: RuntimeNotice[] = [];
  const rec = new Recommendations();

  const agent = input.agent;
  const requestedAgentId = input.requestedAgentId ?? null;
  const agentId = agent?.agent_id ?? requestedAgentId;
  const status: AgentStatus | null = agent?.status ?? null;
  const operatingMode = agent ? getAgentOperatingMode(agent) : null;
  const rawTask = agent ? getAgentTask(agent) : null;
  const taskTruncated = rawTask !== null && rawTask.length > RUNTIME_AWARENESS_TASK_MAX_CHARS;
  const task = rawTask === null
    ? null
    : taskTruncated
      ? rawTask.slice(0, RUNTIME_AWARENESS_TASK_MAX_CHARS)
      : rawTask;

  // --- heartbeat age (computed only; never mutates the session) ---
  const nowMs = Date.parse(input.now);
  let heartbeatAgeMs: number | null = null;
  if (agent) {
    const beatMs = Date.parse(agent.last_heartbeat_at);
    if (!Number.isNaN(beatMs) && !Number.isNaN(nowMs)) {
      heartbeatAgeMs = Math.max(0, nowMs - beatMs);
    }
  }
  const isAlive = status === 'active' || status === 'idle';
  const isStale = status === 'stale' || status === 'unknown';
  const needsHeartbeat =
    agent !== null &&
    status !== 'terminated' &&
    (isStale || heartbeatAgeMs === null || heartbeatAgeMs >= RUNTIME_HEARTBEAT_RECOMMEND_AFTER_MS);

  // --- lifecycle notices + base recommendations ---
  const validSession = agent !== null && operatingMode !== null && rawTask !== null;
  if (agent === null) {
    if (requestedAgentId) {
      blockers.push(
        notice(
          'AGENT_NOT_FOUND',
          'block',
          `agent_id ${requestedAgentId} is not a registered agent. Register a new agent before working.`,
        ),
      );
    } else {
      warnings.push(
        notice(
          'NOT_REGISTERED',
          'high',
          'No agent registered. Register (read_only or build, with a task) before editing.',
        ),
      );
    }
    rec.tool('vibecode_session_bootstrap');
    rec.command(REGISTER_COMMAND);
  } else if (status === 'terminated') {
    blockers.push(
      notice(
        'AGENT_TERMINATED',
        'block',
        `Agent ${agent.agent_id} is terminated and cannot edit, heartbeat, or commit. Register a new agent.`,
      ),
    );
    rec.tool('vibecode_session_bootstrap');
    rec.command(REGISTER_COMMAND);
  } else if (!validSession) {
    blockers.push(
      notice(
        'INVALID_AGENT_SESSION',
        'block',
        `Agent ${agent.agent_id} is missing required session metadata (operating_mode/task). Re-register through session bootstrap with register=true, agent_mode, and task.`,
      ),
    );
    rec.tool('vibecode_session_bootstrap');
    rec.command(REGISTER_COMMAND);
  } else if (isStale) {
    warnings.push(
      notice(
        'AGENT_STALE',
        'high',
        `Agent ${agent.agent_id} is ${status}. Heartbeat (or re-run session bootstrap with your agent id) before editing or committing.`,
      ),
    );
    rec.tool('vibecode_agent_heartbeat', 'vibecode_session_bootstrap');
    rec.command(
      `vibecode agents heartbeat --agent ${agent.agent_id} --json`,
      `vibecode session bootstrap --agent ${agent.agent_id} --json`,
    );
  } else if (needsHeartbeat) {
    warnings.push(
      notice(
        'HEARTBEAT_RECOMMENDED',
        'warning',
        `Agent ${agent.agent_id} has not heartbeat for over half the TTL. Heartbeat during long-running work so the session does not go stale.`,
      ),
    );
    rec.tool('vibecode_agent_heartbeat');
    rec.command(`vibecode agents heartbeat --agent ${agent.agent_id} --json`);
  }

  // --- workspace / commit readiness ---
  const counts = { ...input.changes.counts };
  const gitAvailable = input.changes.ok;
  const dirty = gitAvailable && input.changes.dirty;
  const unclaimedForFinalize = counts.unclaimed + counts.stale_claim_overlap;
  const sharedTreeDirty =
    gitAvailable && counts.claimed_by_other_agent + unclaimedForFinalize > 0;

  const isActiveBuild = validSession && operatingMode === 'build' && isAlive;
  const canEdit = isActiveBuild;

  let finalizeReady = false;
  let commitGuardReady = false;
  let isolatedCommitPossible = false;
  let stagedUnclaimedBlockers = 0;

  if (!gitAvailable) {
    warnings.push(
      notice(
        'GIT_UNAVAILABLE',
        'high',
        'git changed files could not be determined; finalize/commit readiness is unknown and fails closed.',
      ),
    );
  } else if (isActiveBuild) {
    stagedUnclaimedBlockers = counts.staged_unclaimed;
    finalizeReady = unclaimedForFinalize === 0;
    commitGuardReady = finalizeReady && counts.claimed_by_agent > 0;
    isolatedCommitPossible =
      counts.claimed_by_agent > 0 &&
      unclaimedForFinalize > 0 &&
      counts.staged_unclaimed === 0;

    if (commitGuardReady) {
      rec.tool('vibecode_git_changes', 'vibecode_finalize_check');
      rec.command(
        `vibecode git changes --agent ${agentId} --json`,
        `vibecode finalize check --agent ${agentId} --json`,
        `vibecode commit guard --agent ${agentId} --dry-run --json`,
      );
    } else if (isolatedCommitPossible) {
      warnings.push(
        notice(
          'ISOLATED_COMMIT_LIKELY',
          'warning',
          `Finalize is blocked by ${unclaimedForFinalize} unclaimed dirty file(s), but the commit guard can likely make an ISOLATED commit of your ${counts.claimed_by_agent} claimed file(s). Skipped unclaimed files stay dirty and are never staged, committed, or modified.`,
        ),
      );
      rec.tool('vibecode_git_changes', 'vibecode_finalize_check');
      rec.command(
        `vibecode git changes --agent ${agentId} --json`,
        `vibecode finalize check --agent ${agentId} --json`,
        `vibecode commit guard --agent ${agentId} --dry-run --json`,
      );
    } else if (counts.staged_unclaimed > 0) {
      warnings.push(
        notice(
          'STAGED_UNCLAIMED_FILES_PRESENT',
          'high',
          `${counts.staged_unclaimed} unclaimed dirty file(s) are already STAGED in the git index. The commit guard will block (STAGED_UNCLAIMED_FILES_BLOCKED); unstage and review them yourself — never commit them.`,
        ),
      );
      rec.tool('vibecode_git_changes', 'vibecode_finalize_check');
      rec.command(
        `vibecode git changes --agent ${agentId} --json`,
        `vibecode finalize check --agent ${agentId} --json`,
      );
    } else if (dirty && counts.claimed_by_agent === 0 && unclaimedForFinalize > 0) {
      // Dirty unclaimed-only tree: inspect; never auto-claim or auto-select files.
      rec.tool('vibecode_git_changes');
      rec.command(`vibecode git changes --agent ${agentId} --json`);
    } else if (!dirty && input.activeIntentsCount === 0) {
      // Clean tree, no declared work yet: orient and declare an explicit scope.
      rec.tool('vibecode_tool_profile', 'vibecode_claims_plan');
      rec.command(
        'vibecode tools profile --profile build_pre_edit --json',
        `vibecode claims plan --agent ${agentId} --path <path> --json`,
      );
    }
  } else if (validSession && operatingMode === 'read_only' && isAlive) {
    warnings.push(
      notice(
        'READ_ONLY_AGENT',
        'info',
        `Agent ${agentId} is read_only: it must not edit, claim, finalize, or commit.`,
      ),
    );
    rec.tool('vibecode_workspace_info', 'vibecode_project_instructions');
    rec.command('vibecode tools profile --profile read_only_orientation --json');
  }

  // --- coordination awareness (Part E) ---
  const triages = input.conflictTriages ?? [];
  const involving = agentId
    ? triages.filter((t) => t.requesting_agent_id === agentId || t.blocking_agent_id === agentId)
    : [];
  const stillBlockingInvolving = involving.filter((t) => t.triage_status === 'still_blocking');

  if (isActiveBuild && input.releasableIntentsCount > 0) {
    rec.tool('vibecode_claim_intents_list', 'vibecode_claim_intent_release');
    rec.command(
      `vibecode claims intents list --agent ${agentId} --status active --json`,
      `vibecode claims intent-release --agent ${agentId} --intent-id <intent_id> --dry-run --json`,
    );
  }
  if (stillBlockingInvolving.length > 0) {
    warnings.push(
      notice(
        'CONFLICTS_INVOLVING_AGENT',
        'warning',
        `${stillBlockingInvolving.length} unresolved conflict(s) involving this agent are still actively blocking.`,
      ),
    );
    rec.tool('vibecode_conflicts_list', 'vibecode_conflict_detail');
    rec.command(
      'vibecode tools profile --profile conflict_resolution --json',
      'vibecode conflicts list --json',
    );
  }
  if (input.staleCoordinationPresent) {
    rec.tool('vibecode_claims_list', 'vibecode_claims_reap');
    rec.command(
      'vibecode tools profile --profile coordination_housekeeping --json',
      'vibecode claims reap --dry-run --json',
    );
  }

  const base: Omit<AgentRuntimeAwareness, 'recovery'> = {
    agent: {
      registered: agent !== null,
      agent_id: agentId,
      status,
      operating_mode: operatingMode,
      task,
      task_truncated: taskTruncated,
      heartbeat_age_ms: heartbeatAgeMs,
      heartbeat_ttl_ms: HEARTBEAT_TTL_MS,
      needs_heartbeat: needsHeartbeat,
    },
    server: null,
    workspace: {
      git_available: gitAvailable,
      dirty,
      shared_tree_dirty: sharedTreeDirty,
      changed_counts: counts,
    },
    commit_guard: {
      can_edit: canEdit,
      finalize_ready: finalizeReady,
      commit_guard_ready: commitGuardReady,
      isolated_commit_possible: isolatedCommitPossible,
      staged_unclaimed_blockers: stagedUnclaimedBlockers,
      committable_count: gitAvailable ? counts.claimed_by_agent : 0,
    },
    coordination: {
      active_intents_count: input.activeIntentsCount,
      releasable_intents_count: input.releasableIntentsCount,
      conflicts_involving_agent_count: involving.length,
      still_blocking_conflicts_involving_agent_count: stillBlockingInvolving.length,
      stale_coordination_present: input.staleCoordinationPresent,
    },
    recommended_next_tools: rec.tools,
    recommended_cli_commands: rec.commands,
    warnings,
    blockers,
    checked_at: input.now,
  };

  // Phase 3C: classify the resume/recovery state over the awareness just built.
  return {
    ...base,
    recovery: getAgentRecoveryGuidance({
      awareness: base,
      activeClaimsCount: input.activeClaimsCount ?? 0,
    }),
  };
}
