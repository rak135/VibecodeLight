import type { AgentSession, ClaimIntent, FileClaim } from './types.js';

/**
 * Phase 2C — stale coordination visibility (read-only).
 *
 * Long sessions go stale, old agents leave claims behind, and active work
 * intents can end up owned by stale/terminated/missing agents. This module
 * SURFACES that state and recommends the existing explicit cleanup commands —
 * it never cleans anything up itself.
 *
 * Hard rules:
 *   - pure functions over already-loaded coordination data; no filesystem
 *     reads, no git, no scanner, no writes;
 *   - bounded samples (callers pass maxItems); counts are computed over the
 *     FULL inputs, never over capped samples;
 *   - no auto-release, no auto-reap, no force release, no ownership transfer —
 *     recommendations point at `claims list` / `claims reap --dry-run` /
 *     `agents heartbeat` only;
 *   - never implies one agent may release another agent's active intent
 *     (intent release stays same-agent only).
 */

/** Lifecycle status of an intent's owning agent, for visibility output. */
export type IntentOwnerStatus = 'active' | 'stale' | 'terminated' | 'missing';

/**
 * Map an owning agent's computed (stale-aware) session status onto the
 * intent-owner visibility status. `undefined` (no such agent in state) is
 * `missing`; an unparseable-heartbeat `unknown` agent is treated as `stale`
 * (suspect, but present).
 */
export function computeIntentOwnerStatus(
  agentsById: ReadonlyMap<string, AgentSession>,
  agentId: string,
): IntentOwnerStatus {
  const agent = agentsById.get(agentId);
  if (!agent) return 'missing';
  switch (agent.status) {
    case 'active':
    case 'idle':
      return 'active';
    case 'terminated':
      return 'terminated';
    default:
      // 'stale' and 'unknown' are both surfaced as stale-owned.
      return 'stale';
  }
}

/** Bounded sample of one stale agent. */
export interface StaleAgentSample {
  agent_id: string;
  agent_name: string;
  agent_type: string;
  last_heartbeat_at: string;
}

/** Bounded sample of one stale (persisted-active, dead-owner) claim. */
export interface StaleClaimSample {
  claim_id: string;
  path: string;
  agent_id: string;
}

/** Bounded sample of one active intent with a stale/terminated/missing owner. */
export interface StaleIntentSample {
  intent_id: string;
  agent_id: string;
  owner_status: IntentOwnerStatus;
  intent: string;
  active_claim_count: number;
}

/** Bounded sample of one active intent that has zero active claims left. */
export interface NoActiveClaimIntentSample {
  intent_id: string;
  agent_id: string;
  intent: string;
}

/** Compact, bounded stale-coordination summary for orientation output. */
export interface StaleCoordinationSummary {
  /** True when any stale coordination state exists (any count below > 0). */
  has_stale_state: boolean;
  stale_agents_count: number;
  /** Claims persisted active whose owner is stale/terminated (computed claim status `stale`). */
  stale_active_claims_count: number;
  active_intents_owned_by_stale_agents_count: number;
  active_intents_owned_by_terminated_agents_count: number;
  active_intents_owned_by_missing_agents_count: number;
  active_intents_with_no_active_claims_count: number;
  samples: {
    stale_agents: StaleAgentSample[];
    stale_claims: StaleClaimSample[];
    stale_intents: StaleIntentSample[];
    intents_with_no_active_claims: NoActiveClaimIntentSample[];
  };
  /** True when any sample list was capped below its full count. */
  samples_truncated: boolean;
  /** Explicit housekeeping commands. Never a cross-agent intent release. */
  recommended_cli_commands: string[];
}

export interface StaleCoordinationInput {
  /** All agents with COMPUTED (stale-aware) statuses. */
  agents: readonly AgentSession[];
  /** All claims with COMPUTED statuses (stale overlaid for dead owners). */
  claims: readonly FileClaim[];
  /** All work intents. */
  intents: readonly ClaimIntent[];
  /** The current agent id, when registered — enables the heartbeat recommendation. */
  currentAgentId?: string | null;
  /** Cap on each sample list. */
  maxItems?: number;
}

/** Default cap on each stale-coordination sample list. */
export const DEFAULT_STALE_SAMPLE_ITEMS = 10;

