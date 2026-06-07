import {
  addFileClaim,
  listFileClaims,
  getClaimStatusForPath,
  releaseFileClaim,
} from '../../../core/coordination/claims.js';
import { reapStaleClaims } from '../../../core/coordination/claim_cleanup.js';
import { CoordinationError } from '../../../core/coordination/errors.js';
import { isClaimMode, type FileClaim } from '../../../core/coordination/types.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateBoolean,
  validateNonEmptyString,
  CLAIM_ADD_INPUT_SCHEMA,
  CLAIMS_LIST_INPUT_SCHEMA,
  CLAIM_STATUS_INPUT_SCHEMA,
  CLAIM_RELEASE_INPUT_SCHEMA,
  CLAIMS_REAP_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

/**
 * Phase Coordination-3A: advisory file claim MCP tools.
 *
 * Thin wrappers over `core/coordination/claims`; they never accept a repo
 * argument, never shell out to the CLI, and write only generated coordination
 * state through the shared core service.
 */

function mcpErrorForCoordination(
  error: CoordinationError,
  fallback: McpErrorCode,
): McpErrorCode {
  switch (error.code) {
    case 'AGENT_NOT_FOUND':
      return 'AGENT_NOT_FOUND';
    case 'AGENT_NOT_ACTIVE':
      return 'AGENT_NOT_ACTIVE';
    case 'CLAIM_NOT_FOUND':
      return 'CLAIM_NOT_FOUND';
    case 'INVALID_CLAIM_PATH':
    case 'INVALID_CLAIM_MODE':
      return 'INVALID_ARGUMENT';
    default:
      return fallback;
  }
}

function claimLines(claim: FileClaim): string[] {
  return [
    `claim_id: ${claim.claim_id}`,
    `agent_id: ${claim.agent_id}`,
    `path: ${claim.path}`,
    `mode: ${claim.mode}`,
    `status: ${claim.status}`,
  ];
}

function failFor(started: number, input: McpToolHandlerInput, tool: string) {
  return (code: McpErrorCode, message: string): McpToolFormattedResult =>
    formatError({
      tool,
      repoRoot: input.context.repoRoot,
      warnings: [],
      durationMs: Date.now() - started,
      error: buildMcpError(code, message),
    });
}

