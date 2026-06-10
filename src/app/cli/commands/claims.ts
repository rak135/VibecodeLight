import path from 'path';

import { Command } from 'commander';

import {
  addFileClaim,
  listFileClaims,
  getClaimStatusForPath,
  releaseFileClaim,
  type AddFileClaimResult,
} from '../../../core/coordination/claims.js';
import { reapStaleClaims } from '../../../core/coordination/claim_cleanup.js';
import { planClaims, type ClaimPlanResult } from '../../../core/coordination/claim_planning.js';
import { addBulkClaims, type AddBulkClaimsResult } from '../../../core/coordination/bulk_claims.js';
import {
  listClaimIntentsDetail,
  releaseClaimIntent,
  type ListIntentsResult,
  type IntentReleaseResult,
} from '../../../core/coordination/intent_lifecycle.js';
import { CoordinationError } from '../../../core/coordination/errors.js';
import type { FileClaim } from '../../../core/coordination/types.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface ClaimsCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

export function registerClaimsCommands(
  program: Command,
  dependencies: ClaimsCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const claims = program
    .command('claims')
    .description('Multi-agent coordination: advisory file claims');

  const fail = (
    repoRoot: string,
    json: boolean | undefined,
    prefix: string,
    error: unknown,
  ): void => {
    if (error instanceof CoordinationError) {
      emitCliStructuredError(
        makeCliStructuredError(error.code, error.message, repoRoot, detailsToStrings(error.details)),
        { json, prefix },
      );
      return;
    }
    emitCliStructuredError(
      makeCliStructuredError(
        'CLAIMS_COMMAND_FAILED',
        error instanceof Error ? error.message : String(error),
        repoRoot,
      ),
      { json, prefix },
    );
  };

  const success = (json: boolean | undefined, data: Record<string, unknown>): void => {
    if (json) {
      console.log(JSON.stringify({ ok: true, data, artifacts: [], warnings: [] }));
      return;
    }
    printHuman(data);
  };

  claims
    .command('add')
    .description('Create an advisory file claim for an active agent')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Agent id')
    .option('--path <path>', 'Repository-relative path to claim')
    .option('--mode <mode>', 'Claim mode: exclusive | shared', 'exclusive')
    .option('--type <mode>', 'Alias for --mode')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; path?: string; mode?: string; type?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.agent || !options.path) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'claims add requires --agent and --path.', repoRoot, [
            ...(options.agent ? [] : ['Missing: --agent <agent_id>']),
            ...(options.path ? [] : ['Missing: --path <path>']),
          ]),
          { json: options.json, prefix: 'claims add failed' },
        );
        return;
      }

      let result: AddFileClaimResult;
      try {
        result = addFileClaim(repoRoot, {
          agent_id: options.agent,
          path: options.path,
          mode: options.type ?? options.mode ?? 'exclusive',
        });
      } catch (error) {
        fail(repoRoot, options.json, 'claims add failed', error);
        return;
      }

      if (result.denied) {
        const details = claimDeniedDetails(result);
        emitCliStructuredError(
          makeCliStructuredError(
            result.error?.code ?? 'CLAIM_DENIED',
            result.error?.message ?? 'claim denied',
            repoRoot,
            details,
          ),
          { json: options.json, prefix: 'claims add failed' },
        );
        return;
      }

      success(options.json, { claim: result.claim });
    });

  const collectPath = (value: string, previous: string[] = []): string[] => previous.concat([value]);

  claims
    .command('plan')
    .description('Read-only: evaluate whether the explicit paths you declare can be claimed (no inference)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Build agent id')
    .option('--path <path>', 'Repository-relative path to evaluate (repeatable)', collectPath, [])
    .option('--intent <text>', 'Optional work-intent text echoed into the recommended add-bulk command')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; path?: string[]; intent?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.agent || !options.path || options.path.length === 0) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'claims plan requires --agent and at least one --path.', repoRoot, [
            ...(options.agent ? [] : ['Missing: --agent <agent_id>']),
            ...(options.path && options.path.length > 0 ? [] : ['Missing: --path <path> (repeatable)']),
          ]),
          { json: options.json, prefix: 'claims plan failed' },
        );
        return;
      }
      let result: ClaimPlanResult;
      try {
        result = planClaims({ repoRoot, agent_id: options.agent, paths: options.path, intent: options.intent });
      } catch (error) {
        fail(repoRoot, options.json, 'claims plan failed', error);
        return;
      }
      if (options.json) {
        console.log(JSON.stringify({ ok: true, data: result, artifacts: [], warnings: result.warnings }));
        return;
      }
      printPlanHuman(result);
    });

  claims
    .command('add-bulk')
    .description('Claim explicit paths as one atomic work intent (build agents only; no globs/inference)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Build agent id')
    .option('--path <path>', 'Repository-relative path to claim (repeatable)', collectPath, [])
    .option('--intent <text>', 'Work-intent text (required when creating a new intent)')
    .option('--intent-id <id>', 'Existing intent id to extend (same agent only)')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; path?: string[]; intent?: string; intentId?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.agent || !options.path || options.path.length === 0) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'claims add-bulk requires --agent and at least one --path.', repoRoot, [
            ...(options.agent ? [] : ['Missing: --agent <agent_id>']),
            ...(options.path && options.path.length > 0 ? [] : ['Missing: --path <path> (repeatable)']),
          ]),
          { json: options.json, prefix: 'claims add-bulk failed' },
        );
        return;
      }
      let result: AddBulkClaimsResult;
      try {
        result = addBulkClaims({
          repoRoot,
          agent_id: options.agent,
          paths: options.path,
          intent: options.intent,
          intent_id: options.intentId,
        });
      } catch (error) {
        fail(repoRoot, options.json, 'claims add-bulk failed', error);
        return;
      }
      // A blocked result is a valid structured response (no claims created),
      // mirroring finalize: it is reported as ok:true with status="blocked".
      if (options.json) {
        console.log(JSON.stringify({ ok: true, data: result, artifacts: [], warnings: result.warnings }));
        return;
      }
      printBulkHuman(result);
    });

  claims
    .command('list')
    .description('List advisory file claims')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Filter claims by agent id')
    .option('--include-released', 'Include released claims')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; includeReleased?: boolean; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      try {
        success(options.json, {
          claims: listFileClaims(repoRoot, {
            agentId: options.agent,
            includeReleased: options.includeReleased === true,
          }),
        });
      } catch (error) {
        fail(repoRoot, options.json, 'claims list failed', error);
      }
    });

  claims
    .command('status')
    .description('Show advisory claim status for a repository-relative path')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--path <path>', 'Repository-relative path')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; path?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.path) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'claims status requires --path.', repoRoot, ['Missing: --path <path>']),
          { json: options.json, prefix: 'claims status failed' },
        );
        return;
      }
      try {
        success(options.json, { status: getClaimStatusForPath(repoRoot, options.path) });
      } catch (error) {
        fail(repoRoot, options.json, 'claims status failed', error);
      }
    });

  claims
    .command('release')
    .description('Release an advisory file claim')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--claim <claim_id>', 'Claim id')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; claim?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.claim) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'claims release requires --claim.', repoRoot, ['Missing: --claim <claim_id>']),
          { json: options.json, prefix: 'claims release failed' },
        );
        return;
      }
      try {
        success(options.json, { claim: releaseFileClaim(repoRoot, options.claim).claim });
      } catch (error) {
        fail(repoRoot, options.json, 'claims release failed', error);
      }
    });

  claims
    .command('reap')
    .description('Release claims owned by stale or terminated agents')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--dry-run', 'Report reapable claims without releasing them')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; dryRun?: boolean; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      try {
        const result = reapStaleClaims({ repoRoot, mode: options.dryRun ? 'dry_run' : 'apply' });
        if (options.json) {
          console.log(JSON.stringify({ ok: true, data: result, artifacts: [], warnings: [] }));
          return;
        }
        printReapHuman(result);
      } catch (error) {
        fail(repoRoot, options.json, 'claims reap failed', error);
      }
    });

  // Phase 2B: claim intent lifecycle.

  const intents = claims
    .command('intents')
    .description('Claim intent lifecycle: list and release work intents');

  intents
    .command('list')
    .description('List claim intents with claim detail')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Filter by agent id')
    .option('--status <status>', 'Filter by status: active | released | all', 'active')
    .option('--intent-id <id>', 'Filter by specific intent id')
    .option('--max-items <n>', 'Cap on number of intents returned')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; status?: string; intentId?: string; maxItems?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      // Strict option validation, mirroring the MCP schema: status is a fixed
      // enum, max-items a positive integer. Invalid values must error, never
      // silently return an empty list.
      const status = options.status ?? 'active';
      if (status !== 'active' && status !== 'released' && status !== 'all') {
        emitCliStructuredError(
          makeCliStructuredError(
            'INVALID_ARGUMENT',
            `--status must be one of: active | released | all (got ${JSON.stringify(options.status)}).`,
            repoRoot,
          ),
          { json: options.json, prefix: 'claims intents list failed' },
        );
        return;
      }
      let maxItems: number | undefined;
      if (options.maxItems !== undefined) {
        const parsed = Number(options.maxItems);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          emitCliStructuredError(
            makeCliStructuredError(
              'INVALID_ARGUMENT',
              `--max-items must be a positive integer (got ${JSON.stringify(options.maxItems)}).`,
              repoRoot,
            ),
            { json: options.json, prefix: 'claims intents list failed' },
          );
          return;
        }
        maxItems = parsed;
      }
      try {
        const result = listClaimIntentsDetail(repoRoot, {
          agent_id: options.agent,
          status,
          intent_id: options.intentId,
          max_items: maxItems,
        });
        if (options.json) {
          console.log(JSON.stringify({ ok: true, data: result, artifacts: [], warnings: result.warnings }));
          return;
        }
        printIntentsListHuman(result);
      } catch (error) {
        fail(repoRoot, options.json, 'claims intents list failed', error);
      }
    });

  claims
    .command('intent-release')
    .description('Release all active claims belonging to a work intent')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Agent id (same-agent only)')
    .option('--intent-id <id>', 'Intent id to release')
    .option('--dry-run', 'Preview without releasing')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; intentId?: string; dryRun?: boolean; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.agent || !options.intentId) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'claims intent-release requires --agent and --intent-id.', repoRoot, [
            ...(options.agent ? [] : ['Missing: --agent <agent_id>']),
            ...(options.intentId ? [] : ['Missing: --intent-id <intent_id>']),
          ]),
          { json: options.json, prefix: 'claims intent-release failed' },
        );
        return;
      }
      let result: IntentReleaseResult;
      try {
        result = releaseClaimIntent({
          repoRoot,
          agent_id: options.agent,
          intent_id: options.intentId,
          dry_run: options.dryRun === true,
        });
      } catch (error) {
        fail(repoRoot, options.json, 'claims intent-release failed', error);
        return;
      }
      if (options.json) {
        console.log(JSON.stringify({ ok: true, data: result, artifacts: [], warnings: result.warnings }));
        return;
      }
      printIntentReleaseHuman(result);
    });
}

