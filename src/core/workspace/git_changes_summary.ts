import { listAgents } from '../coordination/agents.js';
import { listFileClaims } from '../coordination/claims.js';
import { classifyChangedPath } from '../coordination/path_classification.js';
import type { AgentSession, FileClaim } from '../coordination/types.js';
import {
  defaultGitReadOnlyRunner,
  type GitReadOnlyRunner,
} from './git_status.js';
import {
  getGitChangedFiles,
  isGeneratedOrIgnoredRuntimePath,
  type GitChangedFile,
  type GitChangeStatus,
} from './git_changed_files.js';

/**
 * Phase 1A — shared claim-aware git changes summary.
 *
 * This is the single source of truth for "what changed and who (advisorily)
 * owns it". It is reused by both the `vibecode_git_changes` MCP tool and the
 * `vibecode git changes` CLI command, and by `session_bootstrap` for its git
 * section. A later workspace/finalize/commit-alignment phase can reuse it too.
 *
 * Hard rules (mirroring the read-only git helpers it builds on):
 *   - NEVER mutates git or source state — only `git rev-parse`, `git status`,
 *     and `git diff --stat` (all read-only) are spawned;
 *   - never reads arbitrary source files and never exposes a full diff;
 *   - claim classification is advisory only — no source files are locked.
 *
 * It is NOT finalize. It warns and classifies; the finalize check / commit
 * guard remain the hard decision points.
 */

/** Default cap on the number of changed-file entries returned. */
export const DEFAULT_GIT_CHANGES_MAX_FILES = 50;

/**
 * Hard maximum for git_changes max_files. Core enforces this defensively so that
 * internal callers cannot accidentally request unbounded output. MCP/CLI
 * adapters also enforce it at the validation layer for user-facing rejection.
 */
export const GIT_CHANGES_MAX_FILES = 200;

/** Default byte cap on the bounded diff stat. */
export const DEFAULT_DIFF_STAT_MAX_BYTES = 4_000;

/** Coarse change category derived from porcelain status. A file may have several. */
export type GitChangeCategory =
  | 'staged'
  | 'unstaged'
  | 'untracked'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'generated_or_ignored';

/**
 * Claim-aware classification of a changed file.
 *   - `claimed_by_agent`               — covered by THIS agent's active claim,
 *   - `claimed_by_other_active_agent`  — covered by ANOTHER active agent's claim,
 *   - `unclaimed`                      — no active claim overlaps it,
 *   - `generated_or_ignored`           — Vibecode runtime / ignored path,
 *   - `stale_claim_overlap`            — only a stale/released claim overlaps it,
 *   - `unknown_without_agent_id`       — no agent context was supplied.
 */
export type GitChangeClassification =
  | 'claimed_by_agent'
  | 'claimed_by_other_active_agent'
  | 'unclaimed'
  | 'generated_or_ignored'
  | 'stale_claim_overlap'
  | 'unknown_without_agent_id';

export interface GitChangesFile {
  path: string;
  original_path?: string;
  status: GitChangeStatus;
  /** Raw porcelain `${index}${worktree}` status pair. */
  git_status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  categories: GitChangeCategory[];
  classification: GitChangeClassification;
  owning_claim_id?: string;
  owning_agent_id?: string;
  owning_agent_name?: string;
  stale_claim_id?: string;
}

export interface GitChangesSummaryCounts {
  changed_count: number;
  // categories
  staged: number;
  unstaged: number;
  untracked: number;
  deleted: number;
  renamed: number;
  copied: number;
  type_changed: number;
  generated_or_ignored: number;
  // classifications
  claimed_by_agent: number;
  claimed_by_other_active_agent: number;
  unclaimed: number;
  stale_claim_overlap: number;
  unknown_without_agent_id: number;
  /**
   * Phase 3B: unclaimed/stale-overlap changed files already STAGED in the git
   * index. The commit guard hard-blocks on these (STAGED_UNCLAIMED_FILES_BLOCKED),
   * so the runtime preflight needs the full-tree count, not a capped sample.
   */
  staged_unclaimed: number;
  /**
   * Phase 3 close: changed files claimed by ANOTHER active agent that are
   * already STAGED in the git index. The commit guard blocks on ANY staged file
   * outside the agent's committable set (GIT_INDEX_NOT_CLEAN), so the runtime
   * preflight must not report commit readiness while these exist.
   */
  staged_claimed_by_other_agent: number;
}

