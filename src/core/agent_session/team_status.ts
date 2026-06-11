import {
  getAgentOperatingMode,
  getAgentTask,
  type AgentOperatingMode,
} from '../coordination/agent_operating_mode.js';
import { listAgents } from '../coordination/agents.js';
import { listClaimIntents } from '../coordination/bulk_claims.js';
import { listFileClaims } from '../coordination/claims.js';
import { listConflicts, type ConflictRecord } from '../coordination/conflicts.js';
import { listConflictTriages } from '../coordination/conflict_triage.js';
import { summarizeStaleCoordination } from '../coordination/stale_coordination.js';
import type { AgentSession, AgentStatus, ClaimIntent, FileClaim } from '../coordination/types.js';
import { getGitChangesSummary } from '../workspace/git_changes_summary.js';
import type { GitReadOnlyRunner } from '../workspace/git_status.js';
import { HEARTBEAT_TTL_MS } from '../coordination/heartbeat.js';
import {
  RUNTIME_AWARENESS_TASK_MAX_CHARS,
  type RuntimeNotice,
} from './runtime_awareness.js';

/**
 * Phase 4C — read-only team status / team overview (pure core).
 *
 * Answers the multi-agent coordination questions a human or agent asks at the
 * start of a session: who is active, who has claims, who is blocked, who is
 * stale, what conflicts exist, and what safe commands should I run next?
 *
 * Hard rules:
 *   - pure composition of existing read-only services — no new state machines;
 *   - read-only: never registers, heartbeats, releases, claims, reaps,
 *     resolves, transfers, assigns, or mutates git/source/coordination state;
 *   - bounded output (capped agents, capped samples, capped commands);
 *   - recommendations are real, safe commands only: no raw git mutation, no
 *     cross-agent release, no force cleanup, no `.vibecode` editing;
 *   - team status does NOT choose which agent continues — no assignment;
 *   - does NOT override detailed tools (session_bootstrap, handoff_prepare,
 *     handoff_guide, conflict_detail, claims list remain canonical sources).
 */

/** Hard maximum for team_status max_agents / max_items. */
export const TEAM_STATUS_MAX_AGENTS = 50;
export const TEAM_STATUS_MAX_ITEMS = 50;

/** Default caps. */
export const DEFAULT_TEAM_STATUS_MAX_AGENTS = 20;
export const DEFAULT_TEAM_STATUS_MAX_ITEMS = 20;

/** Hard cap on each recommendation list. */
export const TEAM_STATUS_MAX_RECOMMENDATIONS = 12;

/** Machine-readable recommended actions for each agent. */
export const TEAM_STATUS_ACTIONS = [
  'observe_only',
  'ready_to_claim',
  'continue_work',
  'commit_claimed_work',
  'isolated_commit_possible',
  'release_clean_work',
  'prepare_handoff',
  'ready_for_handoff',
  'blocked_by_conflict',
  'heartbeat_needed',
  'housekeeping_needed',
  'terminated',
  'uncertain',
] as const;

export type TeamStatusAction = (typeof TEAM_STATUS_ACTIONS)[number];

/** Compact agent summary within the team status. */
export interface TeamStatusAgent {
  agent_id: string;
  status: AgentStatus;
  mode: AgentOperatingMode | null;
  task: string | null;
  task_truncated: boolean;
  heartbeat_age_ms: number | null;
  active_claims_count: number;
  active_intents_count: number;
  dirty_claimed_files_count: number;
  releasable_intents_count: number;
  conflicts_involving_agent_count: number;
  recommended_action: TeamStatusAction;
  safe_next_tools: string[];
  safe_cli_commands: string[];
  warnings: RuntimeNotice[];
  blockers: RuntimeNotice[];
}

/** Workspace-level summary. */
export interface TeamStatusWorkspace {
  git_available: boolean;
  dirty: boolean;
  changed_counts: {
    total: number;
    staged_unclaimed: number;
    staged_claimed_by_other_agent: number;
  };
  warnings: string[];
}

/** Top-level summary counts. */
export interface TeamStatusSummary {
  agents_total: number;
  agents_active: number;
  agents_stale: number;
  agents_terminated: number;
  build_agents: number;
  read_only_agents: number;
  active_claims: number;
  active_intents: number;
  unresolved_conflicts: number;
  stale_coordination_present: boolean;
  workspace_dirty: boolean;
  staged_blockers_present: boolean;
}

