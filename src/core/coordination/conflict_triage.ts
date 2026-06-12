/**
 * Phase 2D — intent-aware conflict triage (read-only).
 *
 * Enriches raw conflict records with claim, intent, and owner lifecycle context
 * so agents can answer: what caused the conflict, who owns the blocker, is the
 * blocker still active, and what safe commands should I run next?
 *
 * Hard rules:
 *   - pure functions over already-loaded coordination data; no filesystem reads,
 *     no git, no scanner, no writes;
 *   - bounded output; sample paths capped;
 *   - no auto-resolve, no auto-release, no force release, no ownership transfer;
 *   - handles missing/malformed conflict records gracefully;
 *   - recommendations point at real MCP tools and CLI commands only.
 */

import { computeAgentStatus, HEARTBEAT_TTL_MS } from './heartbeat.js';
import type { AgentSession, ClaimIntent, FileClaim } from './types.js';
import type { ConflictRecord } from './conflicts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a conflict's requesting or blocking agent. */
export type ConflictAgentStatus = 'active' | 'stale' | 'terminated' | 'missing';

/** Lifecycle status of the blocking intent, when known. */
export type ConflictIntentStatus = 'active' | 'released' | 'missing';

/** Computed triage status of a conflict. */
export type ConflictTriageStatus =
  | 'unresolved'
  | 'resolved'
  | 'cleared'
  | 'stale_blocking'
  | 'still_blocking'
  | 'inconsistent_state';

/** Advisory warning codes surfaced by triage. */
export type ConflictWarningCode =
  | 'CONFLICT_OWNER_STALE'
  | 'CONFLICT_OWNER_TERMINATED'
  | 'CONFLICT_OWNER_MISSING'
  | 'CONFLICT_BLOCKING_CLAIM_RELEASED'
  | 'CONFLICT_BLOCKING_INTENT_RELEASED'
  | 'CONFLICT_REFERENCES_MISSING_CLAIM'
  | 'CONFLICT_REFERENCES_MISSING_AGENT'
  | 'CONFLICT_STILL_BLOCKING'
  | 'CONFLICT_NO_LONGER_BLOCKING';

/** Bounded sample of one blocking claim. */
export interface ConflictTriageBlockingClaim {
  claim_id: string;
  path: string;
  agent_id: string;
  mode: string;
  status: string;
}

/** Intent context for the blocking side, when derivable. */
export interface ConflictTriageBlockingIntent {
  intent_id: string;
  intent: string;
  status: string;
}

/** Full triage detail for one conflict. */
export interface ConflictTriageDetail {
  conflict_id: string;
  conflict_type: string;
  triage_status: ConflictTriageStatus;
  stored_status: string;
  created_at: string;
  updated_at: string | null;
  resolved_at: string | null;
  involved_files: string[];
  requesting_agent_id: string | null;
  requesting_agent_status: ConflictAgentStatus;
  blocking_agent_id: string | null;
  blocking_agent_status: ConflictAgentStatus;
  blocking_claims: ConflictTriageBlockingClaim[];
  blocking_intent: ConflictTriageBlockingIntent | null;
  blocking_claim_released: boolean;
  still_actively_blocking: boolean;
  warning_codes: ConflictWarningCode[];
  recommended_next_tools: string[];
  recommended_cli_commands: string[];
}

/** Compact triage summary for list output (bounded). */
export interface ConflictTriageSummary {
  conflict_id: string;
  conflict_type: string;
  triage_status: ConflictTriageStatus;
  stored_status: string;
  created_at: string;
  involved_files: string[];
  requesting_agent_id: string | null;
  requesting_agent_status: ConflictAgentStatus;
  blocking_agent_id: string | null;
  blocking_agent_status: ConflictAgentStatus;
  blocking_intent_id: string | null;
  blocking_claim_released: boolean;
  still_actively_blocking: boolean;
  warning_codes: ConflictWarningCode[];
}

/** Filter for conflict triage listing. */
export interface ConflictTriageFilter {
  status?: 'detected' | 'resolved' | 'all';
  agent_id?: string;
  conflict_id?: string;
  max_items?: number;
}

