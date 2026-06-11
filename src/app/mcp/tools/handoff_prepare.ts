import {
  getAgentHandoffPacket,
  type AgentHandoffPacket,
} from '../../../core/agent_session/handoff_packet.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateBoundedInteger,
  validateNonEmptyString,
  HANDOFF_PREPARE_INPUT_SCHEMA,
  HARD_MAX_HANDOFF_ITEMS,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

/**
 * Phase 4A — `vibecode_handoff_prepare`.
 *
 * Thin wrapper over the shared core service (`core/agent_session/handoff_packet`)
 * — the same service the `vibecode handoff prepare` CLI command uses, so MCP
 * and CLI return equivalent data. STRICTLY read-only: it never registers,
 * heartbeats, releases, claims, reaps, resolves, transfers ownership, assigns
 * the next agent, or mutates git/source/coordination state. Terminated or
 * missing agents are reported as a handoff state inside the packet, not as a
 * tool error and never as a mutation.
 */
const TOOL_NAME = 'vibecode_handoff_prepare';
const ALLOWED_KEYS = new Set(['agent_id', 'max_items']);

function renderText(packet: AgentHandoffPacket): string {
  const lines: string[] = ['# Vibecode handoff packet', ''];
  lines.push(`agent: ${packet.agent_id} (${packet.agent.status ?? 'missing'}) mode=${packet.agent.operating_mode ?? 'unset'}`);
  if (packet.agent.task) lines.push(`task: ${packet.agent.task}${packet.agent.task_truncated ? '…' : ''}`);
  lines.push(`Handoff: ${packet.handoff.summary}`);
  lines.push(
    `handoff_ready=${packet.handoff.handoff_ready ? 'yes' : 'no'}`
      + ` next_agent_may_continue=${packet.handoff.next_agent_may_continue ? 'yes' : 'no'}`
      + ` requires_current_agent_action=${packet.handoff.requires_current_agent_action ? 'yes' : 'no'}`,
  );
  if (packet.handoff.required_before_handoff.length > 0) {
    lines.push(`required_before_handoff: ${packet.handoff.required_before_handoff.join(', ')}`);
  }
  lines.push(
    `owned_work: claims=${packet.owned_work.active_claims_count} intents=${packet.owned_work.active_intents_count}`
      + ` releasable=${packet.owned_work.releasable_intents_count} dirty_claimed=${packet.owned_work.dirty_claimed_files_count}`,
  );
  lines.push(
    `workspace: dirty=${packet.workspace.dirty ? 'yes' : 'no'} unclaimed_dirty=${packet.workspace.unclaimed_dirty_count}`
      + ` staged_unclaimed=${packet.workspace.staged_unclaimed_count} staged_other_agent=${packet.workspace.staged_other_agent_count}`,
  );
  lines.push(
    `coordination: conflicts_involving_agent=${packet.coordination.conflicts_involving_agent_count}`
      + ` still_blocking=${packet.coordination.still_blocking_conflicts_involving_agent_count}`
      + ` stale_coordination=${packet.coordination.stale_coordination_present ? 'yes' : 'no'}`,
  );
  if (packet.blockers.length > 0) {
    lines.push('', 'blockers:');
    for (const b of packet.blockers) lines.push(`  - [${b.code}] ${b.message}`);
  }
  if (packet.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const w of packet.warnings) lines.push(`  - [${w.code}] ${w.message}`);
  }
  lines.push('', 'safe_cli_commands:');
  for (const c of packet.safe_cli_commands) lines.push(`  - ${c}`);
  lines.push('', 'next_agent_cli_commands:');
  for (const c of packet.next_agent_cli_commands) lines.push(`  - ${c}`);
  lines.push('', 'do_not_do:');
  for (const d of packet.do_not_do) lines.push(`  - ${d}`);
  return lines.join('\n');
}

export function buildHandoffPrepareTool(): McpToolDefinition {
  const inputSchema: JsonSchema = HANDOFF_PREPARE_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode handoff prepare',
    description:
      'Build a bounded, READ-ONLY handoff packet for one agent: who is handing off, owned claims/intents, dirty/staged shared-tree state, conflicts, one handoff_state with what must happen before another agent continues, exact safe next commands, and do_not_do boundaries. Visibility only — it never transfers claims, assigns the next agent, releases, claims, or cleans anything; the next agent always registers separately.',
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

      const agentId = validateNonEmptyString(args.agent_id, 'agent_id');
      if (!agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);

      const maxItems = validateBoundedInteger(args.max_items, 'max_items', HARD_MAX_HANDOFF_ITEMS);
      if (!maxItems.ok) return fail('INVALID_ARGUMENT', maxItems.message);

      try {
        const packet = getAgentHandoffPacket(input.context.repoRoot, {
          agent_id: agentId.value,
          max_items: maxItems.value,
        });
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderText(packet),
          data: packet,
          warnings: packet.warnings.map((w) => `${w.code}: ${w.message}`),
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('HANDOFF_PREPARE_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
