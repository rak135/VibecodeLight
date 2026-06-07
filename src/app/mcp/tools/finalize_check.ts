import {
  getFinalizeCheck,
  type FinalizeCheckResult,
} from '../../../core/coordination/finalize_check.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateNonEmptyString,
  FINALIZE_CHECK_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

/**
 * Phase Coordination-4A: read-only agent-aware finalize check.
 *
 * Thin wrapper over the shared core service (`core/coordination/finalize_check`)
 * — the same service the `vibecode finalize check` CLI command uses, so MCP and
 * CLI return equivalent data. The repo is bound to the server at startup; this
 * tool never accepts a repo argument and never shells out to the CLI. It is
 * strictly read-only: it classifies the dirty working tree relative to the
 * agent's active advisory claims and never mutates git or coordination state.
 *
 * A completed check that finds blocking issues is a SUCCESS (isError=false,
 * status="blocked"); FINALIZE_CHECK_FAILED is reserved for invocation/internal
 * failures.
 */
const TOOL_NAME = 'vibecode_finalize_check';
const ALLOWED_KEYS = new Set(['agent_id', 'run_id']);

function renderText(result: FinalizeCheckResult): string {
  const lines: string[] = ['# Vibecode finalize check', ''];
  lines.push(`status: ${result.status}`);
  lines.push(`agent: ${result.agent ? `${result.agent.agent_id} (${result.agent.status})` : '(none)'}`);
  if (result.run_id) lines.push(`run: ${result.run_id}`);
  const s = result.summary;
  lines.push(
    `changed=${s.changed_count} allowed=${s.allowed_count} unclaimed=${s.unclaimed_count} other_claimed=${s.other_claimed_count} generated=${s.generated_ignored_count}`,
  );
  if (result.blocks.length > 0) {
    lines.push('', 'blocks:');
    for (const block of result.blocks) lines.push(`  - [${block.code}] ${block.path ?? ''} ${block.message}`);
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const warning of result.warnings) lines.push(`  - [${warning.code}] ${warning.path ?? ''} ${warning.message}`);
  }
  lines.push('', 'Advisory finalize check — read-only; not a commit guard.');
  return lines.join('\n');
}

export function buildFinalizeCheckTool(): McpToolDefinition {
  const inputSchema: JsonSchema = FINALIZE_CHECK_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode finalize check',
    description:
      'Read-only agent-aware finalize check for the bound repo: classifies the dirty working tree relative to the agent’s active advisory claims (allowed / unclaimed / claimed by another active agent / generated). Pass agent_id or run_id. Blocking findings are returned as ok=true with status="blocked". Read-only — never mutates git or coordination state; not a commit guard.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = (code: 'INVALID_ARGUMENT' | 'FINALIZE_CHECK_FAILED', message: string): McpToolFormattedResult =>
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
      const agentId = args.agent_id === undefined || args.agent_id === null
        ? undefined
        : validateNonEmptyString(args.agent_id, 'agent_id');
      if (agentId && !agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);
      const runId = args.run_id === undefined || args.run_id === null
        ? undefined
        : validateNonEmptyString(args.run_id, 'run_id');
      if (runId && !runId.ok) return fail('INVALID_ARGUMENT', runId.message);

      if (!agentId && !runId) {
        return fail('INVALID_ARGUMENT', 'finalize check requires agent_id or run_id.');
      }

      try {
        const result = getFinalizeCheck({
          repoRoot: input.context.repoRoot,
          agent_id: agentId ? agentId.value : undefined,
          run_id: runId ? runId.value : undefined,
        });
        // An invocation failure from core (no agent resolvable) → MCP error.
        if (!result.ok) {
          return fail('INVALID_ARGUMENT', result.blocks[0]?.message ?? 'finalize check could not resolve an agent.');
        }
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderText(result),
          data: result,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('FINALIZE_CHECK_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