export function buildClaimAddTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CLAIM_ADD_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_claim_add';
  const ALLOWED_KEYS = new Set(['agent_id', 'path', 'mode']);
  return {
    name: TOOL_NAME,
    title: 'Add advisory file claim',
    description:
      'Create an advisory file claim for an active registered agent in the bound repo. Writes only generated .vibecode/coordination/state.json; no source-file locks.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = failFor(started, input, TOOL_NAME);
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);

      const args = input.arguments ?? {};
      const agentId = validateNonEmptyString(args.agent_id, 'agent_id');
      if (!agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);
      const claimPath = validateNonEmptyString(args.path, 'path');
      if (!claimPath.ok) return fail('INVALID_ARGUMENT', claimPath.message);
      const mode = args.mode ?? 'exclusive';
      if (!isClaimMode(mode)) {
        return fail('INVALID_ARGUMENT', `invalid mode: expected exclusive|shared, got ${JSON.stringify(mode)}`);
      }

      try {
        const result = addFileClaim(input.context.repoRoot, {
          agent_id: agentId.value,
          path: claimPath.value,
          mode,
        });
        if (result.denied) {
          // Pass the core's structured denial details (requested path/mode,
          // full conflicting/blocking claims incl. their agent ids, and
          // suggested actions) straight through so MCP clients get the same
          // information the CLI exposes — without parsing the message string.
          return formatError({
            tool: TOOL_NAME,
            repoRoot: input.context.repoRoot,
            warnings: [],
            durationMs: Date.now() - started,
            error: buildMcpError(
              result.error?.code ?? 'CLAIM_DENIED',
              result.error?.message ?? 'claim denied',
              { details: result.error?.details },
            ),
          });
        }
        const claim = result.claim as FileClaim;
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: ['# Added advisory claim', '', ...claimLines(claim)].join('\n'),
          data: { claim },
          durationMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof CoordinationError) {
          return fail(mcpErrorForCoordination(err, 'CLAIM_ADD_FAILED'), err.message);
        }
        return fail('CLAIM_ADD_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function buildClaimsListTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CLAIMS_LIST_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_claims_list';
  const ALLOWED_KEYS = new Set(['agent_id', 'include_released']);
  return {
    name: TOOL_NAME,
    title: 'List advisory file claims',
    description:
      'List advisory file claims in the bound repo, each with computed stale-aware status. Read-only.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = failFor(started, input, TOOL_NAME);
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);
      const args = input.arguments ?? {};
      const includeReleased = validateBoolean(args.include_released, 'include_released');
      if (!includeReleased.ok) return fail('INVALID_ARGUMENT', includeReleased.message);
      const agentId = args.agent_id === undefined || args.agent_id === null
        ? undefined
        : validateNonEmptyString(args.agent_id, 'agent_id');
      if (agentId && !agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);

      try {
        const claims = listFileClaims(input.context.repoRoot, {
          agentId: agentId?.value,
          includeReleased: includeReleased.value === true,
        });
        const text = [`# Advisory claims (${claims.length})`, '']
          .concat(claims.map((claim) => `- ${claim.claim_id} ${claim.path} mode=${claim.mode} status=${claim.status} agent=${claim.agent_id}`))
          .join('\n');
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text,
          data: { claims },
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('CLAIMS_LIST_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function buildClaimStatusTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CLAIM_STATUS_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_claim_status';
  const ALLOWED_KEYS = new Set(['path']);
  return {
    name: TOOL_NAME,
    title: 'Advisory claim status for path',
    description:
      'Return advisory claim status for one repository-relative path in the bound repo. Read-only.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = failFor(started, input, TOOL_NAME);
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);
      const claimPath = validateNonEmptyString((input.arguments ?? {}).path, 'path');
      if (!claimPath.ok) return fail('INVALID_ARGUMENT', claimPath.message);

      try {
        const status = getClaimStatusForPath(input.context.repoRoot, claimPath.value);
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: [
            '# Advisory claim status',
            '',
            `path: ${status.path}`,
            `matching_claims: ${status.matching_claims.length}`,
            `can_claim_shared: ${status.can_claim_shared ? 'yes' : 'no'}`,
            `can_claim_exclusive: ${status.can_claim_exclusive ? 'yes' : 'no'}`,
          ].join('\n'),
          data: { status },
          durationMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof CoordinationError) {
          return fail(mcpErrorForCoordination(err, 'CLAIM_STATUS_FAILED'), err.message);
        }
        return fail('CLAIM_STATUS_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function buildClaimReleaseTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CLAIM_RELEASE_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_claim_release';
  const ALLOWED_KEYS = new Set(['claim_id']);
  return {
    name: TOOL_NAME,
    title: 'Release advisory file claim',
    description:
      'Release an advisory file claim in the bound repo. Writes only generated .vibecode/coordination/state.json; no source-file locks.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = failFor(started, input, TOOL_NAME);
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);
      const claimId = validateNonEmptyString((input.arguments ?? {}).claim_id, 'claim_id');
      if (!claimId.ok) return fail('INVALID_ARGUMENT', claimId.message);

      try {
        const result = releaseFileClaim(input.context.repoRoot, claimId.value);
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: ['# Released advisory claim', '', ...claimLines(result.claim)].join('\n'),
          data: { claim: result.claim },
          durationMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof CoordinationError) {
          return fail(mcpErrorForCoordination(err, 'CLAIM_RELEASE_FAILED'), err.message);
        }
        return fail('CLAIM_RELEASE_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function buildClaimsReapTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CLAIMS_REAP_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_claims_reap';
  const ALLOWED_KEYS = new Set(['dry_run']);
  return {
    name: TOOL_NAME,
    title: 'Reap stale agent claims',
    description:
      'Release claims owned by stale or terminated agents in the bound repo. Writes only generated .vibecode/coordination/state.json. Pass dry_run=true to preview without mutating.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = (code: 'INVALID_ARGUMENT' | 'CLAIMS_REAP_FAILED', message: string): McpToolFormattedResult =>
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
      const dryRun = validateBoolean(args.dry_run, 'dry_run');
      if (!dryRun.ok) return fail('INVALID_ARGUMENT', dryRun.message);

      try {
        const result = reapStaleClaims({
          repoRoot: input.context.repoRoot,
          mode: dryRun.value === true ? 'dry_run' : 'apply',
        });
        const lines = [
          `# Claims reap (${result.mode})`,
          '',
          `stale_agents: ${result.stale_agents.length}`,
          `stale_claims: ${result.stale_claims.length}`,
        ];
        if (result.mode === 'apply') {
          lines.push(`reaped: ${result.reaped_claims.length}`);
        }
        for (const agent of result.stale_agents) {
          lines.push(`  - ${agent.agent_id} ${agent.agent_name} (${agent.status})`);
        }
        for (const claim of result.stale_claims) {
          lines.push(`  - ${claim.claim_id} ${claim.path} agent=${claim.agent_id}`);
        }
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: lines.join('\n'),
          data: result,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('CLAIMS_REAP_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
