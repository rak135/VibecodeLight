import { planClaims, type ClaimPlanResult } from '../../../core/coordination/claim_planning.js';
import { addBulkClaims, type AddBulkClaimsResult } from '../../../core/coordination/bulk_claims.js';
import { CoordinationError } from '../../../core/coordination/errors.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateNonEmptyString,
  validateStringArray,
  CLAIMS_PLAN_INPUT_SCHEMA,
  CLAIMS_ADD_BULK_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

/**
 * Phase 2A — agent-declared work scope MCP tools.
 *
 * `vibecode_claims_plan` (read-only) previews whether the EXPLICIT paths an agent
 * supplies can be claimed; `vibecode_claims_add_bulk` claims them atomically under
 * a declared work intent. Both are thin wrappers over the shared core services
 * (`core/coordination/claim_planning` / `bulk_claims`) — the same services the
 * `vibecode claims plan` / `vibecode claims add-bulk` CLI commands use. They never
 * accept a repo argument and never shell out. Core decides nothing about WHICH
 * files an agent needs — it only validates and coordinates the agent's explicit
 * declaration.
 */

/** Map a CoordinationError onto a stable MCP error code. */
function mcpErrorForCoordination(error: CoordinationError, fallback: McpErrorCode): McpErrorCode {
  switch (error.code) {
    case 'AGENT_NOT_FOUND':
      return 'AGENT_NOT_FOUND';
    case 'AGENT_NOT_ACTIVE':
      return 'AGENT_NOT_ACTIVE';
    case 'READ_ONLY_AGENT':
      return 'READ_ONLY_AGENT';
    case 'INVALID_AGENT_MODE':
    case 'INVALID_AGENT_SESSION':
      return 'INVALID_AGENT_SESSION';
    case 'NO_CLAIM_PATHS':
      return 'NO_CLAIM_PATHS';
    case 'INVALID_INTENT':
      return 'INVALID_INTENT';
    case 'INTENT_NOT_FOUND':
      return 'INTENT_NOT_FOUND';
    case 'INTENT_FORBIDDEN':
      return 'INTENT_FORBIDDEN';
    case 'INVALID_CLAIM_PATH':
      return 'INVALID_ARGUMENT';
    default:
      return fallback;
  }
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

function renderPlanText(result: ClaimPlanResult): string {
  const lines: string[] = ['# Vibecode claims plan', ''];
  lines.push(`agent: ${result.agent_id} (mode=${result.agent_mode})`);
  lines.push(`intent: ${result.intent ?? '(none)'}`);
  lines.push(`can_claim_all: ${result.can_claim_all ? 'yes' : 'no'}`);
  lines.push('', 'paths:');
  for (const p of result.paths) lines.push(`  - ${p.path} [${p.status}] ${p.reason}`);
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  if (result.recommended_cli_commands.length > 0) {
    lines.push('', 'recommended_cli_commands:');
    for (const c of result.recommended_cli_commands) lines.push(`  - ${c}`);
  }
  return lines.join('\n');
}

function renderBulkText(result: AddBulkClaimsResult): string {
  const lines: string[] = ['# Vibecode bulk claim', ''];
  lines.push(`status: ${result.status}`);
  lines.push(`agent: ${result.agent_id}`);
  lines.push(`intent_id: ${result.intent_id ?? '(none)'}`);
  lines.push(`intent: ${result.intent ?? '(none)'}`);
  if (result.created_claims.length > 0) {
    lines.push('', 'created_claims:');
    for (const c of result.created_claims) lines.push(`  - ${c.claim_id} ${c.path}`);
  }
  if (result.already_owned_paths.length > 0) {
    lines.push('', `already_owned_paths: ${result.already_owned_paths.join(', ')}`);
  }
  if (result.blocked_paths.length > 0) {
    lines.push('', 'blocked_paths:');
    for (const b of result.blocked_paths) lines.push(`  - ${b.path} [${b.reason}]`);
  }
  if (result.conflict_id) lines.push('', `conflict_id: ${result.conflict_id}`);
  if (result.recommended_cli_commands.length > 0) {
    lines.push('', 'recommended_cli_commands:');
    for (const c of result.recommended_cli_commands) lines.push(`  - ${c}`);
  }
  return lines.join('\n');
}

export function buildClaimsPlanTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CLAIMS_PLAN_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_claims_plan';
  const ALLOWED_KEYS = new Set(['agent_id', 'paths', 'intent']);
  return {
    name: TOOL_NAME,
    title: 'Plan an explicit bulk claim',
    description:
      'Read-only: evaluate whether the EXPLICIT paths an agent declares can be claimed (and what add-bulk would do). Vibecode never infers paths — it only classifies the exact paths you supply (claimable / already owned / claimed by another agent / stale / generated / missing / invalid). No state mutation.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = failFor(started, input, TOOL_NAME);
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);

      const args = input.arguments ?? {};
      const agentId = validateNonEmptyString(args.agent_id, 'agent_id');
      if (!agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);
      const paths = validateStringArray(args.paths, 'paths');
      if (!paths.ok) return fail('INVALID_ARGUMENT', paths.message);
      if (args.intent !== undefined && args.intent !== null) {
        const intentCheck = validateNonEmptyString(args.intent, 'intent');
        if (!intentCheck.ok) return fail('INVALID_ARGUMENT', intentCheck.message);
      }

      try {
        const result = planClaims({
          repoRoot: input.context.repoRoot,
          agent_id: agentId.value,
          paths: paths.value,
          intent: typeof args.intent === 'string' ? args.intent : undefined,
        });
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderPlanText(result),
          data: result,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof CoordinationError) {
          return fail(mcpErrorForCoordination(err, 'CLAIMS_PLAN_FAILED'), err.message);
        }
        return fail('CLAIMS_PLAN_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function buildClaimsAddBulkTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CLAIMS_ADD_BULK_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_claims_add_bulk';
  const ALLOWED_KEYS = new Set(['agent_id', 'paths', 'intent', 'intent_id']);
  return {
    name: TOOL_NAME,
    title: 'Claim explicit paths as one work scope',
    description:
      'Claim the EXPLICIT paths an agent declares as one atomic work intent. Build agents only; no globs/inference/expansion. Atomic: if any path is blocked by another active claim, invalid, or generated, NO claims are created and a structured blocked result (status="blocked") is returned with the conflict recorded. Idempotent for paths already owned by the agent. Pass intent to create a new work scope, or intent_id to extend your own. Writes only generated coordination state.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = failFor(started, input, TOOL_NAME);
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);

      const args = input.arguments ?? {};
      const agentId = validateNonEmptyString(args.agent_id, 'agent_id');
      if (!agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);
      const paths = validateStringArray(args.paths, 'paths');
      if (!paths.ok) return fail('INVALID_ARGUMENT', paths.message);
      if (args.intent !== undefined && args.intent !== null) {
        const intentCheck = validateNonEmptyString(args.intent, 'intent');
        if (!intentCheck.ok) return fail('INVALID_ARGUMENT', intentCheck.message);
      }
      if (args.intent_id !== undefined && args.intent_id !== null) {
        const intentIdCheck = validateNonEmptyString(args.intent_id, 'intent_id');
        if (!intentIdCheck.ok) return fail('INVALID_ARGUMENT', intentIdCheck.message);
      }

      try {
        const result = addBulkClaims({
          repoRoot: input.context.repoRoot,
          agent_id: agentId.value,
          paths: paths.value,
          intent: typeof args.intent === 'string' ? args.intent : undefined,
          intent_id: typeof args.intent_id === 'string' ? args.intent_id : undefined,
        });
        // A blocked result is a structured SUCCESS (no claims created), mirroring
        // finalize_check; only invocation/validation problems are MCP errors.
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderBulkText(result),
          data: result,
          warnings: result.warnings,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof CoordinationError) {
          return fail(mcpErrorForCoordination(err, 'CLAIMS_ADD_BULK_FAILED'), err.message);
        }
        return fail('CLAIMS_ADD_BULK_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
