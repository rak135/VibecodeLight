import path from 'path';

import { Command } from 'commander';

import {
  getFinalizeCheck,
  type FinalizeCheckResult,
} from '../../../core/coordination/finalize_check.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface FinalizeCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

/**
 * Register `vibecode finalize …` commands.
 *
 * Phase 4A ships only the read-only `check` subcommand. It is a thin wrapper
 * over the shared core service (`core/coordination/finalize_check`) — the same
 * service the MCP tool `vibecode_finalize_check` uses — so CLI and MCP return
 * equivalent data. The command never mutates git or coordination state and is
 * NOT a commit guard.
 */
export function registerFinalizeCommands(
  program: Command,
  dependencies: FinalizeCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const finalize = program
    .command('finalize')
    .description('Multi-agent coordination: read-only finalize check (advisory; not a commit guard)');

  finalize
    .command('check')
    .description('Classify the dirty working tree relative to an agent’s active advisory claims')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Coordinating agent id')
    .option('--run <run_id>', 'Run id whose agent_binding.json resolves the agent')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; run?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);

      if (!options.agent && !options.run) {
        emitCliStructuredError(
          makeCliStructuredError(
            'INVALID_ARGUMENT',
            'finalize check requires --agent <agent_id> or --run <run_id>.',
            repoRoot,
            ['Pass --agent to target a known agent, or --run to resolve the agent from the run binding.'],
          ),
          { json: options.json, prefix: 'finalize check failed' },
        );
        return;
      }

      let result: FinalizeCheckResult;
      try {
        result = getFinalizeCheck({ repoRoot, agent_id: options.agent, run_id: options.run });
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError(
            'FINALIZE_CHECK_FAILED',
            error instanceof Error ? error.message : String(error),
            repoRoot,
          ),
          { json: options.json, prefix: 'finalize check failed' },
        );
        return;
      }

      // A completed check that resolved no agent (e.g. neither flag resolved an
      // agent) is an invocation failure: surface it as a structured error so the
      // CLI envelope is ok:false with a non-zero exit, mirroring other commands.
      if (!result.ok) {
        const block = result.blocks[0];
        emitCliStructuredError(
          makeCliStructuredError(
            block?.code ?? 'FINALIZE_CHECK_FAILED',
            block?.message ?? 'finalize check could not resolve an agent',
            repoRoot,
          ),
          { json: options.json, prefix: 'finalize check failed' },
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

function printHuman(result: FinalizeCheckResult): void {
  console.log(`status: ${result.status}`);
  console.log(`agent: ${result.agent ? `${result.agent.agent_id} (${result.agent.status})` : '(none)'}`);
  if (result.run_id) console.log(`run: ${result.run_id}`);
  const s = result.summary;
  console.log(
    `changed=${s.changed_count} allowed=${s.allowed_count} unclaimed=${s.unclaimed_count} other=${s.other_claimed_count} generated=${s.generated_ignored_count}`,
  );
  if (result.blocks.length > 0) {
    console.log('blocks:');
    for (const block of result.blocks) {
      console.log(`  [${block.code}] ${block.path ?? ''} ${block.message}`);
    }
  }
  if (result.warnings.length > 0) {
    console.log('warnings:');
    for (const warning of result.warnings) {
      console.log(`  [${warning.code}] ${warning.path ?? ''} ${warning.message}`);
    }
  }
}
