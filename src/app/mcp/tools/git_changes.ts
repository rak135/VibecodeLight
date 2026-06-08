import {
  getGitChangesSummary,
  type GitChangesSummary,
} from '../../../core/workspace/git_changes_summary.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateBoolean,
  validateBoundedInteger,
  validateNonEmptyString,
  GIT_CHANGES_INPUT_SCHEMA,
  HARD_MAX_GIT_CHANGES_FILES,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

/**
 * Phase 1A — `vibecode_git_changes`.
 *
 * Claim-aware changed-files summary for the bound repo. Thin wrapper over the
 * shared core service (`core/workspace/git_changes_summary`) — the same service
 * the `vibecode git changes` CLI command uses, so MCP and CLI return equivalent
 * data. Read-only: lists changed files with categories and an advisory claim
 * classification, a bounded diff stat, counts and truncation metadata. It never
 * exposes a full diff, never reads arbitrary source files, and never mutates
 * git. It is NOT finalize — it warns and classifies; finalize stays the hard
 * decision point.
 */
const TOOL_NAME = 'vibecode_git_changes';
const ALLOWED_KEYS = new Set(['agent_id', 'max_files', 'include_diff_stat']);

function renderText(result: GitChangesSummary): string {
  const lines: string[] = ['# Vibecode git changes', ''];
  lines.push(`repo_root: ${result.repo_root}`);
  lines.push(`head: ${result.head ?? '(none)'} dirty=${result.dirty ? 'yes' : 'no'}`);
  lines.push(`agent: ${result.agent_id ?? '(none — partial classification)'}`);
  const s = result.summary;
  lines.push(
    `changed=${s.changed_count} staged=${s.staged} unstaged=${s.unstaged} untracked=${s.untracked} deleted=${s.deleted} renamed=${s.renamed}`,
  );
  lines.push(
    `classified: claimed_by_agent=${s.claimed_by_agent} other_active=${s.claimed_by_other_active_agent} unclaimed=${s.unclaimed} stale_overlap=${s.stale_claim_overlap} generated=${s.generated_or_ignored} unknown_no_agent=${s.unknown_without_agent_id}`,
  );
  if (result.truncated) lines.push(`(showing ${result.returned_changed} of ${result.total_changed} changed files)`);
  if (result.files.length > 0) {
    lines.push('', 'files:');
    for (const f of result.files) {
      lines.push(`  - ${f.path} [${f.classification}] (${f.categories.join(',')})`);
    }
  }
  if (result.diff_stat) {
    lines.push('', 'diff_stat:', result.diff_stat.trimEnd());
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const w of result.warnings) lines.push(`  - [${w.severity}/${w.code}] ${w.message}`);
  }
  lines.push('', 'Advisory — not a commit guard. Claim files before editing; run finalize before commit.');
  return lines.join('\n');
}

export function buildGitChangesTool(): McpToolDefinition {
  const inputSchema: JsonSchema = GIT_CHANGES_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode git changes',
    description:
      'Claim-aware changed-files summary for the bound repo: per-file category (staged/unstaged/untracked/deleted/renamed/…) and advisory claim classification (claimed_by_agent / claimed_by_other_active_agent / unclaimed / stale_claim_overlap / generated_or_ignored), counts + truncation metadata, and a bounded diff stat. Pass agent_id for full classification. Read-only — no full diffs, no git mutation; not a commit guard.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = (code: McpErrorCode, message: string): McpToolFormattedResult =>
        formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(code, message),
        });

      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);

      const args = input.arguments ?? {};
      const agentId = args.agent_id === undefined || args.agent_id === null
        ? undefined
        : validateNonEmptyString(args.agent_id, 'agent_id');
      if (agentId && !agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);
      const maxFiles = validateBoundedInteger(args.max_files, 'max_files', HARD_MAX_GIT_CHANGES_FILES);
      if (!maxFiles.ok) return fail('INVALID_ARGUMENT', maxFiles.message);
      const includeDiffStat = validateBoolean(args.include_diff_stat, 'include_diff_stat');
      if (!includeDiffStat.ok) return fail('INVALID_ARGUMENT', includeDiffStat.message);

      try {
        const result = getGitChangesSummary(input.context.repoRoot, {
          agent_id: agentId ? agentId.value : undefined,
          maxFiles: maxFiles.value,
          includeDiffStat: includeDiffStat.value !== false,
        });
        if (!result.ok) {
          return fail('GIT_CHANGES_FAILED', result.warnings[0]?.message ?? 'unable to read git changed files');
        }
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderText(result),
          data: result,
          warnings: result.warnings.map((w) => `${w.code}: ${w.message}`),
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('GIT_CHANGES_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
