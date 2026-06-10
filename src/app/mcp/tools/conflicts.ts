import {
  listConflicts,
  resolveConflict,
} from '../../../core/coordination/conflicts.js';
import type { ConflictRecord } from '../../../core/coordination/conflicts.js';
import { listAgents } from '../../../core/coordination/agents.js';
import { listFileClaims } from '../../../core/coordination/claims.js';
import { listClaimIntents } from '../../../core/coordination/bulk_claims.js';
import { getConflictTriageDetail } from '../../../core/coordination/conflict_triage.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateNonEmptyString,
  CONFLICTS_LIST_INPUT_SCHEMA,
  CONFLICT_RESOLVE_INPUT_SCHEMA,
  CONFLICT_DETAIL_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

function conflictLines(conflict: ConflictRecord): string[] {
  return [
    `conflict_id: ${conflict.conflict_id}`,
    `type: ${conflict.conflict_type}`,
    `status: ${conflict.status}`,
    `severity: ${conflict.severity}`,
    `files: ${conflict.involved_files.join(', ')}`,
    `agents: ${conflict.involved_agents.join(', ')}`,
  ];
}

export function buildConflictsListTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CONFLICTS_LIST_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_conflicts_list';
  const ALLOWED_KEYS = new Set(['status', 'conflict_type']);
  return {
    name: TOOL_NAME,
    title: 'List coordination conflicts',
    description:
      'List recorded coordination conflicts in the bound repo. Read-only. Filter by status (detected|resolved) or type (claim_denied|stale_claim).',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = (message: string): McpToolFormattedResult =>
        formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', message),
        });

      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail(unknown.message);

      const args = input.arguments ?? {};
      const status = args.status as string | undefined;
      const conflictType = args.conflict_type as string | undefined;

      if (status && status !== 'detected' && status !== 'resolved') {
        return fail(`invalid status: expected detected|resolved, got ${JSON.stringify(status)}`);
      }
      if (conflictType && conflictType !== 'claim_denied' && conflictType !== 'stale_claim') {
        return fail(`invalid conflict_type: expected claim_denied|stale_claim, got ${JSON.stringify(conflictType)}`);
      }

      try {
        const conflicts = listConflicts(input.context.repoRoot, {
          status: status as 'detected' | 'resolved' | undefined,
          conflict_type: conflictType as 'claim_denied' | 'stale_claim' | undefined,
        });
        const text = [`# Coordination conflicts (${conflicts.length})`, '']
          .concat(conflicts.map((c) => `- ${c.conflict_id} type=${c.conflict_type} status=${c.status} files=${c.involved_files.join(',')}`))
          .join('\n');
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text,
          data: { conflicts },
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('CONFLICTS_LIST_FAILED', err instanceof Error ? err.message : String(err)),
        });
      }
    },
  };
}

export function buildConflictResolveTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CONFLICT_RESOLVE_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_conflict_resolve';
  const ALLOWED_KEYS = new Set(['conflict_id']);
  return {
    name: TOOL_NAME,
    title: 'Resolve a coordination conflict',
    description:
      'Mark a coordination conflict as resolved in the bound repo. Writes only generated .vibecode/coordination/state.json.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = (code: 'INVALID_ARGUMENT' | 'CONFLICT_RESOLVE_FAILED', message: string): McpToolFormattedResult =>
        formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(code, message),
        });

      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);

      const conflictId = validateNonEmptyString((input.arguments ?? {}).conflict_id, 'conflict_id');
      if (!conflictId.ok) return fail('INVALID_ARGUMENT', conflictId.message);

      try {
        const result = resolveConflict(input.context.repoRoot, conflictId.value, {
          resolved_at: new Date().toISOString(),
        });
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: ['# Resolved conflict', '', ...conflictLines(result)].join('\n'),
          data: { conflict: result },
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('CONFLICT_RESOLVE_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function buildConflictDetailTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CONFLICT_DETAIL_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_conflict_detail';
  const ALLOWED_KEYS = new Set(['conflict_id']);
  return {
    name: TOOL_NAME,
    title: 'Conflict triage detail',
    description:
      'Get intent-aware triage detail for one coordination conflict: blocking claim/intent, owner lifecycle status, warning codes, and safe next-step recommendations. Read-only.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = (code: 'INVALID_ARGUMENT' | 'CONFLICT_DETAIL_FAILED', message: string): McpToolFormattedResult =>
        formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(code, message),
        });

      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);

      const conflictId = validateNonEmptyString((input.arguments ?? {}).conflict_id, 'conflict_id');
      if (!conflictId.ok) return fail('INVALID_ARGUMENT', conflictId.message);

      try {
        const conflicts = listConflicts(input.context.repoRoot);
        const agents = listAgents(input.context.repoRoot);
        const claims = listFileClaims(input.context.repoRoot, { includeReleased: true });
        const intents = listClaimIntents(input.context.repoRoot);

        const detail = getConflictTriageDetail({
          conflictId: conflictId.value,
          agents,
          claims,
          intents,
          conflicts,
        });

        if (!detail) {
          return fail('INVALID_ARGUMENT', `Conflict not found: ${conflictId.value}`);
        }

        const text = [
          '# Conflict triage detail',
          '',
          `conflict_id: ${detail.conflict_id}`,
          `type: ${detail.conflict_type}`,
          `triage_status: ${detail.triage_status}`,
          `stored_status: ${detail.stored_status}`,
          `created_at: ${detail.created_at}`,
          `files: ${detail.involved_files.join(', ')}`,
          `requesting_agent: ${detail.requesting_agent_id ?? '(none)'} (${detail.requesting_agent_status})`,
          `blocking_agent: ${detail.blocking_agent_id ?? '(none)'} (${detail.blocking_agent_status})`,
          `still_actively_blocking: ${detail.still_actively_blocking}`,
          `blocking_claim_released: ${detail.blocking_claim_released}`,
        ];
        if (detail.blocking_intent) {
          text.push(`blocking_intent: ${detail.blocking_intent.intent_id} [${detail.blocking_intent.status}] "${detail.blocking_intent.intent}"`);
        }
        if (detail.warning_codes.length > 0) {
          text.push(`warnings: ${detail.warning_codes.join(', ')}`);
        }
        if (detail.recommended_next_tools.length > 0) {
          text.push('', 'recommended_next_tools:');
          for (const t of detail.recommended_next_tools) text.push(`  - ${t}`);
        }
        if (detail.recommended_cli_commands.length > 0) {
          text.push('', 'recommended_cli_commands:');
          for (const c of detail.recommended_cli_commands) text.push(`  - ${c}`);
        }

        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: text.join('\n'),
          data: { conflict: detail },
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('CONFLICT_DETAIL_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