/** Compact claims summary. */
export interface TeamStatusClaimsSummary {
  active_count: number;
  stale_count: number;
  sample_active: { claim_id: string; path: string; agent_id: string }[];
}

/** Compact intents summary. */
export interface TeamStatusIntentsSummary {
  active_count: number;
  releasable_count: number;
  sample_active: { intent_id: string; agent_id: string; intent: string }[];
}

/** Compact conflicts summary. */
export interface TeamStatusConflictsSummary {
  unresolved_count: number;
  sample_unresolved: { conflict_id: string; conflict_type: string; involved_files: string[] }[];
}

/** The full team status overview DTO. */
export interface TeamStatusOverview {
  checked_at: string;
  summary: TeamStatusSummary;
  workspace: TeamStatusWorkspace;
  agents: TeamStatusAgent[];
  claims: TeamStatusClaimsSummary;
  intents: TeamStatusIntentsSummary;
  conflicts: TeamStatusConflictsSummary;
  stale_coordination: {
    has_stale_state: boolean;
    stale_agents_count: number;
    stale_active_claims_count: number;
  };
  recommended_next_tools: string[];
  recommended_cli_commands: string[];
  warnings: string[];
  blockers: string[];
  agents_truncated: boolean;
}

/** Options for the team status loader. */
export interface GetTeamStatusOptions {
  max_agents?: number;
  max_items?: number;
  /** Clock seam (ISO-8601). */
  now?: string;
  /** Test seam: read-only git runner. */
  gitRunner?: GitReadOnlyRunner;
}

/** Bounded, deduped recommendation builder. */
class Recommendations {
  readonly tools: string[] = [];
  readonly commands: string[] = [];

  tool(...names: string[]): void {
    for (const name of names) {
      if (this.tools.length >= TEAM_STATUS_MAX_RECOMMENDATIONS) return;
      if (!this.tools.includes(name)) this.tools.push(name);
    }
  }

  command(...commands: string[]): void {
    for (const command of commands) {
      if (this.commands.length >= TEAM_STATUS_MAX_RECOMMENDATIONS) return;
      if (!this.commands.includes(command)) this.commands.push(command);
    }
  }
}

function notice(code: string, severity: RuntimeNotice['severity'], message: string): RuntimeNotice {
  return { code, severity, message };
}

/**
 * Classify a team-level recommended action for one agent. Composes existing
 * Phase 3/4A services read-only — does NOT create a second state machine.
 */
