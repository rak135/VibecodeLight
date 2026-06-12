import {
  getAgentOperatingMode,
  type AgentOperatingMode,
} from '../coordination/agent_operating_mode.js';
import { listAgents } from '../coordination/agents.js';
import { listClaimIntents } from '../coordination/bulk_claims.js';
import { listFileClaims } from '../coordination/claims.js';
import { classifyChangedPath, pathsOverlap } from '../coordination/path_classification.js';
import { summarizeStaleCoordination } from '../coordination/stale_coordination.js';
import type { AgentSession, FileClaim } from '../coordination/types.js';
import {
  getTeamStatusOverview,
  type TeamStatusAction,
  type TeamStatusOverview,
} from '../agent_session/team_status.js';
import { getGitChangesSummary, GIT_CHANGES_MAX_FILES } from '../workspace/git_changes_summary.js';
import type { GitReadOnlyRunner } from '../workspace/git_status.js';
import { readMcpToolUsageLog, type McpUsageLogEvent } from './mcp_usage_log.js';

/**
 * Read-only activity observability overview (pure projection, no mutation).
 *
 * Composes the existing read-only services — agent registry, claims/intents,
 * team status classification, shared changed-path classification, stale
 * coordination summary, and the MCP tool-usage log — into one DTO for the
 * desktop GUI. It adds NO new coordination semantics and never writes.
 *
 * Truthfulness rules enforced here:
 *   - in a shared working tree Vibecode cannot prove which agent edited an
 *     unclaimed file, so unclaimed dirty files are WORKSPACE-level safety
 *     warnings only — they are never attributed to an agent;
 *   - usage events without agent_id stay unattributed;
 *   - a missing/malformed usage log or failing git degrades to warnings and
 *     conservative `unknown` values, never an exception;
 *   - every list is capped while the accompanying counts stay accurate.
 */

export const ACTIVITY_OVERVIEW_MAX_AGENTS = 20;
export const ACTIVITY_OVERVIEW_MAX_RECENT_TOOL_CALLS = 30;
export const ACTIVITY_OVERVIEW_MAX_CLAIMS = 50;
export const ACTIVITY_OVERVIEW_MAX_SAMPLE_PATHS = 5;

export interface ActivityOverviewNotice {
  code: string;
  message: string;
}

export type ActivityAgentStatus = 'active' | 'stale' | 'terminated' | 'unknown';

export type ActivityAgentReadyState =
  | 'read_only'
  | 'ready_to_claim'
  | 'working'
  | 'ready_to_commit'
  | 'blocked'
  | 'ready_to_release'
  | 'ready_for_handoff'
  | 'unknown';

export interface ActivityOverviewAgent {
  agent_id: string;
  name?: string;
  mode?: AgentOperatingMode;
  status: ActivityAgentStatus;
  last_activity_at?: string;
  last_mcp_tool_at?: string;
  last_mcp_tool_name?: string;
  mcp_tool_call_count: number;
  mcp_error_count: number;
  claimed_path_count: number;
  dirty_claimed_path_count: number;
  ready_state: ActivityAgentReadyState;
  blockers: ActivityOverviewNotice[];
  warnings: ActivityOverviewNotice[];
}

export interface ActivityOverviewToolCall {
  timestamp: string;
  agent_id?: string;
  tool_name: string;
  ok: boolean;
  duration_ms: number;
  error_code?: string;
}

export interface ActivityOverviewClaim {
  path: string;
  owner_agent_id: string;
  intent_id?: string;
  status: 'clean' | 'dirty' | 'stale' | 'unknown';
  age_seconds?: number;
}

export interface ActivityOverviewSafetyWarning extends ActivityOverviewNotice {
  sample_paths?: string[];
}

export interface ActivityOverviewWorkspaceSafety {
  unclaimed_dirty_count: number;
  staged_unclaimed_count: number;
  /** Dirty files under an active claim. Workspace perspective: any active claim. */
  foreign_claimed_dirty_count: number;
  generated_or_ignored_count: number;
  has_suspicious_unclaimed_dirty: boolean;
  safety_level: 'ok' | 'warning' | 'blocked';
  warnings: ActivityOverviewSafetyWarning[];
}

export interface ActivityOverviewStaleCoordination {
  has_stale_state: boolean;
  stale_agent_count: number;
  stale_claim_count: number;
  stale_intent_count: number;
  /** Explicit, safe CLI housekeeping commands only. */
  housekeeping_commands: string[];
}