/** Result of a conflict triage list. */
export interface ConflictTriageListResult {
  conflicts: ConflictTriageSummary[];
  total: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce a possibly-missing/malformed value into a string array. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

/**
 * Normalize a conflict record so triage never crashes on legacy/malformed
 * records: state.json normalization guarantees `conflicts` is an array but
 * trusts element shape, so the involved_* arrays may be absent.
 */
function normalizeConflictRecord(conflict: ConflictRecord): ConflictRecord {
  return {
    ...conflict,
    involved_claims: asStringArray(conflict.involved_claims),
    involved_agents: asStringArray(conflict.involved_agents),
    involved_files: asStringArray(conflict.involved_files),
  };
}

/** Safe lookup: find an agent by id, returning undefined if missing. */
function findAgent(
  agents: readonly AgentSession[],
  agentId: string,
): AgentSession | undefined {
  return agents.find((a) => a.agent_id === agentId);
}

/** Compute the lifecycle status of an agent referenced by a conflict. */
function computeConflictAgentStatus(
  agents: readonly AgentSession[],
  agentId: string | null | undefined,
  nowMs: number,
  ttlMs: number,
): ConflictAgentStatus {
  if (!agentId) return 'missing';
  const agent = findAgent(agents, agentId);
  if (!agent) return 'missing';
  const status = computeAgentStatus(agent, nowMs, ttlMs);
  if (status === 'active' || status === 'idle') return 'active';
  if (status === 'terminated') return 'terminated';
  return 'stale';
}

/** Determine whether a blocking claim is still active (not released, owner not stale). */
function isBlockingClaimActive(
  claims: readonly FileClaim[],
  agents: readonly AgentSession[],
  claimId: string,
  nowMs: number,
  ttlMs: number,
): boolean {
  const claim = claims.find((c) => c.claim_id === claimId);
  if (!claim) return false;
  if (claim.status === 'released') return false;
  // Compute the owner's agent status to determine if the claim is stale.
  const owner = agents.find((a) => a.agent_id === claim.agent_id);
  if (!owner) return false; // missing owner → claim is not actively blocking
  const agentStatus = computeAgentStatus(owner, nowMs, ttlMs);
  return agentStatus === 'active' || agentStatus === 'idle';
}

/** Find the intent that owns a given claim id. */
function findIntentForClaim(
  intents: readonly ClaimIntent[],
  claimId: string,
): ClaimIntent | null {
  return intents.find((i) => i.claim_ids.includes(claimId)) ?? null;
}

/** Derive the requesting agent from a conflict's evidence/details. */
function deriveRequestingAgent(
  conflict: ConflictRecord,
  blockingAgentIds: ReadonlySet<string>,
): string | null {
  // The requesting agent is the one in involved_agents that is NOT a blocker.
  for (const agentId of conflict.involved_agents) {
    if (!blockingAgentIds.has(agentId)) return agentId;
  }
  // Fallback: if only one agent, it's the requester (self-conflict).
  if (conflict.involved_agents.length === 1) return conflict.involved_agents[0];
  return null;
}

/** Derive blocking agent ids from the conflict's involved claims. */
function deriveBlockingAgents(
  claims: readonly FileClaim[],
  conflict: ConflictRecord,
): Set<string> {
  const blocking = new Set<string>();
  for (const claimId of conflict.involved_claims) {
    const claim = claims.find((c) => c.claim_id === claimId);
    if (claim) blocking.add(claim.agent_id);
  }
  return blocking;
}

/** Build blocking claim details. */
function buildBlockingClaims(
  claims: readonly FileClaim[],
  conflict: ConflictRecord,
): ConflictTriageBlockingClaim[] {
  const result: ConflictTriageBlockingClaim[] = [];
  for (const claimId of conflict.involved_claims) {
    const claim = claims.find((c) => c.claim_id === claimId);
    if (claim) {
      result.push({
        claim_id: claim.claim_id,
        path: claim.path,
        agent_id: claim.agent_id,
        mode: claim.mode,
        status: claim.status,
      });
    }
  }
  return result;
}

/** Derive blocking intent from the first blocking claim. */
function deriveBlockingIntent(
  claims: readonly FileClaim[],
  intents: readonly ClaimIntent[],
  conflict: ConflictRecord,
): ConflictTriageBlockingIntent | null {
  for (const claimId of conflict.involved_claims) {
    const intent = findIntentForClaim(intents, claimId);
    if (intent) {
      return {
        intent_id: intent.intent_id,
        intent: intent.intent.length > 200 ? `${intent.intent.slice(0, 200)}...` : intent.intent,
        status: intent.status,
      };
    }
  }
  return null;
}

/** Compute the triage status of a conflict. */
function computeTriageStatus(args: {
  conflict: ConflictRecord;
  blockingAgentStatus: ConflictAgentStatus;
  blockingClaimReleased: boolean;
  stillActivelyBlocking: boolean;
}): ConflictTriageStatus {
  if (args.conflict.status === 'resolved') return 'resolved';
  if (args.blockingClaimReleased) return 'cleared';
  if (args.blockingAgentStatus === 'missing' && args.conflict.involved_claims.length > 0) {
    return 'inconsistent_state';
  }
  if (args.stillActivelyBlocking) return 'still_blocking';
  if (args.blockingAgentStatus === 'stale' || args.blockingAgentStatus === 'terminated') {
    return 'stale_blocking';
  }
  return 'unresolved';
}

/** Compute warning codes for a conflict. */
function computeWarningCodes(args: {
  conflict: ConflictRecord;
  requestingAgentStatus: ConflictAgentStatus;
  blockingAgentStatus: ConflictAgentStatus;
  blockingClaimReleased: boolean;
  stillActivelyBlocking: boolean;
  blockingIntent: ConflictTriageBlockingIntent | null;
  missingClaimCount: number;
  missingAgentCount: number;
}): ConflictWarningCode[] {
  const codes: ConflictWarningCode[] = [];

  if (args.blockingAgentStatus === 'stale') codes.push('CONFLICT_OWNER_STALE');
  if (args.blockingAgentStatus === 'terminated') codes.push('CONFLICT_OWNER_TERMINATED');
  if (args.blockingAgentStatus === 'missing') codes.push('CONFLICT_OWNER_MISSING');
  if (args.blockingClaimReleased) codes.push('CONFLICT_BLOCKING_CLAIM_RELEASED');
  if (args.blockingIntent && args.blockingIntent.status === 'released') {
    codes.push('CONFLICT_BLOCKING_INTENT_RELEASED');
  }
  if (args.missingClaimCount > 0) codes.push('CONFLICT_REFERENCES_MISSING_CLAIM');
  if (args.missingAgentCount > 0) codes.push('CONFLICT_REFERENCES_MISSING_AGENT');
  if (args.stillActivelyBlocking) codes.push('CONFLICT_STILL_BLOCKING');
  if (!args.stillActivelyBlocking && args.conflict.status === 'detected') {
    codes.push('CONFLICT_NO_LONGER_BLOCKING');
  }

  return codes;
}

/** Build recommended next tools for a conflict triage detail. */
function buildRecommendedNextTools(args: {
  triageStatus: ConflictTriageStatus;
  blockingAgentStatus: ConflictAgentStatus;
  isOwnConflict: boolean;
}): string[] {
  const tools: string[] = ['vibecode_workspace_snapshot', 'vibecode_build_scope'];

  if (args.triageStatus === 'still_blocking' || args.triageStatus === 'unresolved') {
    tools.push('vibecode_session_start', 'vibecode_changes');
    if (args.blockingAgentStatus === 'stale' || args.blockingAgentStatus === 'terminated') {
      tools.push('vibecode_build_scope');
    }
  }
  if (args.triageStatus === 'cleared' || args.triageStatus === 'stale_blocking') {
    tools.push('vibecode_build_start');
  }
  if (args.isOwnConflict && args.triageStatus === 'cleared') {
    tools.push('vibecode_build_scope');
  }

  return [...new Set(tools)];
}

/** Build recommended CLI commands for a conflict triage detail. */
function buildRecommendedCliCommands(args: {
  triageStatus: ConflictTriageStatus;
  blockingAgentStatus: ConflictAgentStatus;
  conflictId: string;
  isOwnConflict: boolean;
  currentAgentId: string | null;
}): string[] {
  const commands: string[] = [
    'vibecode conflicts list --json',
    'vibecode claims list --json',
  ];

  if (args.triageStatus === 'still_blocking' || args.triageStatus === 'unresolved') {
    commands.push(`vibecode conflicts detail --conflict-id ${args.conflictId} --json`);
    if (args.blockingAgentStatus === 'stale' || args.blockingAgentStatus === 'terminated') {
      commands.push('vibecode claims reap --dry-run --json');
      commands.push('vibecode tools profile --profile coordination_housekeeping --json');
    } else {
      commands.push('vibecode tools profile --profile conflict_resolution --json');
    }
  }
  if (args.triageStatus === 'cleared' || args.triageStatus === 'stale_blocking') {
    if (args.currentAgentId) {
      commands.push(
        `vibecode claims plan --agent ${args.currentAgentId} --path <path> --json`,
      );
    }
  }

  return [...new Set(commands)];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a full triage detail for one conflict. Read-only, pure over the
 * supplied coordination data. Returns null when the conflict_id is not found.
 */
export function triageConflict(args: {
  conflict: ConflictRecord;
  agents: readonly AgentSession[];
  claims: readonly FileClaim[];
  intents: readonly ClaimIntent[];
  currentAgentId?: string | null;
  now?: string;
}): ConflictTriageDetail {
  const now = args.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const ttlMs = HEARTBEAT_TTL_MS;

  const conflict = normalizeConflictRecord(args.conflict);
  const blockingAgentIds = deriveBlockingAgents(args.claims, conflict);
  const requestingAgentId = deriveRequestingAgent(conflict, blockingAgentIds);

  const blockingAgentId = blockingAgentIds.size === 1
    ? [...blockingAgentIds][0]
    : blockingAgentIds.size > 1
      ? [...blockingAgentIds][0] // primary blocker (first)
      : null;

  const requestingAgentStatus = computeConflictAgentStatus(args.agents, requestingAgentId, nowMs, ttlMs);
  const blockingAgentStatus = computeConflictAgentStatus(args.agents, blockingAgentId, nowMs, ttlMs);

  const blockingClaims = buildBlockingClaims(args.claims, conflict);
  const allBlockingReleased = blockingClaims.length > 0 && blockingClaims.every((c) => c.status === 'released');
  // Check if any blocking claim is actively blocking (not released AND owner is active).
  const anyBlockingActive = conflict.involved_claims.some(
    (claimId) => isBlockingClaimActive(args.claims, args.agents, claimId, nowMs, ttlMs),
  );

  // Check if any involved claims are missing from state.
  const claimIdsInState = new Set(args.claims.map((c) => c.claim_id));
  const missingClaimCount = conflict.involved_claims.filter((id) => !claimIdsInState.has(id)).length;

  // Check if any involved agents are missing from state.
  const agentIdsInState = new Set(args.agents.map((a) => a.agent_id));
  const missingAgentCount = conflict.involved_agents.filter((id) => !agentIdsInState.has(id)).length;

  const blockingIntent = deriveBlockingIntent(args.claims, args.intents, conflict);

  const stillActivelyBlocking = conflict.status === 'detected' && anyBlockingActive;

  const triageStatus = computeTriageStatus({
    conflict,
    blockingAgentStatus,
    blockingClaimReleased: allBlockingReleased,
    stillActivelyBlocking,
  });

  const warningCodes = computeWarningCodes({
    conflict,
    requestingAgentStatus,
    blockingAgentStatus,
    blockingClaimReleased: allBlockingReleased,
    stillActivelyBlocking,
    blockingIntent,
    missingClaimCount,
    missingAgentCount,
  });

  const isOwnConflict = args.currentAgentId != null && conflict.involved_agents.includes(args.currentAgentId);

  return {
    conflict_id: conflict.conflict_id,
    conflict_type: conflict.conflict_type,
    triage_status: triageStatus,
    stored_status: conflict.status,
    created_at: conflict.detected_at,
    updated_at: conflict.resolved_at ?? null,
    resolved_at: conflict.resolved_at ?? null,
    involved_files: conflict.involved_files,
    requesting_agent_id: requestingAgentId,
    requesting_agent_status: requestingAgentStatus,
    blocking_agent_id: blockingAgentId,
    blocking_agent_status: blockingAgentStatus,
    blocking_claims: blockingClaims,
    blocking_intent: blockingIntent,
    blocking_claim_released: allBlockingReleased,
    still_actively_blocking: stillActivelyBlocking,
    warning_codes: warningCodes,
    recommended_next_tools: buildRecommendedNextTools({
      triageStatus,
      blockingAgentStatus,
      isOwnConflict,
    }),
    recommended_cli_commands: buildRecommendedCliCommands({
      triageStatus,
      blockingAgentStatus,
      conflictId: conflict.conflict_id,
      isOwnConflict,
      currentAgentId: args.currentAgentId ?? null,
    }),
  };
}

/**
 * Build a compact triage summary for list output. Same enrichment as
 * {@link triageConflict} but without blocking-claim detail or recommendations.
 */
export function summarizeConflictTriage(args: {
  conflict: ConflictRecord;
  agents: readonly AgentSession[];
  claims: readonly FileClaim[];
  intents: readonly ClaimIntent[];
  currentAgentId?: string | null;
  now?: string;
}): ConflictTriageSummary {
  const detail = triageConflict(args);
  return {
    conflict_id: detail.conflict_id,
    conflict_type: detail.conflict_type,
    triage_status: detail.triage_status,
    stored_status: detail.stored_status,
    created_at: detail.created_at,
    involved_files: detail.involved_files,
    requesting_agent_id: detail.requesting_agent_id,
    requesting_agent_status: detail.requesting_agent_status,
    blocking_agent_id: detail.blocking_agent_id,
    blocking_agent_status: detail.blocking_agent_status,
    blocking_intent_id: detail.blocking_intent?.intent_id ?? null,
    blocking_claim_released: detail.blocking_claim_released,
    still_actively_blocking: detail.still_actively_blocking,
    warning_codes: detail.warning_codes,
  };
}

/**
 * List conflicts with triage enrichment. Read-only.
 */
export function listConflictTriages(args: {
  agents: readonly AgentSession[];
  claims: readonly FileClaim[];
  intents: readonly ClaimIntent[];
  conflicts: readonly ConflictRecord[];
  filter?: ConflictTriageFilter;
  currentAgentId?: string | null;
  now?: string;
}): ConflictTriageListResult {
  const filter = args.filter;
  let conflicts = [...args.conflicts];

  // Apply filters.
  if (filter?.status && filter.status !== 'all') {
    conflicts = conflicts.filter((c) => c.status === filter.status);
  }
  if (filter?.agent_id) {
    const agentId = filter.agent_id;
    conflicts = conflicts.filter((c) => c.involved_agents.includes(agentId));
  }
  if (filter?.conflict_id) {
    conflicts = conflicts.filter((c) => c.conflict_id === filter.conflict_id);
  }

  const total = conflicts.length;
  const maxItems = filter?.max_items && filter.max_items > 0 ? filter.max_items : Number.POSITIVE_INFINITY;
  const truncated = conflicts.length > maxItems;
  const bounded = conflicts.slice(0, maxItems);

  const summaries = bounded.map((conflict) =>
    summarizeConflictTriage({
      conflict,
      agents: args.agents,
      claims: args.claims,
      intents: args.intents,
      currentAgentId: args.currentAgentId,
      now: args.now,
    }),
  );

  return { conflicts: summaries, total, truncated };
}

/**
 * Find one conflict by id and build its full triage detail. Returns null when
 * the conflict is not found.
 */
export function getConflictTriageDetail(args: {
  conflictId: string;
  agents: readonly AgentSession[];
  claims: readonly FileClaim[];
  intents: readonly ClaimIntent[];
  conflicts: readonly ConflictRecord[];
  currentAgentId?: string | null;
  now?: string;
}): ConflictTriageDetail | null {
  const conflict = args.conflicts.find((c) => c.conflict_id === args.conflictId);
  if (!conflict) return null;

  return triageConflict({
    conflict,
    agents: args.agents,
    claims: args.claims,
    intents: args.intents,
    currentAgentId: args.currentAgentId,
    now: args.now,
  });
}