function detailsToStrings(details: Record<string, unknown>): string[] {
  return Object.entries(details).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
}

function claimDeniedDetails(result: AddFileClaimResult): string[] {
  const details = result.error?.details ? detailsToStrings(result.error.details) : [];
  if (result.conflicting_claims.length > 0) {
    details.push(
      `conflicting_claims: ${result.conflicting_claims.map((claim) => claim.claim_id).join(', ')}`,
    );
  }
  return details;
}

function printHuman(data: Record<string, unknown>): void {
  if (Array.isArray(data.claims)) {
    const claims = data.claims as FileClaim[];
    console.log(`claims: ${claims.length}`);
    for (const claim of claims) {
      console.log(`  ${claim.claim_id} ${claim.path} mode=${claim.mode} status=${claim.status} agent=${claim.agent_id}`);
    }
    return;
  }
  if (data.claim) {
    const claim = data.claim as FileClaim;
    console.log(`claim_id: ${claim.claim_id}`);
    console.log(`agent_id: ${claim.agent_id}`);
    console.log(`path: ${claim.path}`);
    console.log(`mode: ${claim.mode}`);
    console.log(`status: ${claim.status}`);
    return;
  }
  if (data.status) {
    const status = data.status as { path: string; matching_claims: FileClaim[]; can_claim_shared: boolean; can_claim_exclusive: boolean };
    console.log(`path: ${status.path}`);
    console.log(`matching_claims: ${status.matching_claims.length}`);
    console.log(`can_claim_shared: ${status.can_claim_shared ? 'yes' : 'no'}`);
    console.log(`can_claim_exclusive: ${status.can_claim_exclusive ? 'yes' : 'no'}`);
  }
}