/**
 * Build the bounded stale-coordination summary. Read-only and pure: surfaces
 * stale agents/claims and odd-but-safe intent ownership, with explicit (never
 * automatic) cleanup recommendations.
 */
export function summarizeStaleCoordination(input: StaleCoordinationInput): StaleCoordinationSummary {
  const maxItems = input.maxItems && input.maxItems > 0 ? input.maxItems : DEFAULT_STALE_SAMPLE_ITEMS;
  const agentsById = new Map(input.agents.map((a) => [a.agent_id, a] as const));

  const staleAgents = input.agents.filter((a) => a.status === 'stale' || a.status === 'unknown');
  const staleClaims = input.claims.filter((c) => c.status === 'stale');

  const activeIntents = input.intents.filter((i) => i.status === 'active');
  const activeClaimIds = new Set(
    input.claims.filter((c) => c.status === 'active').map((c) => c.claim_id),
  );

  const staleOwned: StaleIntentSample[] = [];
  let staleOwnedCount = 0;
  let terminatedOwnedCount = 0;
  let missingOwnedCount = 0;
  const noActiveClaims: NoActiveClaimIntentSample[] = [];
  let noActiveClaimsCount = 0;

  for (const intent of activeIntents) {
    const ownerStatus = computeIntentOwnerStatus(agentsById, intent.agent_id);
    const activeCount = intent.claim_ids.filter((id) => activeClaimIds.has(id)).length;
    if (ownerStatus !== 'active') {
      if (ownerStatus === 'stale') staleOwnedCount += 1;
      else if (ownerStatus === 'terminated') terminatedOwnedCount += 1;
      else missingOwnedCount += 1;
      if (staleOwned.length < maxItems) {
        staleOwned.push({
          intent_id: intent.intent_id,
          agent_id: intent.agent_id,
          owner_status: ownerStatus,
          intent: intent.intent,
          active_claim_count: activeCount,
        });
      }
    }
    if (activeCount === 0) {
      noActiveClaimsCount += 1;
      if (noActiveClaims.length < maxItems) {
        noActiveClaims.push({
          intent_id: intent.intent_id,
          agent_id: intent.agent_id,
          intent: intent.intent,
        });
      }
    }
  }

  const hasStaleState =
    staleAgents.length > 0 ||
    staleClaims.length > 0 ||
    staleOwnedCount + terminatedOwnedCount + missingOwnedCount > 0 ||
    noActiveClaimsCount > 0;

  const recommended: string[] = [];
  if (hasStaleState) {
    recommended.push('vibecode claims list --json', 'vibecode claims reap --dry-run --json');
    if (input.currentAgentId) {
      recommended.push(`vibecode agents heartbeat --agent ${input.currentAgentId} --json`);
      recommended.push(`vibecode claims intents list --agent ${input.currentAgentId} --status active --json`);
    }
  }

  const staleAgentSamples = staleAgents.slice(0, maxItems).map((a) => ({
    agent_id: a.agent_id,
    agent_name: a.agent_name,
    agent_type: a.agent_type,
    last_heartbeat_at: a.last_heartbeat_at,
  }));
  const staleClaimSamples = staleClaims.slice(0, maxItems).map((c) => ({
    claim_id: c.claim_id,
    path: c.path,
    agent_id: c.agent_id,
  }));

  return {
    has_stale_state: hasStaleState,
    stale_agents_count: staleAgents.length,
    stale_active_claims_count: staleClaims.length,
    active_intents_owned_by_stale_agents_count: staleOwnedCount,
    active_intents_owned_by_terminated_agents_count: terminatedOwnedCount,
    active_intents_owned_by_missing_agents_count: missingOwnedCount,
    active_intents_with_no_active_claims_count: noActiveClaimsCount,
    samples: {
      stale_agents: staleAgentSamples,
      stale_claims: staleClaimSamples,
      stale_intents: staleOwned,
      intents_with_no_active_claims: noActiveClaims,
    },
    samples_truncated:
      staleAgentSamples.length < staleAgents.length ||
      staleClaimSamples.length < staleClaims.length ||
      staleOwned.length < staleOwnedCount + terminatedOwnedCount + missingOwnedCount ||
      noActiveClaims.length < noActiveClaimsCount,
    recommended_cli_commands: recommended,
  };
}