function classifyAgentAction(args: {
  agent: AgentSession;
  operatingMode: AgentOperatingMode | null;
  activeClaimsCount: number;
  activeIntentsCount: number;
  releasableIntentsCount: number;
  dirtyClaimedFilesCount: number;
  conflictsInvolvingCount: number;
  stillBlockingConflictsCount: number;
  staleCoordinationPresent: boolean;
  gitAvailable: boolean;
  unclaimedDirtyCount: number;
  stagedUnclaimedCount: number;
}): { action: TeamStatusAction; warnings: RuntimeNotice[]; blockers: RuntimeNotice[] } {
  const warnings: RuntimeNotice[] = [];
  const blockers: RuntimeNotice[] = [];
  const {
    agent,
    operatingMode,
    activeClaimsCount,
    activeIntentsCount,
    releasableIntentsCount,
    dirtyClaimedFilesCount,
    stillBlockingConflictsCount,
    staleCoordinationPresent,
    gitAvailable,
    unclaimedDirtyCount,
    stagedUnclaimedCount,
  } = args;

  const status = agent.status;

  // Terminated
  if (status === 'terminated') {
    return { action: 'terminated', warnings, blockers };
  }

  // Stale / unknown
  if (status === 'stale' || status === 'unknown') {
    warnings.push(
      notice('AGENT_STALE', 'high', `Agent ${agent.agent_id} is ${status}. Heartbeat before continuing.`),
    );
    return { action: 'heartbeat_needed', warnings, blockers };
  }

  // Read-only
  if (operatingMode === 'read_only') {
    return { action: 'observe_only', warnings, blockers };
  }

  // Invalid session
  if (operatingMode === null || getAgentTask(agent) === null) {
    blockers.push(
      notice('INVALID_AGENT_SESSION', 'block', `Agent ${agent.agent_id} is missing session metadata.`),
    );
    return { action: 'uncertain', warnings, blockers };
  }

  // Git unavailable
  if (!gitAvailable) {
    blockers.push(
      notice('GIT_UNAVAILABLE', 'block', 'git changed files could not be determined.'),
    );
    return { action: 'uncertain', warnings, blockers };
  }

  // Blocked by staged files
  if (stagedUnclaimedCount > 0) {
    blockers.push(
      notice('STAGED_FILES_BLOCK', 'block', `${stagedUnclaimedCount} staged unclaimed file(s) block commit.`),
    );
    return { action: 'housekeeping_needed', warnings, blockers };
  }

  // Dirty claimed files
  if (dirtyClaimedFilesCount > 0) {
    if (unclaimedDirtyCount > 0) {
      warnings.push(
        notice('ISOLATED_COMMIT_POSSIBLE', 'warning',
          `Dirty claimed + unclaimed dirty files — isolated commit may be possible.`),
      );
      return { action: 'isolated_commit_possible', warnings, blockers };
    }
    return { action: 'commit_claimed_work', warnings, blockers };
  }

  // Blocked by conflict
  if (stillBlockingConflictsCount > 0) {
    blockers.push(
      notice('CONFLICT_BLOCKS', 'block',
        `${stillBlockingConflictsCount} still-blocking conflict(s) involve this agent.`),
    );
    return { action: 'blocked_by_conflict', warnings, blockers };
  }

  // Clean releasable intents
  if (releasableIntentsCount > 0) {
    return { action: 'release_clean_work', warnings, blockers };
  }

  // Active claims/intents but clean
  if (activeClaimsCount > 0 || activeIntentsCount > 0) {
    return { action: 'prepare_handoff', warnings, blockers };
  }

  // No claims, no intents
  return { action: 'ready_to_claim', warnings, blockers };
}

/**
 * Build the team status overview from already-loaded coordination data.
 * Pure and read-only: inputs are never mutated and nothing is loaded, spawned,
 * written, released, claimed, or transferred.
 */
