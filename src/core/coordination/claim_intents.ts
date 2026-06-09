import { randomUUID } from 'crypto';

import type { ClaimIntent, FileClaim } from './types.js';

/**
 * Phase 2A — agent-declared work intents (claim intent metadata).
 *
 * Core principle: Vibecode does NOT decide which files an agent needs. An intent
 * is the readable, extendable record of a work scope the agent explicitly
 * declared. This module owns only the small, pure helpers for intent ids and the
 * compact summaries surfaced by bootstrap. The mutating create/extend logic lives
 * in {@link ./bulk_claims} so the whole bulk operation stays a single atomic state
 * write.
 */

/** Generate a stable, unique, filesystem/JSON-safe intent id. */
export function generateIntentId(existing: ReadonlySet<string>): string {
  let id = `intent-${randomUUID()}`;
  while (existing.has(id)) id = `intent-${randomUUID()}`;
  return id;
}

/** Find an intent by id, or null when it does not exist. */
export function findIntent(
  intents: readonly ClaimIntent[],
  intentId: string,
): ClaimIntent | null {
  return intents.find((intent) => intent.intent_id === intentId) ?? null;
}

/** Default cap on the per-intent sample-path preview. */
export const DEFAULT_INTENT_SAMPLE_PATHS = 5;

/** Compact, bounded summary of one active work intent for orientation output. */
export interface ActiveWorkIntentSummary {
  intent_id: string;
  intent: string;
  status: string;
  /** Number of the intent's claim ids that are still active claims. */
  claim_count: number;
  /** First {@link DEFAULT_INTENT_SAMPLE_PATHS} declared paths. */
  sample_paths: string[];
  /** True when the intent declares more paths than the sample shows. */
  sample_truncated: boolean;
}

export interface ActiveWorkIntentOptions {
  /** Cap on the number of intents summarized. */
  maxItems?: number;
  /** Cap on per-intent sample paths. */
  maxSamplePaths?: number;
}

/**
 * Build compact summaries of an agent's active work intents.
 *
 * Read-only and pure: the caller supplies the agent's intents and the set of
 * currently active claim ids. `claim_count` reflects only the intent's claims
 * that are still active (released/reaped claims drop out), so the summary stays
 * honest without re-reading state.
 */
export function summarizeActiveWorkIntents(args: {
  intents: readonly ClaimIntent[];
  agentId: string;
  activeClaimIds: ReadonlySet<string>;
  options?: ActiveWorkIntentOptions;
}): ActiveWorkIntentSummary[] {
  const maxItems = args.options?.maxItems ?? Number.POSITIVE_INFINITY;
  const maxSamplePaths = args.options?.maxSamplePaths ?? DEFAULT_INTENT_SAMPLE_PATHS;

  const own = args.intents.filter(
    (intent) => intent.agent_id === args.agentId && intent.status === 'active',
  );

  const summaries: ActiveWorkIntentSummary[] = [];
  for (const intent of own) {
    const activeClaimCount = intent.claim_ids.filter((id) => args.activeClaimIds.has(id)).length;
    const sample = intent.paths.slice(0, Math.max(0, maxSamplePaths));
    summaries.push({
      intent_id: intent.intent_id,
      intent: intent.intent,
      status: intent.status,
      claim_count: activeClaimCount,
      sample_paths: sample,
      sample_truncated: sample.length < intent.paths.length,
    });
    if (summaries.length >= maxItems) break;
  }
  return summaries;
}

/** Set of claim ids referenced by the given claims (helper for summaries). */
export function claimIdSet(claims: readonly FileClaim[]): Set<string> {
  return new Set(claims.map((claim) => claim.claim_id));
}
