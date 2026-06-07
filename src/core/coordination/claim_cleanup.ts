/**
 * Phase 4D-cleanup: stale claim reaping.
 *
 * Releases claims owned by stale or terminated agents so future claim
 * attempts are not blocked by dead agents. Reaping marks claims as
 * released (never deletes them) and removes them from the owning agent's
 * active claim list.
 *
 * Hard rules:
 *   - The ONLY file ever written is `.vibecode/coordination/state.json`.
 *   - No source files, no git, no locks.
 *   - Active agents' claims are never reaped.
 *   - No auto-claim creation. No auto-conflict resolution.
 */

import { computeAgentStatus, HEARTBEAT_TTL_MS } from './heartbeat.js';
import { loadCoordinationState, writeCoordinationState } from './state.js';
import type { AgentSession, FileClaim } from './types.js';

export interface ReapStaleClaimsInput {
  repoRoot: string;
  now?: string;
  mode?: 'dry_run' | 'apply';
}

export interface CoordinationWarning {
  code: string;
  message: string;
}

export interface ReapStaleClaimsResult {
  ok: boolean;
  checked_at: string;
  mode: 'dry_run' | 'apply';
  stale_agents: AgentSession[];
  stale_claims: FileClaim[];
  reaped_claims: FileClaim[];
  warnings: CoordinationWarning[];
}

/**
 * Identify claims that are reapable: the owning agent is stale or terminated,
 * and the claim is still persisted as active (not already released).
 */
export function reapStaleClaims(
  input: ReapStaleClaimsInput,
): ReapStaleClaimsResult {
  const now = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const ttlMs = HEARTBEAT_TTL_MS;
  const mode = input.mode ?? 'apply';

  const state = loadCoordinationState(input.repoRoot, { now });

  const staleAgents: AgentSession[] = [];
  const staleAgentIds = new Set<string>();

  for (const agent of state.agents) {
    const status = computeAgentStatus(agent, nowMs, ttlMs);
    if (status === 'stale' || status === 'terminated') {
      staleAgents.push({ ...agent, status });
      staleAgentIds.add(agent.agent_id);
    }
  }

  const staleClaims: FileClaim[] = [];
  for (const claim of state.claims) {
    if (claim.status === 'released') continue;
    if (staleAgentIds.has(claim.agent_id)) {
      staleClaims.push(claim);
    }
  }

  if (mode === 'dry_run' || staleClaims.length === 0) {
    return {
      ok: true,
      checked_at: now,
      mode,
      stale_agents: staleAgents,
      stale_claims: staleClaims,
      reaped_claims: mode === 'dry_run' ? [] : [],
      warnings: [],
    };
  }

  // Apply: mark stale claims as released and remove from agent claim lists.
  const staleClaimIds = new Set(staleClaims.map((c) => c.claim_id));
  const updatedClaims = state.claims.map((claim) => {
    if (staleClaimIds.has(claim.claim_id)) {
      return {
        ...claim,
        status: 'released' as const,
        released_at: claim.released_at ?? now,
        metadata: {
          ...claim.metadata,
          reaped: true,
          reap_reason: 'stale_agent_reap',
          reaped_at: now,
        },
      };
    }
    return claim;
  });

  const updatedAgents = state.agents.map((agent) => {
    if (staleAgentIds.has(agent.agent_id)) {
      return {
        ...agent,
        claims: agent.claims.filter((id) => !staleClaimIds.has(id)),
      };
    }
    return agent;
  });

  writeCoordinationState(input.repoRoot, {
    ...state,
    last_updated: now,
    agents: updatedAgents,
    claims: updatedClaims,
  });

  const reapedClaims = staleClaims.map((claim) => ({
    ...claim,
    status: 'released' as const,
    released_at: claim.released_at ?? now,
    metadata: {
      ...claim.metadata,
      reaped: true,
      reap_reason: 'stale_agent_reap',
      reaped_at: now,
    },
  }));

  return {
    ok: true,
    checked_at: now,
    mode,
    stale_agents: staleAgents,
    stale_claims: staleClaims,
    reaped_claims: reapedClaims,
    warnings: [],
  };
}