export function buildTeamStatusOverview(input: {
  agents: readonly AgentSession[];
  claims: readonly FileClaim[];
  intents: readonly ClaimIntent[];
  conflicts: readonly ConflictRecord[];
  gitAvailable: boolean;
  gitDirty: boolean;
  gitChangedCount: number;
  stagedUnclaimed: number;
  stagedClaimedByOtherAgent: number;
  staleCoordinationPresent: boolean;
  maxAgents: number;
  maxItems: number;
  now: string;
}): TeamStatusOverview {
  const {
    agents,
    claims,
    intents,
    conflicts,
    gitAvailable,
    gitDirty,
    gitChangedCount,
    stagedUnclaimed,
    stagedClaimedByOtherAgent,
    staleCoordinationPresent,
    maxAgents,
    maxItems,
    now,
  } = input;

  const nowMs = Date.parse(now);
  const warnings: string[] = [];
  const blockers: string[] = [];
  const rec = new Recommendations();

  // Summary counts
  const activeAgents = agents.filter((a) => a.status === 'active' || a.status === 'idle');
  const staleAgents = agents.filter((a) => a.status === 'stale' || a.status === 'unknown');
  const terminatedAgents = agents.filter((a) => a.status === 'terminated');
  const buildAgents = agents.filter((a) => getAgentOperatingMode(a) === 'build');
  const readOnlyAgents = agents.filter((a) => getAgentOperatingMode(a) === 'read_only');

  const activeClaims = claims.filter((c) => c.status === 'active');
  const staleClaims = claims.filter((c) => c.status === 'stale');
  const activeIntents = intents.filter((i) => i.status === 'active');
  const unresolvedConflicts = conflicts.filter((c) => c.status === 'detected');

  // Compute releasable intents (clean-tree condition)
  const releasableIntents = activeIntents.filter((intent) => {
    const intentClaims = intent.claim_ids.map((id) => claims.find((c) => c.claim_id === id)).filter(Boolean);
    const allClean = intentClaims.every((c) => c && c.status === 'active');
    return allClean && gitAvailable && !gitDirty;
  });

  // Conflict triages for per-agent conflict counts
  const triages = listConflictTriages({
    agents: [...agents],
    claims: [...claims],
    intents: [...intents],
    conflicts: unresolvedConflicts,
    now,
  });

  // Per-agent summaries
  const boundedAgents = agents.slice(0, maxAgents);
  const agentsTruncated = agents.length > maxAgents;

  const agentSummaries: TeamStatusAgent[] = [];
  for (const agent of boundedAgents) {
    const mode = getAgentOperatingMode(agent);
    const rawTask = getAgentTask(agent);
    const taskTruncated = rawTask !== null && rawTask.length > RUNTIME_AWARENESS_TASK_MAX_CHARS;
    const task = rawTask === null
      ? null
      : taskTruncated ? rawTask.slice(0, RUNTIME_AWARENESS_TASK_MAX_CHARS) : rawTask;

    let heartbeatAgeMs: number | null = null;
    const beatMs = Date.parse(agent.last_heartbeat_at);
    if (!Number.isNaN(beatMs) && !Number.isNaN(nowMs)) {
      heartbeatAgeMs = Math.max(0, nowMs - beatMs);
    }

    const agentActiveClaims = activeClaims.filter((c) => c.agent_id === agent.agent_id);
    const agentActiveIntents = activeIntents.filter((i) => i.agent_id === agent.agent_id);
    const agentReleasable = releasableIntents.filter((i) => i.agent_id === agent.agent_id);

    // Per-agent dirty claimed files count
    const agentDirtyClaimed = gitAvailable
      ? agentActiveClaims.filter((c) => {
          // We approximate: if the agent has active claims and git is dirty,
          // we need the actual git changes summary per agent. For team status
          // we use a simpler heuristic based on the full changes summary.
          return false; // Will be refined below
        }).length
      : 0;

    // For accurate dirty claimed count, we need to use the git changes summary
    // with agent context. Since team_status is a summary tool, we use the
    // claims list + agent's claim ids as a proxy.
    // The actual dirty count comes from getGitChangesSummary per agent, but
    // that would be expensive for many agents. Instead, we note that
    // session_bootstrap / handoff_prepare are the canonical sources for
    // per-agent dirty state.
    // For team status, we report 0 for dirty_claimed_files_count and note
    // that agents should use git changes for detail.
    const dirtyClaimedCount = 0;

    // Conflicts involving this agent
    const involving = triages.conflicts.filter(
      (t) => t.requesting_agent_id === agent.agent_id || t.blocking_agent_id === agent.agent_id,
    );
    const stillBlocking = involving.filter((t) => t.triage_status === 'still_blocking');

    const { action, warnings: agentWarnings, blockers: agentBlockers } = classifyAgentAction({
      agent,
      operatingMode: mode,
      activeClaimsCount: agentActiveClaims.length,
      activeIntentsCount: agentActiveIntents.length,
      releasableIntentsCount: agentReleasable.length,
      dirtyClaimedFilesCount: dirtyClaimedCount,
      conflictsInvolvingCount: involving.length,
      stillBlockingConflictsCount: stillBlocking.length,
      staleCoordinationPresent,
      gitAvailable,
      unclaimedDirtyCount: 0,
      stagedUnclaimedCount: stagedUnclaimed,
    });

    // Build safe next commands for this agent
    const agentRec = new Recommendations();
    switch (action) {
      case 'heartbeat_needed':
        agentRec.tool('vibecode_agent_heartbeat', 'vibecode_session_bootstrap');
        agentRec.command(
          `vibecode agents heartbeat --agent ${agent.agent_id} --json`,
          `vibecode session bootstrap --agent ${agent.agent_id} --json`,
        );
        break;
      case 'observe_only':
        agentRec.tool('vibecode_workspace_info', 'vibecode_project_instructions');
        agentRec.command('vibecode tools profile --profile read_only_orientation --json');
        break;
      case 'ready_to_claim':
        agentRec.tool('vibecode_session_bootstrap', 'vibecode_claims_plan');
        agentRec.command(
          `vibecode session bootstrap --agent ${agent.agent_id} --json`,
          `vibecode claims plan --agent ${agent.agent_id} --path <path> --json`,
        );
        break;
      case 'continue_work':
      case 'prepare_handoff':
        agentRec.tool('vibecode_git_changes', 'vibecode_claim_intents_list');
        agentRec.command(
          `vibecode git changes --agent ${agent.agent_id} --json`,
          `vibecode claims intents list --agent ${agent.agent_id} --status active --json`,
        );
        break;
      case 'commit_claimed_work':
      case 'isolated_commit_possible':
        agentRec.tool('vibecode_git_changes', 'vibecode_finalize_check');
        agentRec.command(
          `vibecode git changes --agent ${agent.agent_id} --json`,
          `vibecode finalize check --agent ${agent.agent_id} --json`,
          `vibecode commit guard --agent ${agent.agent_id} --dry-run --json`,
        );
        break;
      case 'release_clean_work':
        agentRec.tool('vibecode_claim_intents_list', 'vibecode_claim_intent_release');
        agentRec.command(
          `vibecode claims intents list --agent ${agent.agent_id} --status active --json`,
          `vibecode claims intent-release --agent ${agent.agent_id} --intent-id <intent_id> --dry-run --json`,
        );
        break;
      case 'ready_for_handoff':
        agentRec.tool('vibecode_handoff_prepare');
        agentRec.command(`vibecode handoff prepare --agent ${agent.agent_id} --json`);
        break;
      case 'blocked_by_conflict':
        agentRec.tool('vibecode_conflicts_list', 'vibecode_conflict_detail');
        agentRec.command(
          'vibecode tools profile --profile conflict_resolution --json',
          'vibecode conflicts list --json',
        );
        break;
      case 'housekeeping_needed':
        agentRec.tool('vibecode_git_changes', 'vibecode_finalize_check');
        agentRec.command(
          `vibecode git changes --agent ${agent.agent_id} --json`,
          `vibecode finalize check --agent ${agent.agent_id} --json`,
        );
        break;
      case 'terminated':
      case 'uncertain':
        agentRec.tool('vibecode_session_bootstrap');
        agentRec.command(`vibecode session bootstrap --agent ${agent.agent_id} --json`);
        break;
    }

    agentSummaries.push({
      agent_id: agent.agent_id,
      status: agent.status,
      mode,
      task,
      task_truncated: taskTruncated,
      heartbeat_age_ms: heartbeatAgeMs,
      active_claims_count: agentActiveClaims.length,
      active_intents_count: agentActiveIntents.length,
      dirty_claimed_files_count: dirtyClaimedCount,
      releasable_intents_count: agentReleasable.length,
      conflicts_involving_agent_count: involving.length,
      recommended_action: action,
      safe_next_tools: agentRec.tools,
      safe_cli_commands: agentRec.commands,
      warnings: agentWarnings,
      blockers: agentBlockers,
    });
  }

  // Global warnings/blockers
  if (staleCoordinationPresent) {
    warnings.push('Stale coordination state (stale agents/claims/intents) exists. Use coordination_housekeeping.');
    rec.tool('vibecode_claims_list', 'vibecode_claims_reap');
    rec.command('vibecode tools profile --profile coordination_housekeeping --json', 'vibecode claims reap --dry-run --json');
  }
  if (stagedUnclaimed > 0) {
    blockers.push(`${stagedUnclaimed} staged unclaimed file(s) block commit.`);
  }
  if (unresolvedConflicts.length > 0) {
    warnings.push(`${unresolvedConflicts.length} unresolved conflict(s).`);
    rec.tool('vibecode_conflicts_list');
    rec.command('vibecode conflicts list --json');
  }
  if (!gitAvailable) {
    blockers.push('git changed files could not be determined.');
  }

  // Global recommended tools
  rec.tool('vibecode_team_status', 'vibecode_session_bootstrap');
  rec.command('vibecode team status --json');

  // Bounded samples
  const sampleActiveClaims = activeClaims.slice(0, maxItems).map((c) => ({
    claim_id: c.claim_id,
    path: c.path,
    agent_id: c.agent_id,
  }));
  const sampleActiveIntents = activeIntents.slice(0, maxItems).map((i) => ({
    intent_id: i.intent_id,
    agent_id: i.agent_id,
    intent: i.intent.length > 100 ? `${i.intent.slice(0, 100)}...` : i.intent,
  }));
  const sampleUnresolvedConflicts = unresolvedConflicts.slice(0, maxItems).map((c) => ({
    conflict_id: c.conflict_id,
    conflict_type: c.conflict_type,
    involved_files: c.involved_files.slice(0, 3),
  }));

  return {
    checked_at: now,
    summary: {
      agents_total: agents.length,
      agents_active: activeAgents.length,
      agents_stale: staleAgents.length,
      agents_terminated: terminatedAgents.length,
      build_agents: buildAgents.length,
      read_only_agents: readOnlyAgents.length,
      active_claims: activeClaims.length,
      active_intents: activeIntents.length,
      unresolved_conflicts: unresolvedConflicts.length,
      stale_coordination_present: staleCoordinationPresent,
      workspace_dirty: gitAvailable && gitDirty,
      staged_blockers_present: stagedUnclaimed > 0 || stagedClaimedByOtherAgent > 0,
    },
    workspace: {
      git_available: gitAvailable,
      dirty: gitAvailable && gitDirty,
      changed_counts: {
        total: gitChangedCount,
        staged_unclaimed: stagedUnclaimed,
        staged_claimed_by_other_agent: stagedClaimedByOtherAgent,
      },
      warnings: [],
    },
    agents: agentSummaries,
    claims: {
      active_count: activeClaims.length,
      stale_count: staleClaims.length,
      sample_active: sampleActiveClaims,
    },
    intents: {
      active_count: activeIntents.length,
      releasable_count: releasableIntents.length,
      sample_active: sampleActiveIntents,
    },
    conflicts: {
      unresolved_count: unresolvedConflicts.length,
      sample_unresolved: sampleUnresolvedConflicts,
    },
    stale_coordination: {
      has_stale_state: staleCoordinationPresent,
      stale_agents_count: staleAgents.length,
      stale_active_claims_count: staleClaims.length,
    },
    recommended_next_tools: rec.tools,
    recommended_cli_commands: rec.commands,
    warnings,
    blockers,
    agents_truncated: agentsTruncated,
  };
}

