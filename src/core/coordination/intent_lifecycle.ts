import { findIntent } from './claim_intents.js';
import { releaseFileClaim } from './claims.js';
import { CoordinationError } from './errors.js';
import { loadCoordinationState, writeCoordinationState } from './state.js';
import type { ClaimIntent, FileClaim } from './types.js';
import {
  getGitChangedFiles,
} from '../workspace/git_changed_files.js';
import { defaultGitReadOnlyRunner, type GitReadOnlyRunner } from '../workspace/git_status.js';

/**
 * Phase 2B — claim intent lifecycle: listing, dry-run release, and release.
 *
 * Core principle: Vibecode does NOT decide which files an agent needs. An intent
 * is the readable, extendable record of a work scope the agent explicitly
 * declared. These services let the agent inspect, release, and manage intents
 * safely. Release is blocked when any claimed path is dirty in the working tree.
 *
 * All functions here are deterministic and write only generated coordination
 * state. No source files are touched. No git mutation.
 */

// ---------------------------------------------------------------------------
// Intent listing
// ---------------------------------------------------------------------------

export interface IntentListFilter {
  /** Filter by agent_id. */
  agent_id?: string;
  /** Filter by status. Default: 'active'. */
  status?: 'active' | 'released' | 'all';
  /** Filter by a specific intent_id. */
  intent_id?: string;
  /** Cap on number of intents returned. */
  max_items?: number;
}

export interface IntentDetailClaim {
  claim_id: string;
  path: string;
  status: string;
}

export interface IntentDetail {
  intent_id: string;
  agent_id: string;
  intent: string;
  status: string;
  claim_count: number;
  active_claim_count: number;
  released_claim_count: number;
  paths: string[];
  sample_paths: string[];
  sample_truncated: boolean;
  created_at: string;
  updated_at: string;
  released_at: string | null;
  released_by_agent_id: string | null;
}

export interface ListIntentsResult {
  agent_id: string | null;
  status_filter: string;
  intents: IntentDetail[];
  truncated: boolean;
  warnings: string[];
}

/** Default cap on per-intent sample paths in the detail view. */
const DEFAULT_INTENT_SAMPLE_PATHS = 10;

/**
 * List claim intents with rich detail for the intent lifecycle.
 *
 * Read-only. Does not mutate state. Returns enough data for an agent to decide
 * what to release.
 */
