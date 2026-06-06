import path from 'path';

import { Command } from 'commander';

import {
  addFileClaim,
  listFileClaims,
  getClaimStatusForPath,
  releaseFileClaim,
  type AddFileClaimResult,
} from '../../../core/coordination/claims.js';
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
    .requiredOption('--agent <agent_id>', 'Agent id')
    .requiredOption('--path <path>', 'Repository-relative path to claim')
    .option('--mode <mode>', 'Claim mode: exclusive | shared', 'exclusive')
    .option('--type <mode>', 'Alias for --mode')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent: string; path: string; mode?: string; type?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
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
    .requiredOption('--path <path>', 'Repository-relative path')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; path: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
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
    .requiredOption('--claim <claim_id>', 'Claim id')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; claim: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      try {
        success(options.json, { claim: releaseFileClaim(repoRoot, options.claim).claim });
      } catch (error) {
        fail(repoRoot, options.json, 'claims release failed', error);
      }
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
