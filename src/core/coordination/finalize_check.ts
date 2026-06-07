import { LlmAdapterError } from '../../adapters/llm/errors.js';
import { listAgents } from './agents.js';
import { readAgentBinding } from './agent_binding.js';
import { listFileClaims } from './claims.js';
import { resolveExplicitRunDir } from '../runs/run_resolver.js';
import {
  getGitChangedFiles,
  isGeneratedOrIgnoredRuntimePath,
  type GitChangedFile,
} from '../workspace/git_changed_files.js';
import type { AgentSession, FileClaim } from './types.js';

/**
 * Phase 4A — agent-aware finalize check (read-only).
 *
 * Core truth: in one shared working tree (no git worktrees) Vibecode cannot know
 * which agent physically edited a file. So this check never claims "agent A
 * changed file X". It only classifies the dirty working tree RELATIVE to the
 * current agent's active advisory claims:
 *
 *   - allowed                       — covered by THIS agent's active claim,
 *   - claimed_by_other_active_agent — covered by ANOTHER active agent's claim,
 *   - unclaimed                     — no active claim overlaps it,
 *   - generated_or_ignored          — Vibecode runtime / ignored path.
 *
 * It reuses the read-only `getGitChangedFiles` helper and the advisory claim /
 * agent services. It performs NO git mutation, writes nothing, and is not a
 * commit guard or a watcher — those remain later phases.
 */

export interface FinalizeCheckInput {
  repoRoot: string;
  agent_id?: string;
  run_id?: string;
  /** Clock seam for stale computation. Accepts an ISO string or a Date. */
  now?: Date | string;
}

export type FinalizeChangedFileClassification =
  | 'claimed_by_agent'
  | 'claimed_by_other_active_agent'
  | 'unclaimed'
  | 'generated_or_ignored'
  | 'unknown';

export interface FinalizeChangedFile {
  path: string;
  original_path?: string;
  git_status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  classification: FinalizeChangedFileClassification;
  owning_claim_id?: string;
  owning_agent_id?: string;
  owning_agent_name?: string;
  reason: string;
}

export type FinalizeIssueCode =
  | 'AGENT_NOT_FOUND'
  | 'AGENT_NOT_ACTIVE'
  | 'RUN_AGENT_MISMATCH'
  | 'RUN_BINDING_NOT_FOUND'
  | 'INVALID_RUN_ID'
  | 'UNCLAIMED_CHANGED_FILE'
  | 'FILE_CLAIMED_BY_OTHER_AGENT'
  | 'STALE_AGENT_CLAIM'
  | 'NO_ACTIVE_CLAIMS'
  | 'GIT_CHANGED_FILES_FAILED';

