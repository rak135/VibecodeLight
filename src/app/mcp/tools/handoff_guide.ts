import {
  getNextAgentHandoffGuide,
  type NextAgentHandoffGuide,
} from '../../../core/agent_session/handoff_guide.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateBoundedInteger,
  validateNonEmptyString,
  HANDOFF_GUIDE_INPUT_SCHEMA,
  HARD_MAX_HANDOFF_ITEMS,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

/**
 * Phase 4B — `vibecode_handoff_guide`.
 *
 * Thin wrapper over the shared core service (`core/agent_session/handoff_guide`)
 * — the same service the `vibecode handoff guide` CLI command uses, so MCP and
 * CLI return equivalent data. STRICTLY read-only: it never registers,
 * heartbeats, releases, claims, reaps, resolves, transfers ownership, assigns
 * the next agent, or mutates git/source/coordination state. Missing previous
 * or next agents are reported as safe onboarding states inside the guide, not
 * as tool errors and never as mutations.
 */
const TOOL_NAME = 'vibecode_handoff_guide';
const ALLOWED_KEYS = new Set(['from_agent_id', 'for_agent_id', 'max_items']);

function renderText(guide: NextAgentHandoffGuide): string {
  const lines: string[] = ['# Vibecode handoff guide', ''];
  lines.push(`from_agent: ${guide.from_agent_id} (${guide.handoff_source.handoff_state})`);
  lines.push(
    `next_agent: ${guide.for_agent_id ?? 'not specified'}`
      + ` registered=${guide.next_agent.registered ? 'yes' : 'no'}`
      + ` status=${guide.next_agent.status ?? 'n/a'} mode=${guide.next_agent.operating_mode ?? 'n/a'}`,
  );
  lines.push(`Onboarding: ${guide.onboarding.summary}`);
  lines.push(
    `can_continue_now=${guide.onboarding.can_continue_now ? 'yes' : 'no'}`
      + ` can_register_and_plan=${guide.onboarding.can_register_and_plan ? 'yes' : 'no'}`
      + ` must_claim_explicitly=yes ownership_transferred=no`
      + ` same_agent_resume=${guide.onboarding.same_agent_resume ? 'yes' : 'no'}`,
  );
  if (guide.required_before_continue.length > 0) {
    lines.push(`required_before_continue: ${guide.required_before_continue.join(', ')}`);
  }
  if (guide.blocked_paths.length > 0) {
    lines.push(
      `blocked_paths (still claimed by ${guide.from_agent_id}${guide.paths_truncated ? ', truncated' : ''}):`,
    );
    for (const p of guide.blocked_paths) lines.push(`  - ${p}`);
  }
  if (guide.blockers.length > 0) {
    lines.push('', 'blockers:');
    for (const b of guide.blockers) lines.push(`  - [${b.code}] ${b.message}`);
  }
  if (guide.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const w of guide.warnings) lines.push(`  - [${w.code}] ${w.message}`);
  }
  if (guide.previous_agent_cli_commands.length > 0) {
    lines.push('', `previous_agent_cli_commands (run by ${guide.from_agent_id} only):`);
    for (const c of guide.previous_agent_cli_commands) lines.push(`  - ${c}`);
  }
  lines.push('', 'next_agent_cli_commands:');
  for (const c of guide.next_agent_cli_commands) lines.push(`  - ${c}`);
  lines.push('', 'do_not_do:');
  for (const d of guide.do_not_do) lines.push(`  - ${d}`);
  return lines.join('\n');
}

export function buildHandoffGuideTool(): McpToolDefinition {
  const inputSchema: JsonSchema = HANDOFF_GUIDE_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode handoff guide',
    description:
      'READ-ONLY next-agent onboarding guidance from a previous agent\'s handoff packet: one onboarding_state (is the previous agent ready, is its work still claimed, may the next agent register/continue), blocked paths still claimed by the previous agent, exact safe next commands separated by which agent runs them, and do_not_do boundaries. Guidance only — it never transfers ownership, never auto-claims/releases, and never assigns the next agent; the next agent always registers separately and claims exact files itself.',
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

      const fromAgentId = validateNonEmptyString(args.from_agent_id, 'from_agent_id');
      if (!fromAgentId.ok) return fail('INVALID_ARGUMENT', fromAgentId.message);

      let forAgentId: string | undefined;
      if (args.for_agent_id !== undefined && args.for_agent_id !== null) {
        const forAgent = validateNonEmptyString(args.for_agent_id, 'for_agent_id');
        if (!forAgent.ok) return fail('INVALID_ARGUMENT', forAgent.message);
        forAgentId = forAgent.value;
      }

      const maxItems = validateBoundedInteger(args.max_items, 'max_items', HARD_MAX_HANDOFF_ITEMS);
      if (!maxItems.ok) return fail('INVALID_ARGUMENT', maxItems.message);

      try {
        const guide = getNextAgentHandoffGuide(input.context.repoRoot, {
          from_agent_id: fromAgentId.value,
          for_agent_id: forAgentId,
          max_items: maxItems.value,
        });
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderText(guide),
          data: guide,
          warnings: guide.warnings.map((w) => `${w.code}: ${w.message}`),
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('HANDOFF_GUIDE_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
