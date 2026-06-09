import { randomUUID } from 'crypto';

import { findIntent, generateIntentId } from './claim_intents.js';
import {
  evaluateClaimPaths,
  resolveBuildClaimAgent,
  type ClaimPathPlanStatus,
} from './claim_planning.js';
import { listFileClaims } from './claims.js';
import { recordConflict } from './conflicts.js';
import { CoordinationError } from './errors.js';
import { loadCoordinationState, writeCoordinationState } from './state.js';
import type { ClaimIntent, FileClaim } from './types.js';

/**
 * Phase 2A — explicit bulk claims with agent-declared work intents.
 *
 * Core principle: Vibecode does NOT decide which files an agent needs. The agent
 * declares EXACT paths for an explicit intent; this service validates, detects
 * conflicts, and applies the claims as ONE atomic unit. It never infers, globs,
 * or expands paths.
 *
 * Atomicity: the whole set is evaluated first. If ANY requested path is blocked
 * (claimed by another active agent, invalid, or generated/ignored), NO new
 * claims are created — the coordination state is left untouched except for an
 * advisory conflict record. On success, all new claims, the agent's claim list,
 * and the intent are written in a SINGLE state write. The only file ever written
 * is `.vibecode/coordination/state.json`.
 */

export interface AddBulkClaimsInput {
  repoRoot: string;
  agent_id: string;
  /** Explicit paths to claim. No globs, no expansion. */
  paths: string[];
  /** Required when creating a NEW intent. Ignored when intent_id is supplied. */
  intent?: string;
  /** Extend an EXISTING intent owned by the same agent. */
  intent_id?: string;
  /** Clock seam (ISO-8601). */
  now?: string;
}

export interface CreatedBulkClaim {
  claim_id: string;
  path: string;
}

export interface BlockedBulkPath {
  path: string;
  reason: ClaimPathPlanStatus;
  conflicting_claims: FileClaim[];
}

export interface AddBulkClaimsResult {
  status: 'ok' | 'blocked';
  agent_id: string;
  intent_id: string | null;
  intent: string | null;
  atomic: true;
  created_claims: CreatedBulkClaim[];
  already_owned_paths: string[];
  blocked_paths: BlockedBulkPath[];
  conflict_id: string | null;
  warnings: string[];
  recommended_next_tools: string[];
  recommended_cli_commands: string[];
  checked_at: string;
}

export interface BulkClaimOptions {
  /** Test seam: override generated claim/intent ids in deterministic order. */
  claimIds?: string[];
  intentId?: string;
  conflictId?: string;
}

function generateClaimId(existing: ReadonlySet<string>): string {
  let id = `claim-${randomUUID()}`;
  while (existing.has(id)) id = `claim-${randomUUID()}`;
  return id;
}

function dedupePreserveOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Create or extend a declared work intent and claim the explicit paths atomically.
 */
