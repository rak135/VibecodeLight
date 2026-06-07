/**
 * Phase 4D-cleanup: minimal conflict recording.
 *
 * Records claim-denial events so agents can inspect conflict history.
 * Conflicts are advisory generated state stored in the existing
 * `state.json` conflicts array. Resolution marks a conflict as resolved.
 *
 * Hard rules:
 *   - The ONLY file ever written is `.vibecode/coordination/state.json`.
 *   - No source files, no git, no locks.
 *   - Conflict recording failure must not crash claim denial.
 */

import { randomUUID } from 'crypto';

import { loadCoordinationState, writeCoordinationState } from './state.js';

export type ConflictType = 'claim_denied' | 'stale_claim';
export type ConflictStatus = 'detected' | 'resolved';
export type ConflictSeverity = 'low' | 'medium' | 'high';

export interface ConflictRecord {
  conflict_id: string;
  conflict_type: ConflictType;
  detected_at: string;
  status: ConflictStatus;
  involved_claims: string[];
  involved_agents: string[];
  involved_files: string[];
  severity: ConflictSeverity;
  description: string;
  evidence: {
    detector: 'claim_manager' | 'claim_cleanup';
    details: Record<string, unknown>;
  };
  resolved_at?: string;
  resolved_by?: string;
  resolution?: Record<string, unknown>;
}

export interface RecordConflictInput {
  conflict_type: ConflictType;
  detected_at: string;
  involved_claims: string[];
  involved_agents: string[];
  involved_files: string[];
  severity: ConflictSeverity;
  description: string;
  evidence: {
    detector: 'claim_manager' | 'claim_cleanup';
    details: Record<string, unknown>;
  };
}

export interface ListConflictsFilter {
  status?: ConflictStatus;
  conflict_type?: ConflictType;
}

export interface ResolveConflictInput {
  resolved_at: string;
  resolved_by?: string;
  resolution?: Record<string, unknown>;
}

function generateConflictId(existing: ReadonlySet<string>): string {
  let id = `conflict-${randomUUID()}`;
  while (existing.has(id)) id = `conflict-${randomUUID()}`;
  return id;
}

/**
 * Record a conflict event into the coordination state.
 * Deduplicates: if an active (detected) conflict exists with the same
 * conflict_type, same requesting agent, same file, and same blocking claim,
 * it is not re-recorded.
 */
export function recordConflict(
  repoRoot: string,
  input: RecordConflictInput,
  options: { now?: string; conflictId?: string } = {},
): ConflictRecord {
  const now = options.now ?? new Date().toISOString();
  const state = loadCoordinationState(repoRoot, { now });

  const existing = state.conflicts as readonly ConflictRecord[];
  const isDuplicate = existing.some(
    (c) =>
      c.status === 'detected' &&
      c.conflict_type === input.conflict_type &&
      c.involved_agents.some((a) => input.involved_agents.includes(a)) &&
      c.involved_files.some((f) => input.involved_files.includes(f)) &&
      c.involved_claims.some((cl) => input.involved_claims.includes(cl)),
  );

  if (isDuplicate) {
    return existing.find(
      (c) =>
        c.status === 'detected' &&
        c.conflict_type === input.conflict_type &&
        c.involved_agents.some((a) => input.involved_agents.includes(a)) &&
        c.involved_files.some((f) => input.involved_files.includes(f)) &&
        c.involved_claims.some((cl) => input.involved_claims.includes(cl)),
    )!;
  }

  const existingIds = new Set(existing.map((c) => c.conflict_id));
  const conflictId = options.conflictId ?? generateConflictId(existingIds);

  const record: ConflictRecord = {
    conflict_id: conflictId,
    conflict_type: input.conflict_type,
    detected_at: input.detected_at,
    status: 'detected',
    involved_claims: input.involved_claims,
    involved_agents: input.involved_agents,
    involved_files: input.involved_files,
    severity: input.severity,
    description: input.description,
    evidence: input.evidence,
  };

  writeCoordinationState(repoRoot, {
    ...state,
    last_updated: now,
    conflicts: [...existing, record],
  });

  return record;
}

/**
 * List conflicts, optionally filtered by status or type.
 * Read-only: never writes to disk.
 */
export function listConflicts(
  repoRoot: string,
  filter?: ListConflictsFilter,
  options: { now?: string } = {},
): ConflictRecord[] {
  const now = options.now ?? new Date().toISOString();
  const state = loadCoordinationState(repoRoot, { now });
  let conflicts = state.conflicts as readonly ConflictRecord[];

  if (filter?.status) {
    conflicts = conflicts.filter((c) => c.status === filter.status);
  }
  if (filter?.conflict_type) {
    conflicts = conflicts.filter((c) => c.conflict_type === filter.conflict_type);
  }

  return [...conflicts];
}

/**
 * Resolve a conflict by id. Throws if the conflict is not found.
 */
export function resolveConflict(
  repoRoot: string,
  conflictId: string,
  input: ResolveConflictInput,
  options: { now?: string } = {},
): ConflictRecord {
  const now = options.now ?? new Date().toISOString();
  const state = loadCoordinationState(repoRoot, { now });
  const existing = state.conflicts as ConflictRecord[];
  const index = existing.findIndex((c) => c.conflict_id === conflictId);

  if (index === -1) {
    throw new Error(`Conflict not found: ${conflictId}`);
  }

  const resolved: ConflictRecord = {
    ...existing[index],
    status: 'resolved',
    resolved_at: input.resolved_at,
    resolved_by: input.resolved_by,
    resolution: input.resolution,
  };

  const conflicts = [...existing];
  conflicts[index] = resolved;

  writeCoordinationState(repoRoot, {
    ...state,
    last_updated: now,
    conflicts,
  });

  return resolved;
}
