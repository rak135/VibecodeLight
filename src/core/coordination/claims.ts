import { randomUUID } from 'crypto';
import path from 'path';

import { CoordinationError } from './errors.js';
import { recordConflict } from './conflicts.js';
import { HEARTBEAT_TTL_MS, computeAgentStatus } from './heartbeat.js';
import { loadCoordinationState, writeCoordinationState } from './state.js';
import {
  isClaimMode,
  type AgentSession,
  type ClaimMode,
  type ClaimStatus,
  type FileClaim,
} from './types.js';
import { requireBuildAgent } from './agent_operating_mode.js';

/**
 * Phase 3A advisory file claims.
 *
 * Claims are plain generated state, not locks. This module never touches source
 * files, never creates per-file lock artifacts, and never persists conflict
 * records for claim denial. CLI and MCP adapters translate these core results
 * into their own envelopes.
 */

export interface AddFileClaimInput {
  agent_id: string;
  path: string;
  mode: ClaimMode | string;
  metadata?: Record<string, unknown>;
}

export interface ClaimMutationOptions {
  now?: string;
  claimId?: string;
  ttlMs?: number;
}

export interface ClaimReadOptions {
  now?: string;
  ttlMs?: number;
  agentId?: string;
  includeReleased?: boolean;
}

export interface ClaimDeniedDiagnostic {
  code: 'CLAIM_DENIED';
  message: string;
  details: Record<string, unknown>;
}

export interface AddFileClaimResult {
  denied: boolean;
  claim: FileClaim | null;
  conflicting_claims: FileClaim[];
  error?: ClaimDeniedDiagnostic;
}

export interface ClaimStatusForPath {
  path: string;
  matching_claims: FileClaim[];
  can_claim_shared: boolean;
  can_claim_exclusive: boolean;
}

export interface ReleaseFileClaimResult {
  claim: FileClaim;
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function generateClaimId(existing: ReadonlySet<string>): string {
  let id = `claim-${randomUUID()}`;
  while (existing.has(id)) id = `claim-${randomUUID()}`;
  return id;
}

/** Normalize a caller path to a repository-relative POSIX path. */
export function normalizeClaimPath(repoRoot: string, input: string): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw || raw === '.') {
    throw new CoordinationError('INVALID_CLAIM_PATH', 'claim path must be a non-empty repository-relative path');
  }
  if ([...raw].some((ch) => ch.charCodeAt(0) < 32)) {
    throw new CoordinationError('INVALID_CLAIM_PATH', 'claim path must not contain control characters', { path: input });
  }
  if (path.isAbsolute(raw)) {
    throw new CoordinationError('INVALID_CLAIM_PATH', 'claim path must be repository-relative', { path: input });
  }

  const workspaceRoot = path.resolve(repoRoot);
  const resolved = path.resolve(workspaceRoot, raw);
  const relative = path.relative(workspaceRoot, resolved);
  if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CoordinationError('INVALID_CLAIM_PATH', 'claim path must stay inside the repository', { path: input });
  }

  const normalized = relative.replace(/\\/g, '/');
  if (normalized === '.vibecode' || normalized.startsWith('.vibecode/')) {
    throw new CoordinationError('INVALID_CLAIM_PATH', 'claim path must not target generated .vibecode state', {
      path: input,
      normalized_path: normalized,
    });
  }
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    throw new CoordinationError('INVALID_CLAIM_PATH', 'claim path must not target .git internals', {
      path: input,
      normalized_path: normalized,
    });
  }
  return normalized;
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function claimBlocks(requestMode: ClaimMode, existing: FileClaim): boolean {
  return requestMode === 'exclusive' || existing.mode === 'exclusive';
}

function agentStatus(agent: AgentSession | undefined, nowMs: number, ttlMs: number): AgentSession['status'] {
  if (!agent) return 'unknown';
  return computeAgentStatus(agent, nowMs, ttlMs);
}