export type GitChangesWarningSeverity = 'info' | 'warning' | 'high';

export interface GitChangesWarning {
  code: string;
  severity: GitChangesWarningSeverity;
  message: string;
  path?: string;
}

export interface GitChangesSummary {
  ok: boolean;
  repo_root: string;
  head: string | null;
  dirty: boolean;
  /** Resolved agent id, or null when none was supplied. */
  agent_id: string | null;
  /** Resolved agent session when the supplied agent_id exists, else null. */
  agent: AgentSession | null;
  summary: GitChangesSummaryCounts;
  files: GitChangesFile[];
  /** Total number of changed files BEFORE the `maxFiles` cap. */
  total_changed: number;
  /** Number of changed files actually returned in `files`. */
  returned_changed: number;
  /** True when `files` was capped below `total_changed`. */
  truncated: boolean;
  /** Bounded `git diff --stat` text, or null when unavailable/disabled. */
  diff_stat: string | null;
  diff_stat_truncated: boolean;
  warnings: GitChangesWarning[];
  checked_at: string;
}

export interface GitChangesSummaryOptions {
  /** Advisory agent id to classify against. */
  agent_id?: string;
  /** Clock seam for stale computation (ISO-8601). */
  now?: string;
  /** Cap on number of changed-file entries returned (counts are unaffected). */
  maxFiles?: number;
  /** Include a bounded `git diff --stat` (default true). */
  includeDiffStat?: boolean;
  /** Test seam: read-only git runner used for status AND diff stat. */
  gitRunner?: GitReadOnlyRunner;
}

function emptyCounts(): GitChangesSummaryCounts {
  return {
    changed_count: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
    type_changed: 0,
    generated_or_ignored: 0,
    claimed_by_agent: 0,
    claimed_by_other_active_agent: 0,
    unclaimed: 0,
    stale_claim_overlap: 0,
    unknown_without_agent_id: 0,
    staged_unclaimed: 0,
    staged_claimed_by_other_agent: 0,
  };
}

function categoriesFor(changed: GitChangedFile, generated: boolean): GitChangeCategory[] {
  const categories: GitChangeCategory[] = [];
  if (changed.untracked) categories.push('untracked');
  if (changed.staged) categories.push('staged');
  if (changed.unstaged) categories.push('unstaged');
  if (changed.status === 'deleted') categories.push('deleted');
  if (changed.status === 'renamed') categories.push('renamed');
  if (changed.status === 'copied') categories.push('copied');
  if (changed.status === 'type_changed') categories.push('type_changed');
  if (generated) categories.push('generated_or_ignored');
  return categories;
}

function classifyFile(
  changed: GitChangedFile,
  agentId: string | undefined,
  activeClaims: FileClaim[],
  staleClaims: FileClaim[],
  agentNames: ReadonlyMap<string, string>,
): { classification: GitChangeClassification; owning?: FileClaim; ownerName?: string; staleId?: string } {
  if (isGeneratedOrIgnoredRuntimePath(changed.path)) {
    return { classification: 'generated_or_ignored' };
  }
  // No agent context → partial classification only.
  if (!agentId) {
    return { classification: 'unknown_without_agent_id' };
  }

  const classified = classifyChangedPath({
    path: changed.path,
    agentId,
    activeClaims,
    staleClaims,
    agentNames,
  });

  switch (classified.classification) {
    case 'claimed_by_agent':
    case 'claimed_by_other_active_agent': {
      const owning = activeClaims.find((c) => c.claim_id === classified.owning_claim_id);
      return {
        classification: classified.classification,
        owning,
        ownerName: classified.owning_agent_name,
      };
    }
    default: {
      // Unclaimed; a stale overlap is promoted to its own classification here so
      // git_changes can surface "a stale claim is in your way" distinctly.
      if (classified.stale_overlap_claim_id) {
        return { classification: 'stale_claim_overlap', staleId: classified.stale_overlap_claim_id };
      }
      return { classification: 'unclaimed' };
    }
  }
}

