import { isGeneratedOrIgnoredRuntimePath } from '../workspace/git_changed_files.js';
import type { FileClaim } from './types.js';

/**
 * Shared changed-path classification primitive.
 *
 * Core truth: in one shared working tree (no git worktrees) Vibecode cannot know
 * which agent physically edited a file. This helper therefore classifies a
 * repo-relative path RELATIVE to the active advisory claims — it never asserts
 * "agent X edited file Y". It is the single source of truth reused by both the
 * Phase 4A finalize check and the Phase 4C watcher evidence layer so the
 * classification rules are never duplicated.
 */

export type ChangedPathClassification =
  | 'claimed_by_agent'
  | 'claimed_by_other_active_agent'
  | 'unclaimed'
  | 'generated_or_ignored'
  | 'unknown';

export interface ChangedPathClassificationResult {
  classification: ChangedPathClassification;
  /** Set when an active claim authorizes/owns the path. */
  owning_claim_id?: string;
  owning_agent_id?: string;
  owning_agent_name?: string;
  /** Set when only a stale/released claim overlaps an otherwise unclaimed path. */
  stale_overlap_claim_id?: string;
  stale_overlap_agent_id?: string;
}

/** Repo-relative POSIX path overlap: equal, or one is a directory prefix of the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Classify a single repo-relative changed path against the supplied claims.
 *
 * Rules (in order):
 *   1. generated/ignored runtime path → `generated_or_ignored`,
 *   2. active claim held by the current agent (when `agentId` is set and matches)
 *      → `claimed_by_agent`,
 *   3. active claim held by anyone else → `claimed_by_other_active_agent`,
 *   4. otherwise `unclaimed` (a stale/released overlap is surfaced but never
 *      authorizes the path).
 *
 * When `agentId` is null/undefined (no current agent context, as for a generic
 * watcher scan) any overlapping active claim is attributed to another active
 * agent rather than to the unknown current context.
 */
export function classifyChangedPath(args: {
  path: string;
  agentId?: string | null;
  activeClaims: readonly FileClaim[];
  staleClaims?: readonly FileClaim[];
  agentNames?: ReadonlyMap<string, string>;
}): ChangedPathClassificationResult {
  const { path: changedPath, agentId, activeClaims } = args;
  const staleClaims = args.staleClaims ?? [];
  const nameFor = (id: string): string => args.agentNames?.get(id) ?? id;

  if (isGeneratedOrIgnoredRuntimePath(changedPath)) {
    return { classification: 'generated_or_ignored' };
  }

  if (agentId) {
    const own = activeClaims.find(
      (claim) => claim.agent_id === agentId && pathsOverlap(claim.path, changedPath),
    );
    if (own) {
      return {
        classification: 'claimed_by_agent',
        owning_claim_id: own.claim_id,
        owning_agent_id: agentId,
        owning_agent_name: nameFor(agentId),
      };
    }
  }

  const other = activeClaims.find(
    (claim) => claim.agent_id !== agentId && pathsOverlap(claim.path, changedPath),
  );
  if (other) {
    return {
      classification: 'claimed_by_other_active_agent',
      owning_claim_id: other.claim_id,
      owning_agent_id: other.agent_id,
      owning_agent_name: nameFor(other.agent_id),
    };
  }

  const staleOverlap = staleClaims.find((claim) => pathsOverlap(claim.path, changedPath));
  const result: ChangedPathClassificationResult = { classification: 'unclaimed' };
  if (staleOverlap) {
    result.stale_overlap_claim_id = staleOverlap.claim_id;
    result.stale_overlap_agent_id = staleOverlap.agent_id;
  }
  return result;
}
