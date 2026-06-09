import {
  listClaimIntentsDetail,
  releaseClaimIntent,
  type ListIntentsResult,
  type IntentReleaseResult,
} from '../../../core/coordination/intent_lifecycle.js';
import { CoordinationError } from '../../../core/coordination/errors.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateNonEmptyString,
  validateBoolean,
  validatePositiveInteger,
  CLAIM_INTENTS_LIST_INPUT_SCHEMA,
  CLAIM_INTENT_RELEASE_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

/**
 * Phase 2B — claim intent lifecycle MCP tools.
 *
 * `vibecode_claim_intents_list` (read-only) lists the agent's work intents
 * with claim detail. `vibecode_claim_intent_release` performs dry-run or actual
 * release of all claims belonging to an intent, with dirty-file safety.
 *
 * Both are thin wrappers over `core/coordination/intent_lifecycle` — the same
 * services the CLI uses. They never accept a repo argument and never shell out.
 */

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
    case 'INTENT_NOT_FOUND':
      return 'INTENT_NOT_FOUND';
    case 'INTENT_FORBIDDEN':
      return 'INTENT_FORBIDDEN';
    case 'INTENT_RELEASE_BLOCKED':
      return 'INTENT_RELEASE_BLOCKED';
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

function renderIntentsListText(result: ListIntentsResult): string {
  const lines: string[] = ['# Vibecode claim intents', ''];
  if (result.agent_id) lines.push(`agent: ${result.agent_id}`);
  lines.push(`status_filter: ${result.status_filter}`);
  lines.push(`intents: ${result.intents.length}`);
  if (result.truncated) lines.push('(truncated)');
  lines.push('');
  for (const intent of result.intents) {
    lines.push(`  - ${intent.intent_id} [${intent.status}] "${intent.intent}"`);
    lines.push(`    claims: ${intent.active_claim_count} active / ${intent.released_claim_count} released (${intent.claim_count} total)`);
    if (intent.sample_paths.length > 0) {
      lines.push(`    paths: ${intent.sample_paths.join(', ')}${intent.sample_truncated ? ' ...' : ''}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

function renderReleaseText(result: IntentReleaseResult): string {
  const lines: string[] = [`# Vibecode intent release (${result.dry_run ? 'dry-run' : 'apply'})`, ''];
  lines.push(`agent: ${result.agent_id}`);
  lines.push(`intent_id: ${result.intent_id}`);
  lines.push(`status: ${result.status}`);
  lines.push(`release_allowed: ${result.release_allowed}`);
  lines.push(`intent_status: ${result.intent_status}`);
  if (result.released_claims.length > 0) {
    lines.push('', 'released_claims:');
    for (const c of result.released_claims) lines.push(`  - ${c.claim_id} ${c.path}`);
  }
  if (result.already_released_claims.length > 0) {
    lines.push('', `already_released_claims: ${result.already_released_claims.length}`);
  }
  if (result.dirty_claimed_paths.length > 0) {
    lines.push('', 'dirty_claimed_paths:');
    for (const p of result.dirty_claimed_paths) lines.push(`  - ${p}`);
  }
  if (result.blocked_reason) lines.push('', `blocked_reason: ${result.blocked_reason}`);
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

export function buildClaimIntentsListTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CLAIM_INTENTS_LIST_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_claim_intents_list';
  const ALLOWED_KEYS = new Set(['agent_id', 'status', 'intent_id', 'max_items']);
  return {
    name: TOOL_NAME,
    title: 'List claim intents',
    description:
      'Read-only: list the agent\'s work intents with claim detail (active/released counts, paths). Filter by agent_id, status, or intent_id. No state mutation.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = failFor(started, input, TOOL_NAME);
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);

      const args = input.arguments ?? {};
      const agentId = args.agent_id === undefined || args.agent_id === null
        ? undefined
        : validateNonEmptyString(args.agent_id, 'agent_id');
      if (agentId && !agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);

      const statusRaw = args.status;
      if (statusRaw !== undefined && statusRaw !== null) {
        if (typeof statusRaw !== 'string' || !['active', 'released', 'all'].includes(statusRaw)) {
          return fail('INVALID_ARGUMENT', `invalid status: expected active|released|all, got ${JSON.stringify(statusRaw)}`);
        }
      }

      const intentId = args.intent_id === undefined || args.intent_id === null
        ? undefined
        : validateNonEmptyString(args.intent_id, 'intent_id');
      if (intentId && !intentId.ok) return fail('INVALID_ARGUMENT', intentId.message);

      const maxItems = validatePositiveInteger(args.max_items, 'max_items');
      if (!maxItems.ok) return fail('INVALID_ARGUMENT', maxItems.message);

      try {
        const result = listClaimIntentsDetail(input.context.repoRoot, {
          agent_id: agentId?.value,
          status: statusRaw as 'active' | 'released' | 'all' | undefined,
          intent_id: intentId?.value,
          max_items: maxItems.value,
        });
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderIntentsListText(result),
          data: result,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('CLAIM_INTENTS_LIST_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function buildClaimIntentReleaseTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CLAIM_INTENT_RELEASE_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_claim_intent_release';
  const ALLOWED_KEYS = new Set(['agent_id', 'intent_id', 'dry_run']);
  return {
    name: TOOL_NAME,
    title: 'Release claim intent',
    description:
      'Release all active claims belonging to a work intent. Same-agent only. Blocked when claimed files are dirty in the working tree — commit or revert first. Pass dry_run=true to preview without releasing. Writes only generated coordination state.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = failFor(started, input, TOOL_NAME);
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);

      const args = input.arguments ?? {};
      const agentId = validateNonEmptyString(args.agent_id, 'agent_id');
      if (!agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);
      const intentId = validateNonEmptyString(args.intent_id, 'intent_id');
      if (!intentId.ok) return fail('INVALID_ARGUMENT', intentId.message);
      const dryRun = validateBoolean(args.dry_run, 'dry_run');
      if (!dryRun.ok) return fail('INVALID_ARGUMENT', dryRun.message);

      try {
        const result = releaseClaimIntent({
          repoRoot: input.context.repoRoot,
          agent_id: agentId.value,
          intent_id: intentId.value,
          dry_run: dryRun.value === true,
        });
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderReleaseText(result),
          data: result,
          warnings: result.warnings,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof CoordinationError) {
          return fail(mcpErrorForCoordination(err, 'CLAIM_INTENT_RELEASE_FAILED'), err.message);
        }
        return fail('CLAIM_INTENT_RELEASE_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
