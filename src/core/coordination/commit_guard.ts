import fs from 'fs';
import path from 'path';

import { getFinalizeCheck, type FinalizeCheckResult } from './finalize_check.js';
import { getRunCoordinationPaths } from './agent_binding.js';
import { resolveExplicitRunDir } from '../runs/run_resolver.js';
import {
  commitWithMessage,
  listStagedFiles,
  revParseHead,
  stagePaths,
  defaultGitCommandRunner,
  type GitCommandRunner,
} from '../workspace/git_commit.js';
import { getAgentOperatingMode, getAgentTask } from './agent_operating_mode.js';
import { listAgents } from './agents.js';

/**
 * Phase 4B scoped commit guard — the first git-mutating coordination phase.
 *
 * Core truth: in one shared working tree Vibecode cannot know who physically
 * edited a file. So the guard commits ONLY the files the Phase 4A finalize check
 * classified as `claimed_by_agent`. It runs finalize first and refuses to commit
 * when finalize is blocked. Staging is always by explicit pathspec (never
 * `git add -A`); the index must contain nothing unrelated at entry; and the
 * guard never resets/stashes/cleans. All mutation is reversible by normal git
 * history.
 */

export interface CommitGuardInput {
  repoRoot: string;
  agent_id?: string;
  run_id?: string;
  message?: string;
  now?: Date | string;
  dry_run?: boolean;
  /** Test seam: inject the git mutation/read runner. Defaults to spawnSync git. */
  gitRunner?: GitCommandRunner;
}

export type CommitSkippedReason =
  | 'unclaimed'
  | 'claimed_by_other_agent'
  | 'generated_or_ignored'
  | 'not_changed'
  | 'unsupported_status';

export interface CommitSkippedFile {
  path: string;
  reason: CommitSkippedReason;
}

export type CommitGuardIssueCode =
  | 'FINALIZE_CHECK_BLOCKED'
  | 'NO_COMMITTABLE_FILES'
  | 'GIT_INDEX_NOT_CLEAN'
  | 'GIT_STAGED_FILES_FAILED'
  | 'GIT_STAGE_FAILED'
  | 'GIT_COMMIT_FAILED'
  | 'GIT_STATUS_CHANGED_DURING_COMMIT'
  | 'INVALID_COMMIT_MESSAGE'
  | 'INVALID_RUN_ID'
  | 'READ_ONLY_AGENT'
  | 'INVALID_AGENT_SESSION';

