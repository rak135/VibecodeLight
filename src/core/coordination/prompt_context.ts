import { listAgents } from './agents.js';
import { listFileClaims } from './claims.js';
import type { AgentBinding, AgentMode } from './agent_binding.js';
import type { ClaimMode } from './types.js';

/**
 * Phase 3B coordination prompt context.
 *
 * This is the read-only data layer between live coordination state and the
 * prompt renderer. Given a run's {@link AgentBinding}, it resolves the current
 * agent identity and computes the active claims that matter for the prompt:
 *   - claims held by the bound agent, and
 *   - active claims held by OTHER agents (off-limits to edit).
 *
 * Stale agents and released claims are excluded automatically via the shared
 * claim status computation. This module never writes to disk and never mutates
 * coordination state.
 */

/** A claim held by the bound agent. */
export interface CoordinationHeldClaim {
  claim_id: string;
  path: string;
  mode: ClaimMode;
}

/** An active claim held by another agent (off-limits for the bound agent). */
export interface CoordinationOtherClaim {
  claim_id: string;
  path: string;
  mode: ClaimMode;
  agent_id: string;
  agent_name: string;
}

/** Structured, deterministic input for the coordination prompt section. */
export interface CoordinationPromptContext {
  agent_id: string | null;
  agent_name: string | null;
  agent_mode: AgentMode;
  terminal_session_id: string | null;
  held_claims: CoordinationHeldClaim[];
  other_claims: CoordinationOtherClaim[];
}

/**
 * Build the coordination prompt context for a bound run.
 *
 * Returns `null` (no coordination block) when there is no binding or when
 * coordination is explicitly disabled. Otherwise returns a fully-resolved
 * context. `now` is an explicit clock seam so stale computation is deterministic.
 */
export function buildCoordinationPromptContext(
  repoRoot: string,
  binding: AgentBinding | null,
  options: { now?: string } = {},
): CoordinationPromptContext | null {
  if (!binding || binding.coordination_enabled !== true) return null;

  const readOptions = options.now ? { now: options.now } : {};
  const agents = listAgents(repoRoot, readOptions);
  const claims = listFileClaims(repoRoot, readOptions); // released excluded by default
  const agentNames = new Map(agents.map((agent) => [agent.agent_id, agent.agent_name]));

  const boundAgent = binding.agent_id ? agents.find((agent) => agent.agent_id === binding.agent_id) : undefined;

  const held_claims: CoordinationHeldClaim[] = [];
  const other_claims: CoordinationOtherClaim[] = [];
  for (const claim of claims) {
    if (claim.status !== 'active') continue; // stale/unknown owners are not active blockers
    if (binding.agent_id && claim.agent_id === binding.agent_id) {
      held_claims.push({ claim_id: claim.claim_id, path: claim.path, mode: claim.mode });
    } else {
      other_claims.push({
        claim_id: claim.claim_id,
        path: claim.path,
        mode: claim.mode,
        agent_id: claim.agent_id,
        agent_name: agentNames.get(claim.agent_id) ?? claim.agent_id,
      });
    }
  }

  return {
    agent_id: binding.agent_id,
    agent_name: boundAgent?.agent_name ?? null,
    agent_mode: binding.agent_mode,
    terminal_session_id: binding.terminal_session_id,
    held_claims,
    other_claims,
  };
}
