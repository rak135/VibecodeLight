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
    'You have VibecodeMCP v1 tools. Use them in this order:',
    '- Start or resume your session first with vibecode_session_start (mode=build for edits), then inspect the workspace with vibecode_workspace_snapshot.',
    '- Before editing files, claim the exact paths with vibecode_build_start (no directories, no globs). If it reports denied/blocked paths: do not edit those files — wait, choose other files, or coordinate.',
    '- If you discover more files to edit, extend your scope with vibecode_build_scope (same agent_id and intent_id).',
    '- While working, review claim-aware changes with vibecode_changes.',
    '- Before your final report, run vibecode_build_finish (pass your agent_id) to confirm every changed file is covered by your active claims; resolve any blocked or unclaimed file it reports.',
    '- Watcher evidence is CLI-only: review it with vibecode evidence list --repo <path> --json, or record it for the current changes with vibecode evidence scan --repo <path> --json.',
    '- Release clean claims you no longer need via vibecode_build_scope (release_paths) or vibecode_build_finish (release_clean_claims=true with your intent_id).',
    '- For handoff visibility use vibecode_handoff; ownership never transfers automatically.',
  ];
}

function renderCliCommands(agentId: string, mode: CoordinationPromptContext['agent_mode']): string[] {
  const lines: string[] = [];
  if (mode === 'unknown') {
    lines.push('Agent tooling is unknown; use the Vibecode CLI commands as the safe default (pass --repo <path> to target this repository):');
  } else {
    lines.push('Use the Vibecode CLI for coordination (pass --repo <path> to target this repository):');
  }
  lines.push(
    '- Inspect current state first: vibecode agents list --repo <path> --json',
    '- If you are not already registered: vibecode agents register --repo <path> --name <name> --type <type> --json',
    `- During long work, keep your session alive: vibecode agents heartbeat --repo <path> --agent ${agentId} --json`,
    `- Before editing a file, claim it: vibecode claims add --repo <path> --agent ${agentId} --path <path> --mode exclusive --json`,
    '- Check a path / list claims: vibecode claims status --repo <path> --path <path> --json — vibecode claims list --repo <path> --json',
    '- If a claim is denied (CLAIM_DENIED): do not edit the file. Inspect the blocking claims with vibecode conflicts list --json, then wait, choose another file, or retry with --mode shared only if compatible.',
    '- If stale claims block your work, run: vibecode claims reap --repo <path> --json to release claims from dead agents.',
    `- Before your final report, run the finalize check: vibecode finalize check --repo <path> --agent ${agentId} --json (add --run <run_id> if you have one); resolve any blocked or unclaimed file it reports.`,
    '- Review watcher evidence: vibecode evidence list --repo <path> --json — or record it for the current changes: vibecode evidence scan --repo <path> --json',
    '- Before your final report, release claims you no longer need: vibecode claims release --repo <path> --claim <claim_id> --json',
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
    '- Before your final report, run the finalize check (command/tool below) and resolve any blocked or unclaimed changed files.',
    `- If the task asks you to commit, create the scoped commit with the Vibecode commit guard (CLI): vibecode commit guard --repo <path> --agent ${agentId} --json (add --run <run_id> if you have one). It commits only files you claimed that the finalize check approved.`,
    '- Never use git add -A or broad git staging; let the commit guard stage only your claimed files.',
    '- Coordination is advisory. Finalize check and a scoped commit guard are available (claims-only; never broad git staging).',
    '- A live watcher may record advisory evidence while it runs, and you can record/list evidence manually (command/tool below). Watcher evidence is informational only — it never blocks, stages, or reverts. The finalize check and the scoped commit guard remain the enforcement path.',
    '- Handoffs are visibility-only: ownership never transfers automatically, and a next agent must claim files itself.',
    '- Final report: Report which claims you created, retained, released, or could not obtain.',
    '',
  );

  if (ctx.agent_mode === 'mcp') {
    lines.push(...renderMcpTools());
  } else {
    lines.push(...renderCliCommands(agentId, ctx.agent_mode));
  }

  return lines.join('\n');
}