function withComputedClaimStatus(
  claim: FileClaim,
  agents: readonly AgentSession[],
  nowMs: number,
  ttlMs: number,
): FileClaim {
  if (claim.status === 'released') return claim;
  const owner = agents.find((agent) => agent.agent_id === claim.agent_id);
  const status = agentStatus(owner, nowMs, ttlMs);
  if (status === 'active' || status === 'idle') return { ...claim, status: 'active' };
  if (status === 'stale' || status === 'terminated') return { ...claim, status: 'stale' };
  return { ...claim, status: 'unknown' };
}

function activeBlockingClaims(args: {
  claims: readonly FileClaim[];
  agents: readonly AgentSession[];
  requestedPath: string;
  requestedMode: ClaimMode;
  nowMs: number;
  ttlMs: number;
}): FileClaim[] {
  return args.claims
    .map((claim) => withComputedClaimStatus(claim, args.agents, args.nowMs, args.ttlMs))
    .filter((claim) =>
      claim.status === 'active' &&
      pathsOverlap(claim.path, args.requestedPath) &&
      claimBlocks(args.requestedMode, claim),
    );
}

function requireClaimingAgent(
  agents: readonly AgentSession[],
  agentId: string,
  nowMs: number,
  ttlMs: number,
): AgentSession {
  const agent = agents.find((candidate) => candidate.agent_id === agentId);
  if (!agent) {
    throw new CoordinationError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`, { agent_id: agentId });
  }
  const status = computeAgentStatus(agent, nowMs, ttlMs);
  if (status !== 'active' && status !== 'idle') {
    throw new CoordinationError('AGENT_NOT_ACTIVE', `Agent cannot create claims while status is ${status}`, {
      agent_id: agentId,
      status,
    });
  }
  return agent;
}

export function addFileClaim(
  repoRoot: string,
  input: AddFileClaimInput,
  options: ClaimMutationOptions = {},
): AddFileClaimResult {
  const now = nowIso(options.now);
  const ttlMs = options.ttlMs ?? HEARTBEAT_TTL_MS;
  const nowMs = Date.parse(now);
  if (!isClaimMode(input.mode)) {
    throw new CoordinationError('INVALID_CLAIM_MODE', `invalid claim mode: ${JSON.stringify(input.mode)}`, {
      mode: input.mode,
    });
  }

  const normalizedPath = normalizeClaimPath(repoRoot, input.path);
  const state = loadCoordinationState(repoRoot, { now });
  const agent = requireClaimingAgent(state.agents, input.agent_id, nowMs, ttlMs);

  // Enforce operating mode: only build agents may claim files.
  try {
    requireBuildAgent(agent);
  } catch (err) {
    if (err instanceof CoordinationError) {
      return {
        denied: true,
        claim: null,
        conflicting_claims: [],
        error: {
          code: 'CLAIM_DENIED',
          message: err.message,
          details: {
            requested: { agent_id: input.agent_id, path: normalizedPath, mode: input.mode },
            reason: err.code,
            agent_id: input.agent_id,
          },
        },
      };
    }
    throw err;
  }

  const conflicting = activeBlockingClaims({
    claims: state.claims,
    agents: state.agents,
    requestedPath: normalizedPath,
    requestedMode: input.mode,
    nowMs,
    ttlMs,
  });

  if (conflicting.length > 0) {
    // Record a conflict for the denial (best-effort; must not crash claim denial).
    try {
      recordConflict(repoRoot, {
        conflict_type: 'claim_denied',
        detected_at: now,
        involved_claims: conflicting.map((c) => c.claim_id),
        involved_agents: [input.agent_id, ...new Set(conflicting.map((c) => c.agent_id))],
        involved_files: [normalizedPath],
        severity: 'medium',
        description: `Claim denied for ${normalizedPath}: ${conflicting.length} overlapping active claim(s).`,
        evidence: {
          detector: 'claim_manager',
          details: {
            requested: { agent_id: input.agent_id, path: normalizedPath, mode: input.mode },
            conflicting_claims: conflicting.map((c) => ({ claim_id: c.claim_id, agent_id: c.agent_id, path: c.path, mode: c.mode })),
          },
        },
      }, { now });
    } catch {
      // Conflict recording is advisory; a failure must not prevent the denial response.
    }

    return {
      denied: true,
      claim: null,
      conflicting_claims: conflicting,
      error: {
        code: 'CLAIM_DENIED',
        message: `Claim denied for ${normalizedPath}: ${conflicting.length} overlapping active claim(s).`,
        details: {
          requested: { agent_id: input.agent_id, path: normalizedPath, mode: input.mode },
          conflicting_claims: conflicting,
          suggestions: ['wait', 'release_existing_claim', 'retry_shared_if_compatible'],
        },
      },
    };
  }

  const existingIds = new Set(state.claims.map((claim) => claim.claim_id));
  const claimId = options.claimId ?? generateClaimId(existingIds);
  const claim: FileClaim = {
    claim_id: claimId,
    agent_id: agent.agent_id,
    path: normalizedPath,
    mode: input.mode,
    status: 'active',
    created_at: now,
    released_at: null,
    metadata: input.metadata ?? {},
  };

  const agents = state.agents.map((candidate) =>
    candidate.agent_id === agent.agent_id
      ? { ...candidate, claims: [...candidate.claims.filter((id) => id !== claimId), claimId] }
      : candidate,
  );

  writeCoordinationState(repoRoot, {
    ...state,
    last_updated: now,
    agents,
    claims: [...state.claims, claim],
  });

  return { denied: false, claim, conflicting_claims: [] };
}

export function listFileClaims(repoRoot: string, options: ClaimReadOptions = {}): FileClaim[] {
  const now = nowIso(options.now);
  const ttlMs = options.ttlMs ?? HEARTBEAT_TTL_MS;
  const nowMs = Date.parse(now);
  const state = loadCoordinationState(repoRoot, { now });
  return state.claims
    .map((claim) => withComputedClaimStatus(claim, state.agents, nowMs, ttlMs))
    .filter((claim) => options.includeReleased === true || claim.status !== 'released')
    .filter((claim) => !options.agentId || claim.agent_id === options.agentId);
}

export function getClaimStatusForPath(
  repoRoot: string,
  claimPath: string,
  options: ClaimReadOptions = {},
): ClaimStatusForPath {
  const normalizedPath = normalizeClaimPath(repoRoot, claimPath);
  const claims = listFileClaims(repoRoot, { ...options, includeReleased: false });
  const matching = claims.filter((claim) => claim.status !== 'released' && pathsOverlap(claim.path, normalizedPath));
  const activeMatching = matching.filter((claim) => claim.status === 'active');
  const hasExclusive = activeMatching.some((claim) => claim.mode === 'exclusive');
  return {
    path: normalizedPath,
    matching_claims: matching,
    can_claim_shared: !hasExclusive,
    can_claim_exclusive: activeMatching.length === 0,
  };
}

export function releaseFileClaim(
  repoRoot: string,
  claimId: string,
  options: ClaimMutationOptions = {},
): ReleaseFileClaimResult {
  const now = nowIso(options.now);
  const state = loadCoordinationState(repoRoot, { now });
  const index = state.claims.findIndex((claim) => claim.claim_id === claimId);
  if (index === -1) {
    throw new CoordinationError('CLAIM_NOT_FOUND', `Claim not found: ${claimId}`, { claim_id: claimId });
  }

  const existing = state.claims[index];
  const released: FileClaim = {
    ...existing,
    status: 'released',
    released_at: existing.released_at ?? now,
  };
  const claims = [...state.claims];
  claims[index] = released;
  const agents = state.agents.map((agent) =>
    agent.agent_id === released.agent_id
      ? { ...agent, claims: agent.claims.filter((id) => id !== released.claim_id) }
      : agent,
  );

  writeCoordinationState(repoRoot, {
    ...state,
    last_updated: now,
    agents,
    claims,
  });

  return { claim: released };
}

export type { ClaimMode, ClaimStatus, FileClaim };