export interface FinalizeIssue {
  code: FinalizeIssueCode;
  severity: 'warning' | 'block';
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface FinalizeCheckSummary {
  changed_count: number;
  allowed_count: number;
  unclaimed_count: number;
  other_claimed_count: number;
  generated_ignored_count: number;
}

export interface FinalizeCheckResult {
  ok: boolean;
  status: 'ok' | 'warning' | 'blocked';
  agent: AgentSession | null;
  run_id: string | null;
  checked_at: string;
  changed_files: FinalizeChangedFile[];
  blocks: FinalizeIssue[];
  warnings: FinalizeIssue[];
  summary: FinalizeCheckSummary;
}

function toIso(now: Date | string | undefined): string {
  if (typeof now === 'string') return now;
  if (now instanceof Date) return now.toISOString();
  return new Date().toISOString();
}

/** Repo-relative POSIX path overlap: equal, or one is a directory prefix of the other. */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function emptySummary(): FinalizeCheckSummary {
  return {
    changed_count: 0,
    allowed_count: 0,
    unclaimed_count: 0,
    other_claimed_count: 0,
    generated_ignored_count: 0,
  };
}

function blockedResult(args: {
  block: FinalizeIssue;
  agent: AgentSession | null;
  runId: string | null;
  checkedAt: string;
  ok?: boolean;
}): FinalizeCheckResult {
  return {
    ok: args.ok ?? true,
    status: 'blocked',
    agent: args.agent,
    run_id: args.runId,
    checked_at: args.checkedAt,
    changed_files: [],
    blocks: [args.block],
    warnings: [],
    summary: emptySummary(),
  };
}

interface AgentResolution {
  agent: AgentSession | null;
  runId: string | null;
  block?: FinalizeIssue;
  /** When set, the resolution failure should be reported as an invocation failure (ok:false). */
  invocationFailure?: boolean;
}

function resolveAgent(input: FinalizeCheckInput, agents: AgentSession[]): AgentResolution {
  let runId = input.run_id ?? null;
  let boundAgentId: string | null = null;

  if (runId) {
    let runDir: string;
    let resolvedRunId = runId;
    try {
      const resolved = resolveExplicitRunDir(input.repoRoot, runId);
      runDir = resolved.runDir;
      resolvedRunId = resolved.runId;
    } catch (error) {
      if (error instanceof LlmAdapterError && error.code === 'INVALID_RUN_ID') {
        return {
          agent: null,
          runId,
          invocationFailure: true,
          block: {
            code: 'INVALID_RUN_ID',
            severity: 'block',
            message: error.message,
            details: { run_id: runId, details: error.details },
          },
        };
      }
      throw error;
    }
    const binding = readAgentBinding(runDir);
    if (!binding || !binding.agent_id) {
      return {
        agent: null,
        runId: resolvedRunId,
        block: {
          code: 'RUN_BINDING_NOT_FOUND',
          severity: 'block',
          message: `No run/agent binding with an agent_id was found for run ${resolvedRunId}.`,
          details: { run_id: resolvedRunId },
        },
      };
    }
    runId = resolvedRunId;
    boundAgentId = binding.agent_id;
  }

  if (input.agent_id && boundAgentId && input.agent_id !== boundAgentId) {
    return {
      agent: null,
      runId,
      block: {
        code: 'RUN_AGENT_MISMATCH',
        severity: 'block',
        message: `--agent ${input.agent_id} does not match the agent bound to run ${runId} (${boundAgentId}).`,
        details: { agent_id: input.agent_id, run_agent_id: boundAgentId, run_id: runId },
      },
    };
  }

  const effectiveAgentId = input.agent_id ?? boundAgentId;
  if (!effectiveAgentId) {
    return {
      agent: null,
      runId,
      invocationFailure: true,
      block: {
        code: 'AGENT_NOT_FOUND',
        severity: 'block',
        message: 'finalize check requires an agent_id or a run_id that resolves to an agent.',
      },
    };
  }

  const agent = agents.find((candidate) => candidate.agent_id === effectiveAgentId) ?? null;
  if (!agent) {
    return {
      agent: null,
      runId,
      block: {
        code: 'AGENT_NOT_FOUND',
        severity: 'block',
        message: `Agent not found: ${effectiveAgentId}`,
        details: { agent_id: effectiveAgentId },
      },
    };
  }

  if (agent.status !== 'active' && agent.status !== 'idle') {
    return {
      agent,
      runId,
      block: {
        code: 'AGENT_NOT_ACTIVE',
        severity: 'block',
        message: `Agent cannot finalize while status is ${agent.status}.`,
        details: { agent_id: agent.agent_id, status: agent.status },
      },
    };
  }

  return { agent, runId };
}

function classifyFile(
  changed: GitChangedFile,
  agentId: string,
  activeClaims: FileClaim[],
  staleClaims: FileClaim[],
  agentNames: Map<string, string>,
): { file: FinalizeChangedFile; block?: FinalizeIssue; warning?: FinalizeIssue } {
  const base = {
    path: changed.path,
    ...(changed.original_path ? { original_path: changed.original_path } : {}),
    git_status: `${changed.index_status}${changed.worktree_status}`,
    staged: changed.staged,
    unstaged: changed.unstaged,
    untracked: changed.untracked,
  };

  if (isGeneratedOrIgnoredRuntimePath(changed.path)) {
    return {
      file: {
        ...base,
        classification: 'generated_or_ignored',
        reason: 'Generated/ignored Vibecode runtime path; not subject to advisory claims.',
      },
    };
  }

  const ownClaim = activeClaims.find(
    (claim) => claim.agent_id === agentId && pathsOverlap(claim.path, changed.path),
  );
  if (ownClaim) {
    return {
      file: {
        ...base,
        classification: 'claimed_by_agent',
        owning_claim_id: ownClaim.claim_id,
        owning_agent_id: agentId,
        owning_agent_name: agentNames.get(agentId) ?? agentId,
        reason: `Covered by this agent's active claim on ${ownClaim.path}.`,
      },
    };
  }

  const otherClaim = activeClaims.find(
    (claim) => claim.agent_id !== agentId && pathsOverlap(claim.path, changed.path),
  );
  if (otherClaim) {
    const ownerName = agentNames.get(otherClaim.agent_id) ?? otherClaim.agent_id;
    return {
      file: {
        ...base,
        classification: 'claimed_by_other_active_agent',
        owning_claim_id: otherClaim.claim_id,
        owning_agent_id: otherClaim.agent_id,
        owning_agent_name: ownerName,
        reason: `Covered by an active claim held by another agent (${ownerName}).`,
      },
      block: {
        code: 'FILE_CLAIMED_BY_OTHER_AGENT',
        severity: 'block',
        message: `Changed file ${changed.path} is claimed by another active agent (${ownerName}).`,
        path: changed.path,
        details: { owning_agent_id: otherClaim.agent_id, owning_claim_id: otherClaim.claim_id },
      },
    };
  }

  // Unclaimed. A stale claim may overlap it — surface that as a warning, but it
  // never authorizes finalize.
  const staleOverlap = staleClaims.find((claim) => pathsOverlap(claim.path, changed.path));
  const result: { file: FinalizeChangedFile; block?: FinalizeIssue; warning?: FinalizeIssue } = {
    file: {
      ...base,
      classification: 'unclaimed',
      reason: 'No active claim covers this changed file.',
    },
    block: {
      code: 'UNCLAIMED_CHANGED_FILE',
      severity: 'block',
      message: `Changed file ${changed.path} is not covered by an active claim for this agent.`,
      path: changed.path,
    },
  };
  if (staleOverlap) {
    result.warning = {
      code: 'STALE_AGENT_CLAIM',
      severity: 'warning',
      message: `A stale claim (${staleOverlap.claim_id}) overlaps ${changed.path} but does not authorize finalize.`,
      path: changed.path,
      details: { stale_claim_id: staleOverlap.claim_id, stale_agent_id: staleOverlap.agent_id },
    };
  }
  return result;
}

/**
 * Classify the dirty working tree relative to the resolved agent's active
 * advisory claims. Read-only: never mutates git or coordination state.
 */
export function getFinalizeCheck(input: FinalizeCheckInput): FinalizeCheckResult {
  const checkedAt = toIso(input.now);
  const readOptions = { now: checkedAt };

  const agents = listAgents(input.repoRoot, readOptions);
  const resolution = resolveAgent(input, agents);
  if (resolution.block) {
    return blockedResult({
      block: resolution.block,
      agent: resolution.agent,
      runId: resolution.runId,
      checkedAt,
      ok: resolution.invocationFailure ? false : true,
    });
  }

  const agent = resolution.agent as AgentSession;

  const changedOutcome = getGitChangedFiles(input.repoRoot);
  if (!changedOutcome.ok) {
    return blockedResult({
      block: {
        code: 'GIT_CHANGED_FILES_FAILED',
        severity: 'block',
        message: `Unable to read git changed files: ${changedOutcome.warnings.join('; ')}`,
        details: { warnings: changedOutcome.warnings },
      },
      agent,
      runId: resolution.runId,
      checkedAt,
    });
  }

  const allClaims = listFileClaims(input.repoRoot, readOptions); // released excluded
  const activeClaims = allClaims.filter((claim) => claim.status === 'active');
  const staleClaims = allClaims.filter((claim) => claim.status !== 'active');
  const agentNames = new Map(agents.map((a) => [a.agent_id, a.agent_name]));

  const changed_files: FinalizeChangedFile[] = [];
  const blocks: FinalizeIssue[] = [];
  const warnings: FinalizeIssue[] = [];
  const summary = emptySummary();

  for (const changed of changedOutcome.files) {
    const { file, block, warning } = classifyFile(changed, agent.agent_id, activeClaims, staleClaims, agentNames);
    changed_files.push(file);
    if (block) blocks.push(block);
    if (warning) warnings.push(warning);
    switch (file.classification) {
      case 'claimed_by_agent':
        summary.allowed_count += 1;
        break;
      case 'claimed_by_other_active_agent':
        summary.other_claimed_count += 1;
        break;
      case 'unclaimed':
        summary.unclaimed_count += 1;
        break;
      case 'generated_or_ignored':
        summary.generated_ignored_count += 1;
        break;
      default:
        break;
    }
  }
  summary.changed_count = changed_files.length;

  const nonGenerated = summary.changed_count - summary.generated_ignored_count;
  const agentHasActiveClaims = activeClaims.some((claim) => claim.agent_id === agent.agent_id);
  if (nonGenerated > 0 && !agentHasActiveClaims) {
    warnings.push({
      code: 'NO_ACTIVE_CLAIMS',
      severity: 'warning',
      message: 'This agent holds no active claims while the working tree has non-generated changes.',
    });
  }

  const status: FinalizeCheckResult['status'] =
    blocks.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'ok';

  return {
    ok: true,
    status,
    agent,
    run_id: resolution.runId,
    checked_at: checkedAt,
    changed_files,
    blocks,
    warnings,
    summary,
  };
}
