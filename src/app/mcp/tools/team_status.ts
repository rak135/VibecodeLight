import {
  getTeamStatusOverview,
  TEAM_STATUS_MAX_AGENTS,
  TEAM_STATUS_MAX_ITEMS,
  type TeamStatusOverview,
} from '../../../core/agent_session/team_status.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateBoundedInteger,
  TEAM_STATUS_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

/**
 * Phase 4C — `vibecode_team_status`.
 *
 * Thin wrapper over the shared core service (`core/agent_session/team_status`)
 * — the same service the `vibecode team status` CLI command uses, so MCP and
 * CLI return equivalent data. STRICTLY read-only: it never registers,
 * heartbeats, releases, claims, reaps, resolves, transfers ownership, assigns
 * the next agent, or mutates/git/source/coordination state.
 */
const TOOL_NAME = 'vibecode_team_status';
const ALLOWED_KEYS = new Set(['max_agents', 'max_items']);

function renderText(overview: TeamStatusOverview): string {
  const lines: string[] = ['# Vibecode team status', ''];
  const s = overview.summary;
  lines.push(
    `Team: ${s.agents_active} active, ${s.agents_stale} stale, ${s.agents_terminated} terminated;`
      + ` ${s.active_claims} active claims; ${s.active_intents} active intents;`
      + ` ${s.unresolved_conflicts} unresolved conflict(s);`
      + ` stale_coordination=${s.stale_coordination_present ? 'yes' : 'no'}`,
  );
  lines.push(
    `workspace: dirty=${overview.workspace.dirty ? 'yes' : 'no'}`
      + ` staged_blockers=${s.staged_blockers_present ? 'yes' : 'no'}`,
  );
  if (overview.agents.length > 0) {
    lines.push('', 'Agents:');
    for (const a of overview.agents) {
      lines.push(
        `  - ${a.agent_id} ${a.mode ?? 'unset'} ${a.status}: ${a.recommended_action}`
          + ` — ${a.active_claims_count} claims, ${a.active_intents_count} intents`,
      );
    }
  }
  if (overview.agents_truncated) {
    lines.push(`  (agents truncated at ${overview.agents.length})`);
  }
  if (overview.blockers.length > 0) {
    lines.push('', 'blockers:');
    for (const b of overview.blockers) lines.push(`  - ${b}`);
  }
  if (overview.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const w of overview.warnings) lines.push(`  - ${w}`);
  }
  if (overview.recommended_cli_commands.length > 0) {
    lines.push('', 'recommended_cli_commands:');
    for (const c of overview.recommended_cli_commands) lines.push(`  - ${c}`);
  }
  return lines.join('\n');
}

export function buildTeamStatusTool(): McpToolDefinition {
  const inputSchema: JsonSchema = TEAM_STATUS_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode team status',
    description:
      'Read-only team status / team overview for multi-agent coordination. Shows all agents with their status, claims, intents, conflicts, and safe next commands. Use at the start of multi-agent coordination to see who is active, stale, blocked, or ready for handoff. Observability and guidance only — it never assigns work, transfers ownership, or auto-cleans.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = (code: McpErrorCode, message: string): McpToolFormattedResult =>
        formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(code, message),
        });

      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);

      const args = (input.arguments ?? {}) as Record<string, unknown>;

      const maxAgents = validateBoundedInteger(args.max_agents, 'max_agents', TEAM_STATUS_MAX_AGENTS);
      if (!maxAgents.ok) return fail('INVALID_ARGUMENT', maxAgents.message);

      const maxItems = validateBoundedInteger(args.max_items, 'max_items', TEAM_STATUS_MAX_ITEMS);
      if (!maxItems.ok) return fail('INVALID_ARGUMENT', maxItems.message);

      try {
        const overview = getTeamStatusOverview(input.context.repoRoot, {
          max_agents: maxAgents.value,
          max_items: maxItems.value,
        });
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderText(overview),
          data: overview,
          warnings: overview.warnings,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('TEAM_STATUS_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
