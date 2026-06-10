import path from 'path';

import { Command } from 'commander';

import {
  runCommitGuard,
  type CommitGuardResult,
} from '../../../core/coordination/commit_guard.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface CommitCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

/**
 * Register `vibecode commit …` commands.
 *
 * Phase 4B ships the `guard` subcommand: a scoped commit guard that commits ONLY
 * the files the finalize check classified as claimed_by_agent. It is a thin
 * wrapper over the shared core service (`core/coordination/commit_guard`). It is
 * intentionally CLI-only — VibecodeMCP has no git/source/commit mutation tool.
 * The guard never uses `git add -A`, never resets/stashes, and blocks when the
 * index already contains unrelated staged files.
 */
export function registerCommitCommands(
  program: Command,
  dependencies: CommitCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const commit = program
    .command('commit')
    .description('Multi-agent coordination: scoped commit guard (commits only your claimed files)');

  commit
    .command('guard')
    .description('Create a scoped commit for an agent’s claimed changes, gated by the finalize check')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Coordinating agent id')
    .option('--run <run_id>', 'Run id whose agent_binding.json resolves the agent')
    .option('--message <message>', 'Commit message subject (a Vibecode-Run/Agent footer is appended)')
    .option('--dry-run', 'Report which files would be staged without staging or committing')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; run?: string; message?: string; dryRun?: boolean; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);

      if (!options.agent && !options.run) {
        emitCliStructuredError(
          makeCliStructuredError(
            'INVALID_ARGUMENT',
            'commit guard requires --agent <agent_id> or --run <run_id>.',
            repoRoot,
            ['Pass --agent to target a known agent, or --run to resolve the agent from the run binding.'],
          ),
          { json: options.json, prefix: 'commit guard failed' },
        );
        return;
      }

      let result: CommitGuardResult;
      try {
        result = runCommitGuard({
          repoRoot,
          agent_id: options.agent,
          run_id: options.run,
          message: options.message,
          dry_run: options.dryRun === true,
        });
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError(
            'COMMIT_GUARD_FAILED',
            error instanceof Error ? error.message : String(error),
            repoRoot,
          ),
          { json: options.json, prefix: 'commit guard failed' },
        );
        return;
      }

      // Invocation failures (bad message, unresolved agent) → structured error.
      if (!result.ok) {
        const block = result.blocks[0];
        emitCliStructuredError(
          makeCliStructuredError(
            block?.code ?? 'COMMIT_GUARD_FAILED',
            block?.message ?? 'commit guard could not run',
            repoRoot,
          ),
          { json: options.json, prefix: 'commit guard failed' },
        );
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({ ok: true, data: result, artifacts: [], warnings: [] }));
        return;
      }

      printHuman(result);
    });
}

function printHuman(result: CommitGuardResult): void {
  console.log(`status: ${result.status}`);
  console.log(`agent: ${result.agent_id ?? '(none)'}`);
  if (result.run_id) console.log(`run: ${result.run_id}`);
  if (result.commit_hash) console.log(`commit: ${result.commit_hash}`);
  if (result.status === 'dry_run') {
    console.log(`would_stage: ${result.staged_files.join(', ') || '(none)'}`);
  } else {
    console.log(`committed: ${result.committed_files.join(', ') || '(none)'}`);
  }
  if (result.isolated_commit) {
    console.log('isolated_commit: true (unclaimed dirty files elsewhere in the tree were skipped, not staged or committed)');
  }
  if (result.skipped_files.length > 0) {
    console.log('skipped:');
    for (const skipped of result.skipped_files) {
      console.log(`  ${skipped.path} (${skipped.reason})`);
    }
  }
  if (result.warnings.length > 0) {
    console.log('warnings:');
    for (const warning of result.warnings) {
      console.log(`  [${warning.code}] ${warning.message}`);
    }
  }
  if (result.blocks.length > 0) {
    console.log('blocks:');
    for (const block of result.blocks) {
      console.log(`  [${block.code}] ${block.path ?? ''} ${block.message}`);
    }
  }
}
