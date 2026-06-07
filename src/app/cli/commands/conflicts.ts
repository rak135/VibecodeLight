import path from 'path';

import { Command } from 'commander';

import {
  listConflicts,
  resolveConflict,
  type ConflictRecord,
} from '../../../core/coordination/conflicts.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface ConflictsCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

export function registerConflictsCommands(
  program: Command,
  dependencies: ConflictsCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const conflicts = program
    .command('conflicts')
    .description('Multi-agent coordination: conflict history (advisory)');

  conflicts
    .command('list')
    .description('List recorded coordination conflicts')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--status <status>', 'Filter by status: detected | resolved')
    .option('--type <type>', 'Filter by type: claim_denied | stale_claim')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; status?: string; type?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      try {
        const filter: { status?: 'detected' | 'resolved'; conflict_type?: 'claim_denied' | 'stale_claim' } = {};
        if (options.status === 'detected' || options.status === 'resolved') {
          filter.status = options.status;
        }
        if (options.type === 'claim_denied' || options.type === 'stale_claim') {
          filter.conflict_type = options.type;
        }
        const result = listConflicts(repoRoot, filter);
        if (options.json) {
          console.log(JSON.stringify({ ok: true, data: { conflicts: result }, artifacts: [], warnings: [] }));
          return;
        }
        printConflictsHuman(result);
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError(
            'CONFLICTS_LIST_FAILED',
            error instanceof Error ? error.message : String(error),
            repoRoot,
          ),
          { json: options.json, prefix: 'conflicts list failed' },
        );
      }
    });

  conflicts
    .command('resolve')
    .description('Mark a coordination conflict as resolved')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--conflict <conflict_id>', 'Conflict id to resolve')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; conflict?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.conflict) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'conflicts resolve requires --conflict.', repoRoot, ['Missing: --conflict <conflict_id>']),
          { json: options.json, prefix: 'conflicts resolve failed' },
        );
        return;
      }
      try {
        const result = resolveConflict(repoRoot, options.conflict, {
          resolved_at: new Date().toISOString(),
        });
        if (options.json) {
          console.log(JSON.stringify({ ok: true, data: { conflict: result }, artifacts: [], warnings: [] }));
          return;
        }
        console.log(`conflict_id: ${result.conflict_id}`);
        console.log(`status: ${result.status}`);
        console.log(`resolved_at: ${result.resolved_at}`);
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError(
            'CONFLICT_RESOLVE_FAILED',
            error instanceof Error ? error.message : String(error),
            repoRoot,
          ),
          { json: options.json, prefix: 'conflicts resolve failed' },
        );
      }
    });
}

function printConflictsHuman(conflicts: ConflictRecord[]): void {
  console.log(`conflicts: ${conflicts.length}`);
  for (const conflict of conflicts) {
    console.log(`  ${conflict.conflict_id} type=${conflict.conflict_type} status=${conflict.status} severity=${conflict.severity} files=${conflict.involved_files.join(',')}`);
  }
}