function printPlanHuman(result: ClaimPlanResult): void {
  console.log(`agent: ${result.agent_id} (mode=${result.agent_mode})`);
  console.log(`intent: ${result.intent ?? '(none)'}`);
  console.log(`can_claim_all: ${result.can_claim_all ? 'yes' : 'no'}`);
  console.log('paths:');
  for (const p of result.paths) {
    console.log(`  ${p.path} [${p.status}] ${p.reason}`);
  }
  if (result.warnings.length > 0) {
    console.log('warnings:');
    for (const w of result.warnings) console.log(`  ${w}`);
  }
  if (result.recommended_cli_commands.length > 0) {
    console.log('recommended_cli_commands:');
    for (const c of result.recommended_cli_commands) console.log(`  - ${c}`);
  }
}

function printBulkHuman(result: AddBulkClaimsResult): void {
  console.log(`status: ${result.status}`);
  console.log(`agent: ${result.agent_id}`);
  console.log(`intent_id: ${result.intent_id ?? '(none)'}`);
  console.log(`intent: ${result.intent ?? '(none)'}`);
  if (result.created_claims.length > 0) {
    console.log('created_claims:');
    for (const c of result.created_claims) console.log(`  ${c.claim_id} ${c.path}`);
  }
  if (result.already_owned_paths.length > 0) {
    console.log(`already_owned_paths: ${result.already_owned_paths.join(', ')}`);
  }
  if (result.blocked_paths.length > 0) {
    console.log('blocked_paths:');
    for (const b of result.blocked_paths) console.log(`  ${b.path} [${b.reason}]`);
  }
  if (result.conflict_id) console.log(`conflict_id: ${result.conflict_id}`);
  if (result.recommended_cli_commands.length > 0) {
    console.log('recommended_cli_commands:');
    for (const c of result.recommended_cli_commands) console.log(`  - ${c}`);
  }
}