export function addBulkClaims(
  input: AddBulkClaimsInput,
  options: BulkClaimOptions = {},
): AddBulkClaimsResult {
  const now = input.now ?? new Date().toISOString();

  // Gate: only an active build agent may bulk-claim. Throws for read_only /
  // invalid / missing / inactive agents (mapped to structured errors by adapters).
  const agent = resolveBuildClaimAgent(input.repoRoot, input.agent_id, now);

  const requestedPaths = Array.isArray(input.paths) ? input.paths : [];
  if (requestedPaths.length === 0) {
    throw new CoordinationError('NO_CLAIM_PATHS', 'bulk claim requires at least one explicit --path; Vibecode does not infer paths.');
  }

  const state = loadCoordinationState(input.repoRoot, { now });

  // Resolve the intent target up-front so a bad intent fails before any work.
  let targetIntent: ClaimIntent | null = null;
  let intentText: string;
  if (typeof input.intent_id === 'string' && input.intent_id.trim().length > 0) {
    const existing = findIntent(state.intents, input.intent_id.trim());
    if (!existing) {
      throw new CoordinationError('INTENT_NOT_FOUND', `No work intent found: ${input.intent_id}`, { intent_id: input.intent_id });
    }
    if (existing.agent_id !== agent.agent_id) {
      throw new CoordinationError(
        'INTENT_FORBIDDEN',
        `Intent ${existing.intent_id} belongs to agent ${existing.agent_id}; only its owning agent may extend it.`,
        { intent_id: existing.intent_id, owner_agent_id: existing.agent_id, agent_id: agent.agent_id },
      );
    }
    targetIntent = existing;
    intentText = existing.intent;
  } else {
    intentText = typeof input.intent === 'string' ? input.intent.trim() : '';
    if (intentText.length === 0) {
      throw new CoordinationError('INVALID_INTENT', 'bulk claim requires a non-empty intent when creating a new work intent (or an intent_id to extend an existing one).');
    }
  }

  // Classify against stale-aware claims (released excluded).
  const allClaims = listFileClaims(input.repoRoot, { now });
  const activeClaims = allClaims.filter((c) => c.status === 'active');
  const staleClaims = allClaims.filter((c) => c.status !== 'active');

  const evaluated = evaluateClaimPaths({
    repoRoot: input.repoRoot,
    agentId: agent.agent_id,
    inputPaths: requestedPaths,
    activeClaims,
    staleClaims,
  });

  const blocked = evaluated.filter((e) => e.blocking);
  const alreadyOwnedPaths = evaluated
    .filter((e) => e.status === 'already_claimed_by_agent')
    .map((e) => e.path);

  // --- atomic block: any blocked path → create NOTHING ---
  if (blocked.length > 0) {
    const otherAgentBlocks = blocked.filter((e) => e.status === 'claimed_by_other_active_agent');
    let conflictId: string | null = null;
    if (otherAgentBlocks.length > 0) {
      const conflictingClaims = otherAgentBlocks.flatMap((e) => e.conflicting_claims ?? []);
      try {
        const conflict = recordConflict(
          input.repoRoot,
          {
            conflict_type: 'claim_denied',
            detected_at: now,
            involved_claims: [...new Set(conflictingClaims.map((c) => c.claim_id))],
            involved_agents: [agent.agent_id, ...new Set(conflictingClaims.map((c) => c.agent_id))],
            involved_files: otherAgentBlocks.map((e) => e.path),
            severity: 'medium',
            description: `Bulk claim denied for agent ${agent.agent_id}: ${otherAgentBlocks.length} path(s) claimed by another active agent.`,
            evidence: {
              detector: 'claim_manager',
              details: {
                requested: { agent_id: agent.agent_id, intent: intentText },
                blocked_paths: otherAgentBlocks.map((e) => ({
                  path: e.path,
                  conflicting_claims: (e.conflicting_claims ?? []).map((c) => ({
                    claim_id: c.claim_id,
                    agent_id: c.agent_id,
                    path: c.path,
                    mode: c.mode,
                  })),
                })),
              },
            },
          },
          { now, conflictId: options.conflictId },
        );
        conflictId = conflict.conflict_id;
      } catch {
        // Conflict recording is advisory; a failure must not change the denial.
      }
    }

    return {
      status: 'blocked',
      agent_id: agent.agent_id,
      intent_id: targetIntent?.intent_id ?? null,
      intent: intentText,
      atomic: true,
      created_claims: [],
      already_owned_paths: alreadyOwnedPaths,
      blocked_paths: blocked.map((e) => ({
        path: e.path,
        reason: e.status,
        conflicting_claims: e.conflicting_claims ?? [],
      })),
      conflict_id: conflictId,
      warnings: [
        `Bulk claim blocked: ${blocked.length} path(s) cannot be claimed. No claims were created (atomic).`,
      ],
      recommended_next_tools: ['vibecode_claims_list', 'vibecode_conflicts_list'],
      recommended_cli_commands: [
        'vibecode claims list --json',
        'vibecode conflicts list --json',
      ],
      checked_at: now,
    };
  }

  // --- success: create claims for the creating paths in one state write ---
  const toCreate = evaluated.filter((e) => e.creates_claim);
  const existingClaimIds = new Set(state.claims.map((c) => c.claim_id));
  const intentId = targetIntent?.intent_id ?? options.intentId ?? generateIntentId(new Set(state.intents.map((i) => i.intent_id)));

  const createdClaims: FileClaim[] = [];
  toCreate.forEach((entry, index) => {
    const claimId = options.claimIds?.[index] ?? generateClaimId(existingClaimIds);
    existingClaimIds.add(claimId);
    createdClaims.push({
      claim_id: claimId,
      agent_id: agent.agent_id,
      path: entry.path,
      mode: 'exclusive',
      status: 'active',
      created_at: now,
      released_at: null,
      metadata: { intent_id: intentId, intent: intentText },
    });
  });

  const newClaimIds = createdClaims.map((c) => c.claim_id);
  const declaredPaths = evaluated
    .filter((e) => e.status !== 'invalid' && e.status !== 'generated_or_ignored')
    .map((e) => e.path);

  // Build or extend the intent.
  let nextIntents: ClaimIntent[];
  if (targetIntent) {
    const extend = targetIntent;
    nextIntents = state.intents.map((intent) =>
      intent.intent_id === extend.intent_id
        ? {
            ...intent,
            updated_at: now,
            claim_ids: dedupePreserveOrder([...intent.claim_ids, ...newClaimIds]),
            paths: dedupePreserveOrder([...intent.paths, ...declaredPaths]),
          }
        : intent,
    );
  } else {
    const created: ClaimIntent = {
      intent_id: intentId,
      agent_id: agent.agent_id,
      intent: intentText,
      status: 'active',
      created_at: now,
      updated_at: now,
      claim_ids: newClaimIds,
      paths: dedupePreserveOrder(declaredPaths),
    };
    nextIntents = [...state.intents, created];
  }

  const agents = state.agents.map((candidate) =>
    candidate.agent_id === agent.agent_id
      ? { ...candidate, claims: dedupePreserveOrder([...candidate.claims, ...newClaimIds]) }
      : candidate,
  );

  writeCoordinationState(input.repoRoot, {
    ...state,
    last_updated: now,
    agents,
    claims: [...state.claims, ...createdClaims],
    intents: nextIntents,
  });

  return {
    status: 'ok',
    agent_id: agent.agent_id,
    intent_id: intentId,
    intent: intentText,
    atomic: true,
    created_claims: createdClaims.map((c) => ({ claim_id: c.claim_id, path: c.path })),
    already_owned_paths: alreadyOwnedPaths,
    blocked_paths: [],
    conflict_id: null,
    warnings: [],
    recommended_next_tools: ['vibecode_git_changes', 'vibecode_finalize_check'],
    recommended_cli_commands: [
      `vibecode git changes --agent ${agent.agent_id} --json`,
    ],
    checked_at: now,
  };
}

/** Read the agent-declared work intents (read-only). Missing state → []. */
export function listClaimIntents(
  repoRoot: string,
  options: { now?: string } = {},
): ClaimIntent[] {
  const state = loadCoordinationState(repoRoot, options);
  return [...state.intents];
}
