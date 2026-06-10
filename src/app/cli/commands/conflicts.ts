import path from 'path';

import { Command } from 'commander';

import {
  listConflicts,
  resolveConflict,
  type ConflictRecord,
} from '../../../core/coordination/conflicts.js';
import { listAgents } from '../../../core/coordination/agents.js';
import { listFileClaims } from '../../../core/coordination/claims.js';
import { listClaimIntents } from '../../../core/coordination/bulk_claims.js';
import { getConflictTriageDetail, type ConflictTriageDetail } from '../../../core/coordination/conflict_triage.js';
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
    .command('detail')
    .description('Get intent-aware triage detail for one coordination conflict')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--conflict-id <id>', 'Conflict id to inspect')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; conflictId?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.conflictId) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'conflicts detail requires --conflict-id.', repoRoot, ['Missing: --conflict-id <conflict_id>']),
          { json: options.json, prefix: 'conflicts detail failed' },
        );
        return;
      }
      try {
        const allConflicts = listConflicts(repoRoot);
        const agents = listAgents(repoRoot);
        const claims = listFileClaims(repoRoot, { includeReleased: true });
        const intents = listClaimIntents(repoRoot);

        const detail = getConflictTriageDetail({
          conflictId: options.conflictId,
          agents,
          claims,
          intents,
          conflicts: allConflicts,
        });

        if (!detail) {
          emitCliStructuredError(
            makeCliStructuredError('CONFLICT_NOT_FOUND', `Conflict not found: ${options.conflictId}`, repoRoot),
            { json: options.json, prefix: 'conflicts detail failed' },
          );
          return;
        }

        if (options.json) {
          console.log(JSON.stringify({ ok: true, data: { conflict: detail }, artifacts: [], warnings: [] }));
          return;
        }
        printConflictDetailHuman(detail);
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError(
            'CONFLICT_DETAIL_FAILED',
            error instanceof Error ? error.message : String(error),
            repoRoot,
          ),
          { json: options.json, prefix: 'conflicts detail failed' },
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

function printConflictDetailHuman(detail: ConflictTriageDetail): void {
  console.log(`conflict_id: ${detail.conflict_id}`);
  console.log(`type: ${detail.conflict_type}`);
  console.log(`triage_status: ${detail.triage_status}`);
  console.log(`stored_status: ${detail.stored_status}`);
  console.log(`created_at: ${detail.created_at}`);
  console.log(`files: ${detail.involved_files.join(', ')}`);
  console.log(`requesting_agent: ${detail.requesting_agent_id ?? '(none)'} (${detail.requesting_agent_status})`);
  console.log(`blocking_agent: ${detail.blocking_agent_id ?? '(none)'} (${detail.blocking_agent_status})`);
  console.log(`still_actively_blocking: ${detail.still_actively_blocking}`);
  console.log(`blocking_claim_released: ${detail.blocking_claim_released}`);
  if (detail.blocking_intent) {
    console.log(`blocking_intent: ${detail.blocking_intent.intent_id} [${detail.blocking_intent.status}] "${detail.blocking_intent.intent}"`);
  }
  if (detail.blocking_claims.length > 0) {
    console.log('blocking_claims:');
    for (const c of detail.blocking_claims) {
      console.log(`  ${c.claim_id} path=${c.path} agent=${c.agent_id} mode=${c.mode} status=${c.status}`);
    }
  }
  if (detail.warning_codes.length > 0) {
    console.log(`warnings: ${detail.warning_codes.join(', ')}`);
  }
  if (detail.recommended_next_tools.length > 0) {
    console.log('recommended_next_tools:');
    for (const t of detail.recommended_next_tools) console.log(`  - ${t}`);
  }
  if (detail.recommended_cli_commands.length > 0) {
    console.log('recommended_cli_commands:');
    for (const c of detail.recommended_cli_commands) console.log(`  - ${c}`);
  }
}