export interface CommitGuardIssue {
  code: CommitGuardIssueCode;
  severity: 'warning' | 'block';
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface CommitGuardResult {
  ok: boolean;
  status: 'committed' | 'blocked' | 'dry_run';
  agent_id: string | null;
  run_id: string | null;
  commit_hash: string | null;
  staged_files: string[];
  committed_files: string[];
  skipped_files: CommitSkippedFile[];
  finalize_check: FinalizeCheckResult;
  blocks: CommitGuardIssue[];
  warnings: CommitGuardIssue[];
}

function skippedReasonFor(classification: string): CommitSkippedReason {
  switch (classification) {
    case 'unclaimed':
      return 'unclaimed';
    case 'claimed_by_other_active_agent':
      return 'claimed_by_other_agent';
    case 'generated_or_ignored':
      return 'generated_or_ignored';
    default:
      return 'unsupported_status';
  }
}

function buildMessage(input: CommitGuardInput, agentId: string | null, runId: string | null): string {
  const provided = typeof input.message === 'string' ? input.message.trim() : '';
  const subject = provided.length > 0
    ? input.message as string
    : runId
      ? `chore(vibecode): commit run ${runId} for agent ${agentId ?? 'unknown'}`
      : `chore(vibecode): commit changes for agent ${agentId ?? 'unknown'}`;

  const footer: string[] = [];
  if (runId) footer.push(`Vibecode-Run: ${runId}`);
  if (agentId) footer.push(`Vibecode-Agent: ${agentId}`);
  return footer.length > 0 ? `${subject}\n\n${footer.join('\n')}` : subject;
}

function writeArtifact(repoRoot: string, runId: string, result: CommitGuardResult): void {
  try {
    const { runDir } = resolveExplicitRunDir(repoRoot, runId);
    const { dir } = getRunCoordinationPaths(runDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'commit_guard.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } catch {
    // Best-effort generated state; never fail a real commit over the artifact.
  }
}

/**
 * Run the scoped commit guard. Read finalize check, then (unless dry-run) stage
 * and commit ONLY the agent's claimed changed files.
 */
export function runCommitGuard(input: CommitGuardInput): CommitGuardResult {
  const runner = input.gitRunner ?? defaultGitCommandRunner;

  const earlyBase = (over: Partial<CommitGuardResult>): CommitGuardResult => ({
    ok: true,
    status: 'blocked',
    agent_id: input.agent_id ?? null,
    run_id: input.run_id ?? null,
    commit_hash: null,
    staged_files: [],
    committed_files: [],
    skipped_files: [],
    finalize_check: null as unknown as FinalizeCheckResult,
    blocks: [],
    warnings: [],
    ...over,
  });

  // Validate a caller-supplied commit message before any git work.
  if (input.message !== undefined && input.message.trim().length === 0) {
    return earlyBase({
      ok: false,
      blocks: [{ code: 'INVALID_COMMIT_MESSAGE', severity: 'block', message: 'commit message must not be empty or whitespace-only.' }],
    });
  }

  // Direct operating mode check: block non-build or invalid-mode agents BEFORE
  // any finalize check or git staging. This is the hard safety path.
  if (input.agent_id) {
    const agents = listAgents(input.repoRoot);
    const agent = agents.find((a) => a.agent_id === input.agent_id);
    if (agent) {
      const mode = getAgentOperatingMode(agent);
      const task = getAgentTask(agent);
      if (mode === null || task === null) {
        return earlyBase({
          ok: false,
          blocks: [{
            code: 'INVALID_AGENT_SESSION',
            severity: 'block',
            message: `Agent ${input.agent_id} is missing required session metadata (${mode === null ? 'operating_mode' : ''}${mode === null && task === null ? ', ' : ''}${task === null ? 'task' : ''}). Cannot commit.`,
            details: { agent_id: input.agent_id, operating_mode: mode, task },
          }],
        });
      }
      if (mode === 'read_only') {
        return earlyBase({
          ok: false,
          blocks: [{
            code: 'READ_ONLY_AGENT',
            severity: 'block',
            message: `Agent ${input.agent_id} is operating in read_only mode and cannot commit. Only build agents may stage and commit files.`,
            details: { agent_id: input.agent_id, operating_mode: mode },
          }],
        });
      }
    }
  }

  const finalize = getFinalizeCheck({
    repoRoot: input.repoRoot,
    agent_id: input.agent_id,
    run_id: input.run_id,
    now: input.now,
  });

  const agentId = finalize.agent?.agent_id ?? input.agent_id ?? null;
  const runId = finalize.run_id ?? input.run_id ?? null;

  const base = (over: Partial<CommitGuardResult>): CommitGuardResult => ({
    ok: true,
    status: 'blocked',
    agent_id: agentId,
    run_id: runId,
    commit_hash: null,
    staged_files: [],
    committed_files: [],
    skipped_files: [],
    finalize_check: finalize,
    blocks: [],
    warnings: [],
    ...over,
  });

  // Validate a caller-supplied commit message before any git work.
  if (input.message !== undefined && input.message.trim().length === 0) {
    return base({
      ok: false,
      blocks: [{ code: 'INVALID_COMMIT_MESSAGE', severity: 'block', message: 'commit message must not be empty or whitespace-only.' }],
    });
  }

  // Finalize check could not even resolve an agent → invocation failure.
  if (!finalize.ok) {
    const finalizeBlock = finalize.blocks[0];
    const code = finalizeBlock?.code === 'INVALID_RUN_ID' ? 'INVALID_RUN_ID' : 'FINALIZE_CHECK_BLOCKED';
    return base({
      ok: false,
      blocks: [{
        code,
        severity: 'block',
        message: finalizeBlock?.message ?? 'finalize check could not resolve an agent.',
      }],
    });
  }

  if (finalize.status === 'blocked') {
    const result = base({
      blocks: [{
        code: 'FINALIZE_CHECK_BLOCKED',
        severity: 'block',
        message: 'Finalize check is blocked; resolve the reported files before committing.',
        details: { finalize_blocks: finalize.blocks.map((b) => b.code) },
      }],
    });
    if (runId) writeArtifact(input.repoRoot, runId, result);
    return result;
  }

  const committable = finalize.changed_files
    .filter((f) => f.classification === 'claimed_by_agent')
    .map((f) => f.path);
  const skipped: CommitSkippedFile[] = finalize.changed_files
    .filter((f) => f.classification !== 'claimed_by_agent')
    .map((f) => ({ path: f.path, reason: skippedReasonFor(f.classification) }));

  if (committable.length === 0) {
    const result = base({
      skipped_files: skipped,
      blocks: [{ code: 'NO_COMMITTABLE_FILES', severity: 'block', message: 'No changed files are covered by this agent’s active claims.' }],
    });
    if (runId) writeArtifact(input.repoRoot, runId, result);
    return result;
  }

  const committableSet = new Set(committable);

  // The index must not carry anything we did not stage this run. In a shared
  // working tree a pre-existing staged file may belong to another agent/user.
  const stagedAtEntry = listStagedFiles(input.repoRoot, runner);
  if (!stagedAtEntry.ok) {
    const result = base({
      skipped_files: skipped,
      blocks: [{
        code: 'GIT_STAGED_FILES_FAILED',
        severity: 'block',
        message: `Unable to verify staged files before commit: ${stagedAtEntry.stderr.trim() || 'git diff --cached failed'}`,
      }],
    });
    if (runId) writeArtifact(input.repoRoot, runId, result);
    return result;
  }
  const unrelated = stagedAtEntry.files.filter((f) => !committableSet.has(f));
  if (unrelated.length > 0) {
    const result = base({
      skipped_files: skipped,
      blocks: [{
        code: 'GIT_INDEX_NOT_CLEAN',
        severity: 'block',
        message: 'The git index already contains staged files that are not part of this agent’s committable set. Commit or unstage them yourself first.',
        details: { unrelated_staged: unrelated },
      }],
    });
    if (runId) writeArtifact(input.repoRoot, runId, result);
    return result;
  }

  if (input.dry_run === true) {
    const result = base({ status: 'dry_run', staged_files: committable, skipped_files: skipped });
    return result;
  }

  // Stage exactly the committable paths (explicit pathspecs, never -A).
  const staged = stagePaths(input.repoRoot, committable, runner);
  if (!staged.ok) {
    const result = base({
      skipped_files: skipped,
      blocks: [{ code: 'GIT_STAGE_FAILED', severity: 'block', message: `git add failed: ${staged.stderr.trim()}` }],
    });
    if (runId) writeArtifact(input.repoRoot, runId, result);
    return result;
  }

  // Verify the index is exactly the intended set — no more, no less.
  const stagedNow = listStagedFiles(input.repoRoot, runner);
  if (!stagedNow.ok) {
    const result = base({
      skipped_files: skipped,
      blocks: [{
        code: 'GIT_STAGED_FILES_FAILED',
        severity: 'block',
        message: `Unable to verify staged files after staging: ${stagedNow.stderr.trim() || 'git diff --cached failed'}`,
      }],
    });
    if (runId) writeArtifact(input.repoRoot, runId, result);
    return result;
  }
  const stagedNowFiles = stagedNow.files;
  const unexpected = stagedNowFiles.filter((f) => !committableSet.has(f));
  const missing = committable.filter((f) => !stagedNowFiles.includes(f));
  if (unexpected.length > 0 || missing.length > 0) {
    const result = base({
      staged_files: stagedNowFiles,
      skipped_files: skipped,
      blocks: [{
        code: 'GIT_STATUS_CHANGED_DURING_COMMIT',
        severity: 'block',
        message: 'The staged set does not match the intended committable set; aborting before commit.',
        details: { unexpected, missing },
      }],
    });
    if (runId) writeArtifact(input.repoRoot, runId, result);
    return result;
  }

  const message = buildMessage(input, agentId, runId);
  const committed = commitWithMessage(input.repoRoot, message, runner);
  if (!committed.ok) {
    const result = base({
      staged_files: stagedNowFiles,
      skipped_files: skipped,
      blocks: [{ code: 'GIT_COMMIT_FAILED', severity: 'block', message: `git commit failed: ${committed.stderr.trim()}` }],
    });
    if (runId) writeArtifact(input.repoRoot, runId, result);
    return result;
  }

  const commitHash = revParseHead(input.repoRoot, runner);
  const result = base({
    status: 'committed',
    commit_hash: commitHash,
    staged_files: stagedNowFiles,
    committed_files: committable,
    skipped_files: skipped,
  });
  if (runId) writeArtifact(input.repoRoot, runId, result);
  return result;
}
