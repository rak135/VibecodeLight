import type { CoordinationPromptContext } from '../coordination/prompt_context.js';

/**
 * Render the visible "# Multi-Agent Coordination" section for final_prompt.md.
 *
 * Pure and deterministic: the same {@link CoordinationPromptContext} always
 * produces the same markdown. This is the ONLY place the coordination block text
 * is produced; it is rendered into final_prompt.md (the truth) by the renderer,
 * never injected into the terminal after preview.
 *
 * The block is intentionally compact: current agent identity, this agent's
 * claims, other active agents' claims (off-limits), short advisory instructions,
 * and mode-specific tool/command reminders. It does not dump the whole
 * coordination state.
 */

const MODE_LABELS = {
  mcp: 'MCP-capable',
  cli: 'CLI-only',
  unknown: 'unknown',
} as const;

function renderMcpTools(): string[] {
  return [
    'You have MCP coordination tools. Use them:',
    '- vibecode_claim_add — claim a file before editing it',
    '- vibecode_claims_list — list current claims',
    '- vibecode_claim_status — check a path before editing',
    '- vibecode_claim_release — release a claim when you are done',
  ];
}

function renderCliCommands(agentId: string, mode: CoordinationPromptContext['agent_mode']): string[] {
  const lines: string[] = [];
  if (mode === 'unknown') {
    lines.push('Agent tooling is unknown; use the Vibecode CLI commands as the safe default:');
  } else {
    lines.push('Use the Vibecode CLI for coordination:');
  }
  lines.push(
    `- vibecode claims add --agent ${agentId} --path <path> --type exclusive --json`,
    '- vibecode claims list --json',
    '- vibecode claims status --path <path> --json',
    '- vibecode claims release --claim <claim_id> --json',
  );
  return lines;
}

/** Render the coordination section markdown (no trailing newline). */
export function renderCoordinationSection(ctx: CoordinationPromptContext): string {
  const agentId = ctx.agent_id ?? 'unknown';
  const agentName = ctx.agent_name ?? ctx.agent_id ?? 'unknown';
  const lines: string[] = [
    '# Multi-Agent Coordination',
    '',
    'Other agents may be working in this repository. Coordination is advisory: claim files before editing and respect other agents’ active claims.',
    '',
    'Agent:',
    `- id: ${agentId}`,
    `- name: ${agentName}`,
    `- mode: ${MODE_LABELS[ctx.agent_mode]}`,
  ];
  if (ctx.terminal_session_id) {
    lines.push(`- terminal session: ${ctx.terminal_session_id}`);
  }

  lines.push('', 'Claims held by this agent:');
  if (ctx.held_claims.length === 0) {
    lines.push('- _None_');
  } else {
    for (const claim of ctx.held_claims) {
      lines.push(`- ${claim.path} (${claim.mode})`);
    }
  }

  lines.push('', 'Files claimed by other active agents (do not edit):');
  if (ctx.other_claims.length === 0) {
    lines.push('- _None_');
  } else {
    for (const claim of ctx.other_claims) {
      lines.push(`- ${claim.path} — claimed by ${claim.agent_name} (${claim.mode})`);
    }
  }

  lines.push(
    '',
    'Instructions:',
    '- Before editing a file, create an advisory claim for it.',
    '- Do not edit files claimed by other active agents.',
    '- Release your claims when you finish with them.',
    '- Coordination is advisory; finalize/commit guards are not active in this phase.',
    '',
  );

  if (ctx.agent_mode === 'mcp') {
    lines.push(...renderMcpTools());
  } else {
    lines.push(...renderCliCommands(agentId, ctx.agent_mode));
  }

  return lines.join('\n');
}