export interface ActivityObservabilityOverview {
  generated_at: string;
  repo_root: string;
  agents: ActivityOverviewAgent[];
  recent_tool_calls: ActivityOverviewToolCall[];
  claims: ActivityOverviewClaim[];
  workspace_safety: ActivityOverviewWorkspaceSafety;
  stale_coordination: ActivityOverviewStaleCoordination;
  /** Accurate pre-cap counts for every capped list above. */
  totals: {
    agents: number;
    claims: number;
    tool_calls_in_window: number;
  };
  /** Degradation notices (missing usage log, git failure, capped lists, ...). */
  warnings: ActivityOverviewNotice[];
}

export interface GetActivityOverviewOptions {
  /** Clock seam (ISO-8601). */
  now?: string;
  /** Test seam: read-only git runner. */
  gitRunner?: GitReadOnlyRunner;
}

/** Map the team-status recommended action onto the GUI-facing ready state. */
function toReadyState(action: TeamStatusAction | undefined, mode: AgentOperatingMode | undefined): ActivityAgentReadyState {
  switch (action) {
    case 'observe_only':
      return 'read_only';
    case 'ready_to_claim':
      return 'ready_to_claim';
    case 'continue_work':
      return 'working';
    case 'commit_claimed_work':
    case 'isolated_commit_possible':
      return 'ready_to_commit';
    case 'release_clean_work':
      return 'ready_to_release';
    case 'blocked_by_conflict':
    case 'housekeeping_needed':
      return 'blocked';
    case 'heartbeat_needed':
    case 'terminated':
    case 'uncertain':
      return 'unknown';
    default:
      return mode === 'read_only' ? 'read_only' : 'unknown';
  }
}

function toAgentStatus(status: AgentSession['status']): ActivityAgentStatus {
  switch (status) {
    case 'active':
    case 'idle':
      return 'active';
    case 'stale':
      return 'stale';
    case 'terminated':
      return 'terminated';
    default:
      return 'unknown';
  }
}

interface AgentUsageStats {
  call_count: number;
  error_count: number;
  last_event?: McpUsageLogEvent;
}

function groupUsageByAgent(events: readonly McpUsageLogEvent[]): Map<string, AgentUsageStats> {
  const byAgent = new Map<string, AgentUsageStats>();
  for (const event of events) {
    if (!event.agent_id) continue;
    const stats = byAgent.get(event.agent_id) ?? { call_count: 0, error_count: 0 };
    stats.call_count += 1;
    if (!event.ok) stats.error_count += 1;
    stats.last_event = event;
    byAgent.set(event.agent_id, stats);
  }
  return byAgent;
}

function ageSeconds(createdAt: string, nowMs: number): number | undefined {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs) || Number.isNaN(nowMs)) return undefined;
  return Math.max(0, Math.floor((nowMs - createdMs) / 1000));
}

/**
 * Load everything and build the activity observability overview.
 * Strictly read-only; every degraded input becomes a warning, never a throw.
 */