export function listClaimIntentsDetail(
  repoRoot: string,
  filter: IntentListFilter = {},
): ListIntentsResult {
  const state = loadCoordinationState(repoRoot);
  const maxItems = filter.max_items ?? Number.POSITIVE_INFINITY;
  const statusFilter = filter.status ?? 'active';
  const warnings: string[] = [];

  const allClaims = state.claims as FileClaim[];

  let intents = [...state.intents];

  // Filter by agent_id.
  if (filter.agent_id) {
    intents = intents.filter((i) => i.agent_id === filter.agent_id);
  }

  // Filter by status.
  if (statusFilter !== 'all') {
    intents = intents.filter((i) => i.status === statusFilter);
  }

  // Filter by specific intent_id.
  if (filter.intent_id) {
    intents = intents.filter((i) => i.intent_id === filter.intent_id);
  }

  // Cap.
  const truncated = intents.length > maxItems;
  const bounded = intents.slice(0, maxItems);

  const details: IntentDetail[] = bounded.map((intent) => {
    const claimIds = new Set(intent.claim_ids);
    const intentClaims = allClaims.filter((c) => claimIds.has(c.claim_id));
    const activeCount = intentClaims.filter((c) => c.status === 'active').length;
    const releasedCount = intentClaims.filter((c) => c.status === 'released').length;
    const samplePaths = intent.paths.slice(0, DEFAULT_INTENT_SAMPLE_PATHS);

    return {
      intent_id: intent.intent_id,
      agent_id: intent.agent_id,
      intent: intent.intent,
      status: intent.status,
      claim_count: intentClaims.length,
      active_claim_count: activeCount,
      released_claim_count: releasedCount,
      paths: [...intent.paths],
      sample_paths: samplePaths,
      sample_truncated: samplePaths.length < intent.paths.length,
      created_at: intent.created_at,
      updated_at: intent.updated_at,
      released_at: intent.released_at ?? null,
      released_by_agent_id: intent.released_by_agent_id ?? null,
    };
  });

  return {
    agent_id: filter.agent_id ?? null,
    status_filter: statusFilter,
    intents: details,
    truncated,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Intent release (dry-run + mutation)
// ---------------------------------------------------------------------------

export interface IntentReleaseInput {
  repoRoot: string;
  agent_id: string;
  intent_id: string;
  /** When true, report what would happen without mutating state. */
  dry_run?: boolean;
  /** Clock seam (ISO-8601). */
  now?: string;
  /** Test seam: read-only git runner for dirty-file detection. */
  gitRunner?: GitReadOnlyRunner;
}

export interface ReleasableClaim {
  claim_id: string;
  path: string;
}

export interface IntentReleaseResult {
  agent_id: string;
  intent_id: string;
  dry_run: boolean;
  release_allowed: boolean;
  status: 'ok' | 'blocked' | 'already_released';
  intent_status: string;
  /** Claims that were (or would be) released. */
  released_claims: ReleasableClaim[];
  /** Claims already released before this call. */
  already_released_claims: ReleasableClaim[];
  /** Dirty claimed paths that block release. */
  dirty_claimed_paths: string[];
  blocked_reason: string | null;
  warnings: string[];
  recommended_cli_commands: string[];
  checked_at: string;
}

/**
 * Find dirty files that overlap with the given paths.
 *
 * Uses git changed files (read-only) and matches against the intent's claimed
 * paths by exact match or prefix (since claims overlap by prefix).
 */
function getDirtyClaimedPaths(
  repoRoot: string,
  claimedPaths: string[],
  gitRunner: GitReadOnlyRunner,
): string[] {
  const changed = getGitChangedFiles(repoRoot, gitRunner);
  if (!changed.ok) return [];

  const dirtyPaths = new Set(changed.files.map((f) => f.path));
  const result: string[] = [];

  for (const claimed of claimedPaths) {
    for (const dirty of dirtyPaths) {
      if (dirty === claimed || dirty.startsWith(`${claimed}/`) || claimed.startsWith(`${dirty}/`)) {
        result.push(claimed);
        break;
      }
    }
  }
  return [...new Set(result)];
}

/**
 * Dry-run or execute release of all active claims belonging to a work intent.
 *
 * Same-agent only. Blocked when any currently-claimed path in the intent is
 * dirty in the working tree. Releases all active claims belonging to the intent
 * and marks the intent as released. Does not delete the intent record.
 */
export function releaseClaimIntent(input: IntentReleaseInput): IntentReleaseResult {
  const now = input.now ?? new Date().toISOString();
  const isDryRun = input.dry_run === true;
  const gitRunner = input.gitRunner ?? defaultGitReadOnlyRunner;

  const state = loadCoordinationState(input.repoRoot, { now });

  // Find the intent.
  const intent = findIntent(state.intents, input.intent_id);
  if (!intent) {
    throw new CoordinationError(
      'INTENT_NOT_FOUND',
      `No work intent found: ${input.intent_id}`,
      { intent_id: input.intent_id },
    );
  }

  // Same-agent check.
  if (intent.agent_id !== input.agent_id) {
    throw new CoordinationError(
      'INTENT_FORBIDDEN',
      `Intent ${intent.intent_id} belongs to agent ${intent.agent_id}; only its owning agent may release it.`,
      { intent_id: intent.intent_id, owner_agent_id: intent.agent_id, agent_id: input.agent_id },
    );
  }

  // Already released — idempotent response.
  if (intent.status === 'released') {
    const claimIds = new Set(intent.claim_ids);
    const intentClaims = (state.claims as FileClaim[]).filter((c) => claimIds.has(c.claim_id));
    const alreadyReleased = intentClaims.filter((c) => c.status === 'released');

    return {
      agent_id: input.agent_id,
      intent_id: input.intent_id,
      dry_run: isDryRun,
      release_allowed: true,
      status: 'already_released',
      intent_status: 'released',
      released_claims: [],
      already_released_claims: alreadyReleased.map((c) => ({ claim_id: c.claim_id, path: c.path })),
      dirty_claimed_paths: [],
      blocked_reason: null,
      warnings: ['Intent is already released.'],
      recommended_cli_commands: [
        `vibecode session bootstrap --agent ${input.agent_id} --json`,
      ],
      checked_at: now,
    };
  }

  // Find active claims for this intent.
  const claimIds = new Set(intent.claim_ids);
  const intentClaims = (state.claims as FileClaim[]).filter((c) => claimIds.has(c.claim_id));
  const activeClaims = intentClaims.filter((c) => c.status === 'active');
  const alreadyReleased = intentClaims.filter((c) => c.status === 'released');

  // Check for dirty files among the intent's claimed paths.
  const dirtyPaths = getDirtyClaimedPaths(
    input.repoRoot,
    intent.paths,
    gitRunner,
  );

  if (dirtyPaths.length > 0) {
    return {
      agent_id: input.agent_id,
      intent_id: input.intent_id,
      dry_run: isDryRun,
      release_allowed: false,
      status: 'blocked',
      intent_status: 'active',
      released_claims: [],
      already_released_claims: alreadyReleased.map((c) => ({ claim_id: c.claim_id, path: c.path })),
      dirty_claimed_paths: dirtyPaths,
      blocked_reason: 'dirty_claimed_files',
      warnings: [
        `Release blocked: ${dirtyPaths.length} claimed path(s) are dirty in the working tree.`,
        'Commit through vibecode commit guard or revert changes, then retry release.',
      ],
      recommended_cli_commands: [
        `vibecode git changes --agent ${input.agent_id} --json`,
        `vibecode finalize check --agent ${input.agent_id} --json`,
      ],
      checked_at: now,
    };
  }

  // Dry-run: report what would happen without mutating.
  if (isDryRun) {
    return {
      agent_id: input.agent_id,
      intent_id: input.intent_id,
      dry_run: true,
      release_allowed: true,
      status: 'ok',
      intent_status: 'active',
      released_claims: activeClaims.map((c) => ({ claim_id: c.claim_id, path: c.path })),
      already_released_claims: alreadyReleased.map((c) => ({ claim_id: c.claim_id, path: c.path })),
      dirty_claimed_paths: [],
      blocked_reason: null,
      warnings: [],
      recommended_cli_commands: [
        `vibecode claims intent-release --agent ${input.agent_id} --intent-id ${input.intent_id} --json`,
      ],
      checked_at: now,
    };
  }

  // --- mutation: release all active claims and mark intent as released ---

  // Release each active claim individually using the existing releaseFileClaim.
  for (const claim of activeClaims) {
    releaseFileClaim(input.repoRoot, claim.claim_id, { now });
  }

  // Mark the intent as released.
  const nextState = loadCoordinationState(input.repoRoot, { now });
  const updatedIntents = (nextState.intents as ClaimIntent[]).map((i) =>
    i.intent_id === input.intent_id
      ? {
          ...i,
          status: 'released' as const,
          updated_at: now,
          released_at: now,
          released_by_agent_id: input.agent_id,
        }
      : i,
  );

  writeCoordinationState(input.repoRoot, {
    ...nextState,
    last_updated: now,
    intents: updatedIntents,
  });

  return {
    agent_id: input.agent_id,
    intent_id: input.intent_id,
    dry_run: false,
    release_allowed: true,
    status: 'ok',
    intent_status: 'released',
    released_claims: activeClaims.map((c) => ({ claim_id: c.claim_id, path: c.path })),
    already_released_claims: alreadyReleased.map((c) => ({ claim_id: c.claim_id, path: c.path })),
    dirty_claimed_paths: [],
    blocked_reason: null,
    warnings: activeClaims.length === 0
      ? ['No active claims to release; intent had only already-released claims.']
      : [],
    recommended_cli_commands: [
      `vibecode session bootstrap --agent ${input.agent_id} --json`,
    ],
    checked_at: now,
  };
}
