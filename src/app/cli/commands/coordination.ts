import path from 'path';

import { Command } from 'commander';

import { getCoordinationStatus } from '../../../core/coordination/status.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface CoordinationCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

/**
 * Register `vibecode coordination …` commands.
 *
 * Phase 1 ships only the read-only `status` subcommand. It calls the shared
 * core service (`core/coordination/status`) — the same service the MCP tool
 * `vibecode_coordination_status` uses — so CLI and MCP stay in lockstep.
 */
export function registerCoordinationCommands(
  program: Command,
  dependencies: CoordinationCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const coordination = program
    .command('coordination')
    .description('Multi-agent coordination (advisory; read-only status)');

  coordination
    .command('status')
    .description('Show read-only multi-agent coordination status for a repository')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      let result;
      try {
        result = getCoordinationStatus(repoRoot);
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError(
            'COORDINATION_STATUS_FAILED',
            error instanceof Error ? error.message : String(error),
            repoRoot,
          ),
          { json: options.json, prefix: 'coordination status failed' },
        );
        return;
      }

      const data = {
        workspace_root: result.workspace_root,
        state_file: result.state_file,
        state_file_exists: result.state_file_exists,
        version: result.version,
        last_updated: result.last_updated,
        summary: result.summary,
      };

      if (options.json) {
        console.log(JSON.stringify({ ok: true, data, artifacts: [], warnings: [] }));
        return;
      }

      console.log(`workspace_root: ${data.workspace_root}`);
      console.log(`state_file: ${data.state_file} (${data.state_file_exists ? 'exists' : 'absent'})`);
      console.log(`version: ${data.version}`);
      console.log(
        `agents=${data.summary.agents} claims=${data.summary.claims} conflicts=${data.summary.conflicts} handoffs=${data.summary.handoffs}`,
      );
    });
}