export function getActivityObservabilityOverview(
  repoRoot: string,
  options: GetActivityOverviewOptions = {},
): ActivityObservabilityOverview {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const warnings: ActivityOverviewNotice[] = [];

  // --- MCP tool usage (tolerant bounded log read) ---
  const usage = readMcpToolUsageLog(repoRoot);
  if (!usage.log_found) {
    warnings.push({
      code: 'USAGE_LOG_MISSING',
      message: 'No MCP tool usage log found yet; tool activity appears after the first VibecodeMCP call.',
    });
  }
  if (usage.malformed_line_count > 0) {
    warnings.push({
      code: 'USAGE_LOG_MALFORMED_LINES',
      message: `${usage.malformed_line_count} usage log line(s) could not be parsed and were skipped.`,
    });
  }
  if (usage.window_truncated) {
    warnings.push({
      code: 'USAGE_LOG_WINDOW_TRUNCATED',
      message: 'Usage log is large; tool counts cover the most recent window only.',
    });
  }
  const usageByAgent = groupUsageByAgent(usage.events);

  // --- coordination state (read-only; corrupt state degrades to empty) ---
  let agents: AgentSession[] = [];
  let claims: FileClaim[] = [];
  let intents: ReturnType<typeof listClaimIntents> = [];
  try {
    agents = listAgents(repoRoot, { now });
    claims = listFileClaims(repoRoot, { now });
    intents = listClaimIntents(repoRoot, { now });
  } catch (err) {
    warnings.push({
      code: 'COORDINATION_STATE_UNAVAILABLE',
      message: `Coordination state could not be read: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  const activeClaims = claims.filter((c) => c.status === 'active');
  const staleClaims = claims.filter((c) => c.status !== 'active' && c.status !== 'released');

  // --- team status (per-agent readiness; same classification the CLI/MCP use) ---
  let team: TeamStatusOverview | null = null;
  try {
    team = getTeamStatusOverview(repoRoot, {
      now,
      max_agents: ACTIVITY_OVERVIEW_MAX_AGENTS,
      gitRunner: options.gitRunner,
    });
  } catch (err) {
    warnings.push({
      code: 'TEAM_STATUS_UNAVAILABLE',
      message: `Agent readiness could not be classified: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  const teamAgentById = new Map((team?.agents ?? []).map((a) => [a.agent_id, a] as const));

  // --- changed files (workspace perspective: agentId null) ---
  const changes = getGitChangesSummary(repoRoot, {
    now,
    includeDiffStat: false,
    maxFiles: GIT_CHANGES_MAX_FILES,
    gitRunner: options.gitRunner,
  });
  const gitAvailable = changes.ok;
  if (!gitAvailable) {
    warnings.push({
      code: 'GIT_CLASSIFICATION_UNAVAILABLE',
      message: 'git changed files could not be read; dirty/claim classification is unavailable.',
    });
  }
  if (gitAvailable && changes.truncated) {
    warnings.push({
      code: 'CHANGED_FILES_TRUNCATED',
      message: `Changed-file list truncated (${changes.returned_changed} of ${changes.total_changed}); safety counts are partial.`,
    });
  }

  const safety: ActivityOverviewWorkspaceSafety = {
    unclaimed_dirty_count: 0,
    staged_unclaimed_count: 0,
    foreign_claimed_dirty_count: 0,
    generated_or_ignored_count: gitAvailable ? changes.summary.generated_or_ignored : 0,
    has_suspicious_unclaimed_dirty: false,
    safety_level: 'ok',
    warnings: [],
  };
  const unclaimedSamples: string[] = [];
  const dirtyNonGeneratedPaths: { path: string; staged: boolean }[] = [];
  if (gitAvailable) {
    for (const file of changes.files) {
      const classified = classifyChangedPath({
        path: file.path,
        agentId: null,
        activeClaims,
        staleClaims,
      });
      if (classified.classification === 'generated_or_ignored') continue;
      dirtyNonGeneratedPaths.push({ path: file.path, staged: file.staged });
      if (classified.classification === 'unclaimed') {
        safety.unclaimed_dirty_count += 1;
        if (file.staged) safety.staged_unclaimed_count += 1;
        if (unclaimedSamples.length < ACTIVITY_OVERVIEW_MAX_SAMPLE_PATHS) unclaimedSamples.push(file.path);
      } else if (classified.classification === 'claimed_by_other_active_agent') {
        safety.foreign_claimed_dirty_count += 1;
      }
    }
  }
  safety.has_suspicious_unclaimed_dirty = safety.unclaimed_dirty_count > 0;
  safety.safety_level = safety.staged_unclaimed_count > 0
    ? 'blocked'
    : safety.unclaimed_dirty_count > 0 || !gitAvailable
    ? 'warning'
    : 'ok';
  if (safety.unclaimed_dirty_count > 0) {
    safety.warnings.push({
      code: 'UNCLAIMED_DIRTY_FILES',
      message: `${safety.unclaimed_dirty_count} dirty file(s) are not covered by any active claim. In a shared working tree Vibecode cannot attribute them to a specific agent — workspace-level warning only.`,
      sample_paths: unclaimedSamples,
    });
  }
  if (safety.staged_unclaimed_count > 0) {
    safety.warnings.push({
      code: 'STAGED_UNCLAIMED_FILES',
      message: `${safety.staged_unclaimed_count} staged unclaimed file(s) block every agent's commit guard.`,
    });
  }
  if (!gitAvailable) {
    safety.warnings.push({
      code: 'GIT_CLASSIFICATION_UNAVAILABLE',
      message: 'git state is unavailable; safety counts default to 0 and claim dirtiness is unknown.',
    });
  }

  // --- per-agent summaries (registered agents first, then log-only ids) ---
  const agentEntries: ActivityOverviewAgent[] = [];
  const registeredIds = new Set(agents.map((a) => a.agent_id));
  for (const session of agents.slice(0, ACTIVITY_OVERVIEW_MAX_AGENTS)) {
    const teamAgent = teamAgentById.get(session.agent_id);
    const stats = usageByAgent.get(session.agent_id);
    const mode = getAgentOperatingMode(session) ?? undefined;
    const ownedActiveClaims = activeClaims.filter((c) => c.agent_id === session.agent_id);
    const dirtyClaimedCount = teamAgent?.dirty_claimed_files_count
      ?? (gitAvailable
        ? ownedActiveClaims.filter((c) => dirtyNonGeneratedPaths.some((f) => pathsOverlap(c.path, f.path))).length
        : 0);
    agentEntries.push({
      agent_id: session.agent_id,
      name: session.agent_name,
      mode,
      status: toAgentStatus(session.status),
      last_activity_at: session.last_heartbeat_at,
      last_mcp_tool_at: stats?.last_event?.timestamp,
      last_mcp_tool_name: stats?.last_event?.tool_name,
      mcp_tool_call_count: stats?.call_count ?? 0,
      mcp_error_count: stats?.error_count ?? 0,
      claimed_path_count: ownedActiveClaims.length,
      dirty_claimed_path_count: dirtyClaimedCount,
      ready_state: toReadyState(teamAgent?.recommended_action, mode),
      blockers: (teamAgent?.blockers ?? []).map((n) => ({ code: n.code, message: n.message })),
      warnings: (teamAgent?.warnings ?? []).map((n) => ({ code: n.code, message: n.message })),
    });
  }
  // Agent ids seen only in the usage log (e.g. coordination state was cleaned):
  // shown honestly as unregistered, never given claims or readiness.
  for (const [agentId, stats] of usageByAgent) {
    if (registeredIds.has(agentId)) continue;
    if (agentEntries.length >= ACTIVITY_OVERVIEW_MAX_AGENTS) break;
    agentEntries.push({
      agent_id: agentId,
      mode: stats.last_event?.agent_mode,
      status: 'unknown',
      last_mcp_tool_at: stats.last_event?.timestamp,
      last_mcp_tool_name: stats.last_event?.tool_name,
      mcp_tool_call_count: stats.call_count,
      mcp_error_count: stats.error_count,
      claimed_path_count: 0,
      dirty_claimed_path_count: 0,
      ready_state: 'unknown',
      blockers: [],
      warnings: [{
        code: 'AGENT_NOT_REGISTERED',
        message: 'This agent id appears in the MCP usage log but has no registered coordination session.',
      }],
    });
  }
  const totalAgents = registeredIds.size
    + [...usageByAgent.keys()].filter((id) => !registeredIds.has(id)).length;
  if (totalAgents > agentEntries.length) {
    warnings.push({
      code: 'AGENTS_TRUNCATED',
      message: `Agent list capped at ${ACTIVITY_OVERVIEW_MAX_AGENTS} of ${totalAgents}.`,
    });
  }

  // --- recent tool calls (most recent first, capped) ---
  const recentToolCalls: ActivityOverviewToolCall[] = usage.events
    .slice(-ACTIVITY_OVERVIEW_MAX_RECENT_TOOL_CALLS)
    .reverse()
    .map((event) => ({
      timestamp: event.timestamp,
      ...(event.agent_id !== undefined ? { agent_id: event.agent_id } : {}),
      tool_name: event.tool_name,
      ok: event.ok,
      duration_ms: event.duration_ms,
      ...(event.error_code !== undefined ? { error_code: event.error_code } : {}),
    }));

  // --- claims (active + stale; released claims are history, not state) ---
  const claimEntries: ActivityOverviewClaim[] = claims
    .slice(0, ACTIVITY_OVERVIEW_MAX_CLAIMS)
    .map((claim) => {
      const intentId = (claim.metadata as Record<string, unknown> | undefined)?.intent_id;
      const status: ActivityOverviewClaim['status'] = claim.status !== 'active'
        ? 'stale'
        : !gitAvailable
        ? 'unknown'
        : dirtyNonGeneratedPaths.some((f) => pathsOverlap(claim.path, f.path))
        ? 'dirty'
        : 'clean';
      const age = ageSeconds(claim.created_at, nowMs);
      return {
        path: claim.path,
        owner_agent_id: claim.agent_id,
        ...(typeof intentId === 'string' ? { intent_id: intentId } : {}),
        status,
        ...(age !== undefined ? { age_seconds: age } : {}),
      };
    });
  if (claims.length > claimEntries.length) {
    warnings.push({
      code: 'CLAIMS_TRUNCATED',
      message: `Claim list capped at ${ACTIVITY_OVERVIEW_MAX_CLAIMS} of ${claims.length}.`,
    });
  }

  // --- stale coordination (counts + safe housekeeping commands only) ---
  const stale = summarizeStaleCoordination({ agents, claims, intents });

  return {
    generated_at: now,
    repo_root: repoRoot,
    agents: agentEntries,
    recent_tool_calls: recentToolCalls,
    claims: claimEntries,
    workspace_safety: safety,
    stale_coordination: {
      has_stale_state: stale.has_stale_state,
      stale_agent_count: stale.stale_agents_count,
      stale_claim_count: stale.stale_active_claims_count,
      stale_intent_count:
        stale.active_intents_owned_by_stale_agents_count
        + stale.active_intents_owned_by_terminated_agents_count
        + stale.active_intents_owned_by_missing_agents_count
        + stale.active_intents_with_no_active_claims_count,
      housekeeping_commands: stale.recommended_cli_commands,
    },
    totals: {
      agents: totalAgents,
      claims: claims.length,
      tool_calls_in_window: usage.events.length,
    },
    warnings,
  };
}