/** Capture a bounded `git diff --stat`. Read-only; returns null on any failure. */
function captureDiffStat(
  repoRoot: string,
  head: string | null,
  runner: GitReadOnlyRunner,
  maxBytes: number,
): { text: string | null; truncated: boolean } {
  // `git diff --stat HEAD` summarizes staged + unstaged tracked changes against
  // HEAD without emitting a patch body. For a repo with no commits we fall back
  // to the index/worktree-vs-empty stat.
  const args = head ? ['diff', '--stat', 'HEAD'] : ['diff', '--stat'];
  const result = runner(args, repoRoot);
  if (!result.ok) return { text: null, truncated: false };
  const raw = result.stdout;
  if (raw.trim().length === 0) return { text: null, truncated: false };
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length <= maxBytes) return { text: raw, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

/**
 * Build the claim-aware git changes summary for a repo. Read-only.
 *
 * When `agent_id` is omitted the classification is intentionally partial
 * (`unknown_without_agent_id`) and a warning is attached. When `agent_id` is
 * supplied, the agent's MODE/identity is read from the registered coordination
 * state (claims), never from a per-call override.
 */
export function getGitChangesSummary(
  repoRoot: string,
  options: GitChangesSummaryOptions = {},
): GitChangesSummary {
  const checkedAt = options.now ?? new Date().toISOString();
  const runner = options.gitRunner ?? defaultGitReadOnlyRunner;
  const rawMaxFiles = options.maxFiles ?? DEFAULT_GIT_CHANGES_MAX_FILES;
  if (rawMaxFiles > GIT_CHANGES_MAX_FILES) {
    throw new Error(
      `max_files ${rawMaxFiles} exceeds maximum ${GIT_CHANGES_MAX_FILES}`,
    );
  }
  const maxFiles = rawMaxFiles;
  const includeDiffStat = options.includeDiffStat !== false;
  const warnings: GitChangesWarning[] = [];

  const changedOutcome = getGitChangedFiles(repoRoot, runner);
  if (!changedOutcome.ok) {
    return {
      ok: false,
      repo_root: repoRoot,
      head: null,
      dirty: false,
      agent_id: options.agent_id ?? null,
      agent: null,
      summary: emptyCounts(),
      files: [],
      total_changed: 0,
      returned_changed: 0,
      truncated: false,
      diff_stat: null,
      diff_stat_truncated: false,
      warnings: changedOutcome.warnings.map((message) => ({
        code: 'GIT_CHANGED_FILES_FAILED',
        severity: 'high' as const,
        message,
      })),
      checked_at: checkedAt,
    };
  }

  // Resolve advisory agent + claims (read-only).
  const agents = listAgents(repoRoot, { now: checkedAt });
  const agentNames = new Map(agents.map((a) => [a.agent_id, a.agent_name] as const));
  const resolvedAgent = options.agent_id
    ? agents.find((a) => a.agent_id === options.agent_id) ?? null
    : null;
  if (options.agent_id && !resolvedAgent) {
    warnings.push({
      code: 'AGENT_NOT_FOUND',
      severity: 'high',
      message: `agent_id ${options.agent_id} is not a registered agent; classifying its dirty files against existing claims only.`,
    });
  }

  const allClaims = listFileClaims(repoRoot, { now: checkedAt }); // released excluded
  const activeClaims = allClaims.filter((c) => c.status === 'active');
  const staleClaims = allClaims.filter((c) => c.status !== 'active');

  const counts = emptyCounts();
  const files: GitChangesFile[] = [];

  for (const changed of changedOutcome.files) {
    const generated = isGeneratedOrIgnoredRuntimePath(changed.path);
    const categories = categoriesFor(changed, generated);
    const { classification, owning, ownerName, staleId } = classifyFile(
      changed,
      options.agent_id,
      activeClaims,
      staleClaims,
      agentNames,
    );

    const entry: GitChangesFile = {
      path: changed.path,
      ...(changed.original_path ? { original_path: changed.original_path } : {}),
      status: changed.status,
      git_status: `${changed.index_status}${changed.worktree_status}`,
      staged: changed.staged,
      unstaged: changed.unstaged,
      untracked: changed.untracked,
      categories,
      classification,
    };
    if (owning) {
      entry.owning_claim_id = owning.claim_id;
      entry.owning_agent_id = owning.agent_id;
      entry.owning_agent_name = ownerName ?? agentNames.get(owning.agent_id) ?? owning.agent_id;
    }
    if (staleId) entry.stale_claim_id = staleId;
    files.push(entry);

    // category counts
    if (changed.staged) counts.staged += 1;
    if (changed.unstaged) counts.unstaged += 1;
    if (changed.untracked) counts.untracked += 1;
    if (changed.status === 'deleted') counts.deleted += 1;
    if (changed.status === 'renamed') counts.renamed += 1;
    if (changed.status === 'copied') counts.copied += 1;
    if (changed.status === 'type_changed') counts.type_changed += 1;
    // classification counts
    counts[classification] += 1;
    // Phase 3B: staged unclaimed files hard-block the commit guard. Finalize
    // treats stale_claim_overlap as unclaimed, so it is included here.
    if ((classification === 'unclaimed' || classification === 'stale_claim_overlap') && changed.staged) {
      counts.staged_unclaimed += 1;
    }
    // A staged file claimed by another active agent also blocks the commit
    // guard (GIT_INDEX_NOT_CLEAN at index verification) even though finalize
    // only warns about it.
    if (classification === 'claimed_by_other_active_agent' && changed.staged) {
      counts.staged_claimed_by_other_agent += 1;
    }
  }
  counts.changed_count = files.length;

  // Advisory warnings.
  if (!options.agent_id && counts.changed_count - counts.generated_or_ignored > 0) {
    warnings.push({
      code: 'NO_AGENT_ID',
      severity: 'warning',
      message:
        'No agent_id supplied; claim classification is partial (unknown_without_agent_id). Register/pass an agent_id for full classification.',
    });
  }
  if (options.agent_id && counts.unclaimed > 0) {
    warnings.push({
      code: 'UNCLAIMED_DIRTY_FILES',
      severity: 'high',
      message: `${counts.unclaimed} changed source file(s) are not covered by an active claim for this agent. Claim them before editing/finalizing.`,
    });
  }
  if (options.agent_id && counts.stale_claim_overlap > 0) {
    warnings.push({
      code: 'STALE_CLAIM_OVERLAP',
      severity: 'warning',
      message: `${counts.stale_claim_overlap} changed file(s) overlap only a stale claim, which does not authorize edits.`,
    });
  }

  const total = files.length;
  const returned = files.slice(0, Math.max(0, maxFiles));
  const diff = includeDiffStat
    ? captureDiffStat(repoRoot, changedOutcome.head, runner, DEFAULT_DIFF_STAT_MAX_BYTES)
    : { text: null, truncated: false };

  return {
    ok: true,
    repo_root: changedOutcome.repo_root,
    head: changedOutcome.head,
    dirty: total > 0,
    agent_id: options.agent_id ?? null,
    agent: resolvedAgent,
    summary: counts,
    files: returned,
    total_changed: total,
    returned_changed: returned.length,
    truncated: returned.length < total,
    diff_stat: diff.text,
    diff_stat_truncated: diff.truncated,
    warnings,
    checked_at: checkedAt,
  };
}