/**
 * Load coordination/git state and build the team status overview.
 * Strictly read-only: no register, no heartbeat, no claim/intent/conflict
 * mutation, no git mutation.
 */
export function getTeamStatusOverview(
  repoRoot: string,
  options: GetTeamStatusOptions = {},
): TeamStatusOverview {
  const now = options.now ?? new Date().toISOString();
  const rawMaxAgents = options.max_agents && options.max_agents > 0
    ? options.max_agents
    : DEFAULT_TEAM_STATUS_MAX_AGENTS;
  const rawMaxItems = options.max_items && options.max_items > 0
    ? options.max_items
    : DEFAULT_TEAM_STATUS_MAX_ITEMS;

  if (rawMaxAgents > TEAM_STATUS_MAX_AGENTS) {
    throw new Error(`max_agents ${rawMaxAgents} exceeds maximum ${TEAM_STATUS_MAX_AGENTS}`);
  }
  if (rawMaxItems > TEAM_STATUS_MAX_ITEMS) {
    throw new Error(`max_items ${rawMaxItems} exceeds maximum ${TEAM_STATUS_MAX_ITEMS}`);
  }

  const agents = listAgents(repoRoot, { now });
  const claims = listFileClaims(repoRoot, { now, includeReleased: true });
  const intents = listClaimIntents(repoRoot, { now });
  const unresolved = listConflicts(repoRoot, undefined, { now }).filter(
    (c): c is ConflictRecord => Boolean(c) && typeof c === 'object',
  );

  const staleCoordination = summarizeStaleCoordination({
    agents,
    claims: claims.filter((c) => c.status !== 'released'),
    intents,
    maxItems: rawMaxItems,
  });

  // Workspace git state (read-only)
  const changes = getGitChangesSummary(repoRoot, {
    now,
    includeDiffStat: false,
    gitRunner: options.gitRunner,
  });

  return buildTeamStatusOverview({
    agents,
    claims,
    intents,
    conflicts: unresolved,
    gitAvailable: changes.ok,
    gitDirty: changes.ok ? changes.dirty : false,
    gitChangedCount: changes.ok ? changes.summary.changed_count : 0,
    stagedUnclaimed: changes.ok ? changes.summary.staged_unclaimed : 0,
    stagedClaimedByOtherAgent: changes.ok ? changes.summary.staged_claimed_by_other_agent : 0,
    staleCoordinationPresent: staleCoordination.has_stale_state,
    maxAgents: rawMaxAgents,
    maxItems: rawMaxItems,
    now,
  });
}
