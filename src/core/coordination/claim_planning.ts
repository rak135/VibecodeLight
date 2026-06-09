import fs from 'fs';
import path from 'path';

import { listAgents } from './agents.js';
import { requireBuildAgent } from './agent_operating_mode.js';
import {
  isExistingDirectory,
  listFileClaims,
  normalizeClaimPath,
  requireClaimingAgent,
} from './claims.js';
import { CoordinationError } from './errors.js';
import { HEARTBEAT_TTL_MS } from './heartbeat.js';
import { pathsOverlap } from './path_classification.js';
import type { AgentSession, FileClaim } from './types.js';
import { isGeneratedOrIgnoredRuntimePath } from '../workspace/git_changed_files.js';

/**
 * Phase 2A — claim planning (read-only) + shared explicit-path evaluation.
 *
 * Core principle: Vibecode does NOT decide which files an agent needs. These
 * functions only evaluate the EXACT paths an agent supplies — they never infer,
 * expand, glob, or suggest paths. The same evaluator powers the read-only
 * `planClaims` preview and the mutating bulk claim (see {@link ./bulk_claims}),
 * so the preview and the real operation can never disagree about what is
 * claimable, owned, or blocked.
 *
 * This module performs NO state mutation. It reads coordination state and the
 * working tree (`fs.existsSync` for the missing/claimable distinction) only.
 */

/** Per-path classification produced by the shared evaluator. */
export type ClaimPathPlanStatus =
  | 'claimable'
  | 'missing'
  | 'already_claimed_by_agent'
  | 'claimed_by_other_active_agent'
  | 'stale_claim_overlap'
  | 'generated_or_ignored'
  | 'directory_not_supported'
  | 'invalid';

/** Evaluation of a single explicitly-declared path. */
export interface ClaimPathPlan {
  /** Raw path as supplied by the agent. */
  input_path: string;
  /** Normalized repo-relative POSIX path, or the raw input when invalid. */
  path: string;
  status: ClaimPathPlanStatus;
  reason: string;
  /** True when this status prevents an atomic bulk claim of the whole set. */
  blocking: boolean;
  /** True when a bulk claim WOULD create a new claim for this path. */
  creates_claim: boolean;
  /** already_claimed_by_agent: the owning active claim id. */
  claim_id?: string;
  /** claimed_by_other_active_agent: the overlapping active claim(s). */
  conflicting_claims?: FileClaim[];
  /** stale_claim_overlap: the overlapping stale claim id. */
  stale_claim_id?: string;
}

function fileExists(repoRoot: string, normalized: string): boolean {
  try {
    return fs.existsSync(path.join(repoRoot, normalized));
  } catch {
    return false;
  }
}

function classifyExplicitPath(args: {
  repoRoot: string;
  agentId: string;
  inputPath: string;
  normalized: string;
  activeClaims: readonly FileClaim[];
  staleClaims: readonly FileClaim[];
}): ClaimPathPlan {
  const base = { input_path: args.inputPath, path: args.normalized };

  // Generated/ignored runtime roots (node_modules, .codegraph). `.vibecode` and
  // `.git` already fail normalization as INVALID_CLAIM_PATH. Bulk never claims
  // these silently.
  if (isGeneratedOrIgnoredRuntimePath(args.normalized)) {
    return {
      ...base,
      status: 'generated_or_ignored',
      reason: 'Generated/ignored runtime path; not eligible for advisory claims.',
      blocking: true,
      creates_claim: false,
    };
  }

  // Existing directories are rejected before any overlap classification: a
  // directory claim would authorize every descendant the agent did not declare
  // (claims overlap by path prefix). Declare explicit file paths only.
  if (isExistingDirectory(args.repoRoot, args.normalized)) {
    return {
      ...base,
      status: 'directory_not_supported',
      reason: 'Path is an existing directory; declare explicit file paths only (a directory claim would authorize files you did not declare).',
      blocking: true,
      creates_claim: false,
    };
  }

  const own = args.activeClaims.find(
    (claim) => claim.agent_id === args.agentId && pathsOverlap(claim.path, args.normalized),
  );
  if (own) {
    return {
      ...base,
      status: 'already_claimed_by_agent',
      reason: `Already covered by this agent's active claim (${own.claim_id}).`,
      blocking: false,
      creates_claim: false,
      claim_id: own.claim_id,
    };
  }

  const others = args.activeClaims.filter(
    (claim) => claim.agent_id !== args.agentId && pathsOverlap(claim.path, args.normalized),
  );
  if (others.length > 0) {
    return {
      ...base,
      status: 'claimed_by_other_active_agent',
      reason: `Claimed by another active agent (${[...new Set(others.map((c) => c.agent_id))].join(', ')}).`,
      blocking: true,
      creates_claim: false,
      conflicting_claims: others,
    };
  }

  const stale = args.staleClaims.find((claim) => pathsOverlap(claim.path, args.normalized));
  if (stale) {
    return {
      ...base,
      status: 'stale_claim_overlap',
      reason: `Only a stale claim (${stale.claim_id}) overlaps; it does not block a new claim.`,
      blocking: false,
      creates_claim: true,
      stale_claim_id: stale.claim_id,
    };
  }

  if (!fileExists(args.repoRoot, args.normalized)) {
    return {
      ...base,
      status: 'missing',
      reason: 'No overlapping active claim; the file does not exist yet (claimable, e.g. a new file).',
      blocking: false,
      creates_claim: true,
    };
  }

  return {
    ...base,
    status: 'claimable',
    reason: 'No overlapping active claim.',
    blocking: false,
    creates_claim: true,
  };
}

