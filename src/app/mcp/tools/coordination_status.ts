import {
  getCoordinationStatus,
  type CoordinationStatusResult,
} from '../../../core/coordination/status.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  COORDINATION_STATUS_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

const TOOL_NAME = 'vibecode_coordination_status';
const ALLOWED_KEYS = new Set<string>();

function renderText(result: CoordinationStatusResult): string {
  const lines: string[] = ['# Vibecode coordination status', ''];
  lines.push(`repo_root: ${result.workspace_root}`);
  lines.push(`state_file: ${result.state_file} (${result.state_file_exists ? 'exists' : 'absent'})`);
  lines.push(`version: ${result.version}`);
  lines.push(`last_updated: ${result.last_updated}`);
  lines.push('');
  lines.push(
    `agents=${result.summary.agents} claims=${result.summary.claims} conflicts=${result.summary.conflicts} handoffs=${result.summary.handoffs}`,
  );
  lines.push('');
  lines.push('Advisory coordination model — no source files are locked.');
  return lines.join('\n');
}

/**
 * Phase Coordination-1: read-only multi-agent coordination status.
 *
 * Calls the shared core service (`core/coordination/status`) — the same service
 * the `vibecode coordination status` CLI command uses — so MCP and CLI return
 * equivalent data. The repo is bound to the server at startup; this tool never
 * accepts a repo argument and never shells out to the CLI.
 */
export function buildCoordinationStatusTool(): McpToolDefinition {
  const inputSchema: JsonSchema = COORDINATION_STATUS_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode coordination status',
    description:
      'Read-only multi-agent coordination status for the bound repo: schema version, whether generated state exists, and counts of agents/claims/conflicts/handoffs. Advisory model — no source-file locks. Read-only.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', unknown.message),
        });
      }

      let result: CoordinationStatusResult;
      try {
        result = getCoordinationStatus(input.context.repoRoot);
      } catch (err) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(
            'COORDINATION_STATUS_FAILED',
            err instanceof Error ? err.message : String(err),
          ),
        });
      }

      const data = {
        workspace_root: result.workspace_root,
        state_file: result.state_file,
        state_file_exists: result.state_file_exists,
        version: result.version,
        last_updated: result.last_updated,
        summary: result.summary,
      };

      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: renderText(result),
        data,
        durationMs: Date.now() - started,
      });
    },
  };
}
