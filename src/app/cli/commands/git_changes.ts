import path from 'path';

import { Command } from 'commander';

import {
  getGitChangesSummary,
  GIT_CHANGES_MAX_FILES,
  type GitChangesSummary,
} from '../../../core/workspace/git_changes_summary.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface GitChangesCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

/**
 * Register `vibecode git …` commands (Phase 1A).
 *
 * Ships the `changes` subcommand: a thin wrapper over the shared core service
 * (`core/workspace/git_changes_summary`) — the same service the MCP tool
 * `vibecode_git_changes` uses — so CLI and MCP return equivalent data. It is
 * read-only: it lists changed files with categories + advisory claim
 * classification, counts/truncation metadata, and a bounded diff stat. It
 * exposes no full diff and never mutates git. It is NOT finalize.
 */
export function registerGitChangesCommands(
  program: Command,
  dependencies: GitChangesCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const git = program
    .command('git')
    .description('Read-only git inspection for coordinating agents (advisory; never mutates git)');

  git
    .command('changes')
    .description('Claim-aware changed-files summary with categories, classification, counts, and a bounded diff stat')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Active agent id for claim-aware classification')
    .option('--max-files <n>', 'Cap on the number of changed-file entries returned')
    .option('--no-diff-stat', 'Skip the bounded diff stat')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: {
      repo: string;
      agent?: string;
      maxFiles?: string;
      diffStat?: boolean;
      json?: boolean;
    }) => {
      const repoRoot = path.resolve(options.repo);

      // Strict numeric validation for --max-files.
      let maxFiles: number | undefined;
      if (options.maxFiles !== undefined) {
        const raw = Number(options.maxFiles);
        if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
          emitCliStructuredError(
            makeCliStructuredError(
              'INVALID_ARGUMENT',
              `invalid --max-files: expected a positive integer, got ${JSON.stringify(options.maxFiles)}`,
              repoRoot,
            ),
            { json: options.json, prefix: 'git changes failed' },
          );
          return;
        }
        if (raw > GIT_CHANGES_MAX_FILES) {
          emitCliStructuredError(
            makeCliStructuredError(
              'INVALID_ARGUMENT',
              `invalid --max-files: value ${raw} exceeds maximum ${GIT_CHANGES_MAX_FILES}`,
              repoRoot,
            ),
            { json: options.json, prefix: 'git changes failed' },
          );
          return;
        }
        maxFiles = raw;
      }

      let result: GitChangesSummary;
      try {
        result = getGitChangesSummary(repoRoot, {
          agent_id: options.agent,
          maxFiles,
          includeDiffStat: options.diffStat !== false,
        });
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError(
            'GIT_CHANGES_FAILED',
            error instanceof Error ? error.message : String(error),
            repoRoot,
          ),
          { json: options.json, prefix: 'git changes failed' },
        );
        return;
      }

      if (!result.ok) {
        emitCliStructuredError(
          makeCliStructuredError(
            'GIT_CHANGES_FAILED',
            result.warnings[0]?.message ?? 'unable to read git changed files',
            repoRoot,
          ),
          { json: options.json, prefix: 'git changes failed' },
        );
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: result,
          artifacts: [],
          warnings: result.warnings.map((w) => `${w.code}: ${w.message}`),
        }));
        return;
      }

      printHuman(result);
    });
}

function printHuman(result: GitChangesSummary): void {
  console.log(`repo_root: ${result.repo_root}`);
  console.log(`head: ${result.head ?? '(none)'} dirty=${result.dirty ? 'yes' : 'no'}`);
  console.log(`agent: ${result.agent_id ?? '(none — partial classification)'}`);
  const s = result.summary;
  console.log(
    `changed=${s.changed_count} staged=${s.staged} unstaged=${s.unstaged} untracked=${s.untracked} deleted=${s.deleted} renamed=${s.renamed}`,
  );
  console.log(
    `classified: claimed_by_agent=${s.claimed_by_agent} other_active=${s.claimed_by_other_active_agent} unclaimed=${s.unclaimed} stale_overlap=${s.stale_claim_overlap} generated=${s.generated_or_ignored} unknown_no_agent=${s.unknown_without_agent_id}`,
  );
  if (result.truncated) {
    console.log(`(showing ${result.returned_changed} of ${result.total_changed} changed files)`);
  }
  if (result.files.length > 0) {
    console.log('files:');
    for (const f of result.files) {
      console.log(`  ${f.path} [${f.classification}] (${f.categories.join(',')})`);
    }
  }
  if (result.diff_stat) {
    console.log('diff_stat:');
    console.log(result.diff_stat.trimEnd());
  }
  if (result.warnings.length > 0) {
    console.log('warnings:');
    for (const w of result.warnings) console.log(`  [${w.severity}/${w.code}] ${w.message}`);
  }
}