/**
 * Evaluate an explicit list of paths against the supplied claims. Deterministic
 * dedupe: the FIRST occurrence of each normalized path wins; later duplicates
 * are dropped. Invalid paths (traversal, absolute, `.vibecode`/`.git`, empty)
 * are classified `invalid` rather than throwing, so a single bad path does not
 * hide the rest of the plan.
 */
export function evaluateClaimPaths(args: {
  repoRoot: string;
  agentId: string;
  inputPaths: readonly string[];
  activeClaims: readonly FileClaim[];
  staleClaims: readonly FileClaim[];
}): ClaimPathPlan[] {
  const seen = new Set<string>();
  const out: ClaimPathPlan[] = [];
  for (const raw of args.inputPaths) {
    const rawText = typeof raw === 'string' ? raw : String(raw);
    let normalized: string | null = null;
    let invalidReason: string | null = null;
    try {
      normalized = normalizeClaimPath(args.repoRoot, rawText);
    } catch (err) {
      invalidReason = err instanceof CoordinationError ? err.message : String(err);
    }

    const key = normalized ?? `__invalid__:${rawText.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (normalized === null) {
      out.push({
        input_path: rawText,
        path: rawText,
        status: 'invalid',
        reason: invalidReason ?? 'invalid claim path',
        blocking: true,
        creates_claim: false,
      });
      continue;
    }

    out.push(
      classifyExplicitPath({
        repoRoot: args.repoRoot,
        agentId: args.agentId,
        inputPath: rawText,
        normalized,
        activeClaims: args.activeClaims,
        staleClaims: args.staleClaims,
      }),
    );
  }
  return out;
}

/**
 * Resolve a build agent allowed to plan/claim. Throws {@link CoordinationError}
 * for an unknown id (`AGENT_NOT_FOUND`), an inactive session (`AGENT_NOT_ACTIVE`),
 * a read_only agent (`READ_ONLY_AGENT`), or a missing operating mode
 * (`INVALID_AGENT_MODE`). Shared by plan and bulk so both gate identically.
 */
export function resolveBuildClaimAgent(
  repoRoot: string,
  agentId: string,
  now: string,
): AgentSession {
  const ttlMs = HEARTBEAT_TTL_MS;
  const nowMs = Date.parse(now);
  const agents = listAgents(repoRoot, { now });
  const agent = requireClaimingAgent(agents, agentId, nowMs, ttlMs);
  requireBuildAgent(agent);
  return agent;
}

export interface ClaimPlanInput {
  repoRoot: string;
  agent_id: string;
  paths: string[];
  intent?: string;
  /** Clock seam (ISO-8601). */
  now?: string;
}

export interface ClaimPlanResult {
  agent_id: string;
  agent_mode: 'build';
  intent: string | null;
  atomic: true;
  can_claim_all: boolean;
  paths: ClaimPathPlan[];
  blocked_paths: string[];
  claimable_paths: string[];
  already_owned_paths: string[];
  warnings: string[];
  recommended_cli_commands: string[];
  checked_at: string;
}

/** Quote an intent for a CLI example without breaking on inner quotes. */
function cliIntent(intent: string | null): string {
  const text = (intent ?? '<intent>').replace(/"/g, "'");
  return `"${text}"`;
}

/**
 * Read-only plan: given an agent and an EXPLICIT list of paths, report whether
 * those exact paths can be safely claimed and what a bulk claim would do. Never
 * mutates state and never suggests paths the agent did not supply.
 */
export function planClaims(input: ClaimPlanInput): ClaimPlanResult {
  const now = input.now ?? new Date().toISOString();
  const agent = resolveBuildClaimAgent(input.repoRoot, input.agent_id, now);

  const paths = Array.isArray(input.paths) ? input.paths : [];
  if (paths.length === 0) {
    throw new CoordinationError('NO_CLAIM_PATHS', 'plan requires at least one explicit --path; Vibecode does not infer paths.');
  }

  const intent = typeof input.intent === 'string' && input.intent.trim().length > 0 ? input.intent.trim() : null;

  const allClaims = listFileClaims(input.repoRoot, { now });
  const activeClaims = allClaims.filter((c) => c.status === 'active');
  const staleClaims = allClaims.filter((c) => c.status !== 'active');

  const evaluated = evaluateClaimPaths({
    repoRoot: input.repoRoot,
    agentId: agent.agent_id,
    inputPaths: paths,
    activeClaims,
    staleClaims,
  });

  const canClaimAll = evaluated.every((e) => !e.blocking);
  const blocked = evaluated.filter((e) => e.blocking);
  const claimable = evaluated.filter((e) => e.creates_claim);
  const alreadyOwned = evaluated.filter((e) => e.status === 'already_claimed_by_agent');

  const warnings: string[] = [];
  const staleCount = evaluated.filter((e) => e.status === 'stale_claim_overlap').length;
  const missingCount = evaluated.filter((e) => e.status === 'missing').length;
  const generatedCount = evaluated.filter((e) => e.status === 'generated_or_ignored').length;
  const directoryCount = evaluated.filter((e) => e.status === 'directory_not_supported').length;
  const invalidCount = evaluated.filter((e) => e.status === 'invalid').length;
  if (directoryCount > 0) warnings.push(`${directoryCount} path(s) are existing directories and cannot be claimed; declare explicit file paths only.`);
  if (staleCount > 0) warnings.push(`${staleCount} path(s) overlap only a stale claim; claiming will create a fresh claim.`);
  if (missingCount > 0) warnings.push(`${missingCount} path(s) do not exist yet — claim them only if you intend to create them.`);
  if (generatedCount > 0) warnings.push(`${generatedCount} path(s) are generated/ignored and cannot be claimed.`);
  if (invalidCount > 0) warnings.push(`${invalidCount} path(s) are invalid (outside repo, traversal, or generated state).`);
  if (!canClaimAll) warnings.push('Not all paths can be claimed atomically; resolve the blocked paths or remove them before bulk claiming.');

  const recommended_cli_commands: string[] = [];
  if (canClaimAll && claimable.length > 0) {
    const pathFlags = claimable.map((e) => `--path ${e.path}`).join(' ');
    recommended_cli_commands.push(
      `vibecode claims add-bulk --agent ${agent.agent_id} --intent ${cliIntent(intent)} ${pathFlags} --json`,
    );
  } else if (!canClaimAll) {
    recommended_cli_commands.push(
      'vibecode claims list --json',
      'vibecode conflicts list --json',
    );
  }

  return {
    agent_id: agent.agent_id,
    agent_mode: 'build',
    intent,
    atomic: true,
    can_claim_all: canClaimAll,
    paths: evaluated,
    blocked_paths: blocked.map((e) => e.path),
    claimable_paths: claimable.map((e) => e.path),
    already_owned_paths: alreadyOwned.map((e) => e.path),
    warnings,
    recommended_cli_commands,
    checked_at: now,
  };
}