function printReapHuman(result: { mode: string; stale_agents: Array<{ agent_id: string; agent_name: string; status: string }>; stale_claims: FileClaim[]; reaped_claims: FileClaim[] }): void {
  console.log(`mode: ${result.mode}`);
  console.log(`stale_agents: ${result.stale_agents.length}`);
  for (const agent of result.stale_agents) {
    console.log(`  ${agent.agent_id} ${agent.agent_name} (${agent.status})`);
  }
  console.log(`stale_claims: ${result.stale_claims.length}`);
  for (const claim of result.stale_claims) {
    console.log(`  ${claim.claim_id} ${claim.path} agent=${claim.agent_id}`);
  }
  if (result.mode === 'apply') {
    console.log(`reaped: ${result.reaped_claims.length}`);
  }
}

function printIntentsListHuman(result: ListIntentsResult): void {
  if (result.agent_id) console.log(`agent: ${result.agent_id}`);
  console.log(`status_filter: ${result.status_filter}`);
  console.log(`intents: ${result.intents.length}`);
  for (const intent of result.intents) {
    console.log(`  ${intent.intent_id} [${intent.status}] "${intent.intent}"`);
    console.log(`    owner: ${intent.agent_id} (${intent.owning_agent_status})`);
    console.log(`    claims: ${intent.active_claim_count} active / ${intent.released_claim_count} released (${intent.claim_count} total)`);
    if (intent.missing_claim_count > 0) {
      console.log(`    missing_claims: ${intent.missing_claim_count}`);
    }
    if (intent.warning_codes.length > 0) {
      console.log(`    warnings: ${intent.warning_codes.join(', ')}`);
    }
    if (intent.sample_paths.length > 0) {
      console.log(`    paths: ${intent.sample_paths.join(', ')}${intent.sample_truncated ? ' ...' : ''}`);
    }
  }
  if (result.truncated) console.log('(truncated)');
  for (const w of result.warnings) console.log(`warning: ${w}`);
}

function printIntentReleaseHuman(result: IntentReleaseResult): void {
  console.log(`status: ${result.status}`);
  console.log(`agent: ${result.agent_id}`);
  console.log(`intent_id: ${result.intent_id}`);
  console.log(`release_allowed: ${result.release_allowed}`);
  console.log(`intent_status: ${result.intent_status}`);
  if (result.released_claims.length > 0) {
    console.log('released_claims:');
    for (const c of result.released_claims) console.log(`  ${c.claim_id} ${c.path}`);
  }
  if (result.already_released_claims.length > 0) {
    console.log(`already_released_claims: ${result.already_released_claims.length}`);
  }
  if (result.dirty_claimed_paths.length > 0) {
    console.log('dirty_claimed_paths:');
    for (const p of result.dirty_claimed_paths) console.log(`  ${p}`);
  }
  if (result.blocked_reason) console.log(`blocked_reason: ${result.blocked_reason}`);
  for (const w of result.warnings) console.log(`warning: ${w}`);
  if (result.recommended_cli_commands.length > 0) {
    console.log('recommended_cli_commands:');
    for (const c of result.recommended_cli_commands) console.log(`  - ${c}`);
  }
}
