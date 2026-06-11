import path from 'path';

import { Command } from 'commander';

import {
  getAgentHandoffPacket,
  HANDOFF_MAX_ITEMS,
  type AgentHandoffPacket,
} from '../../../core/agent_session/handoff_packet.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface HandoffCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

/**
 * Register `vibecode handoff …` commands (Phase 4A).
 *
 * Ships the `prepare` subcommand: a thin wrapper over the shared core service
 * (`core/agent_session/handoff_packet`) — the same service the MCP tool
 * `vibecode_handoff_prepare` uses — so CLI and MCP return equivalent data.
 * Strictly read-only: it never registers, heartbeats, releases, claims, reaps,
 * transfers ownership, assigns the next agent, or mutates git/source state.
 */
export function registerHandoffCommands(
  program: Command,
  dependencies: HandoffCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const handoff = program
    .command('handoff')
    .description('Team handoff visibility (read-only; never transfers ownership)');

  handoff
    .command('prepare')
    .description('Build a bounded read-only handoff packet for one agent (visibility + boundaries, no transfer)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Agent id to prepare the handoff packet for')
    .option('--max-items <n>', 'Cap on sample lists in the packet')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; maxItems?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);

      if (!options.agent || options.agent.trim().length === 0) {
        emitCliStructuredError(
          makeCliStructuredError(
            'MISSING_REQUIRED_OPTION',
            'handoff prepare requires --agent.',
            repoRoot,
            ['Missing: --agent <agent_id>'],
          ),
          { json: options.json, prefix: 'handoff prepare failed' },
        );
        return;
      }

      let maxItems: number | undefined;
      if (options.maxItems !== undefined) {
        const raw = Number(options.maxItems);
        if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
          emitCliStructuredError(
            makeCliStructuredError(
              'INVALID_ARGUMENT',
              `invalid --max-items: expected a positive integer, got ${JSON.stringify(options.maxItems)}`,
              repoRoot,
            ),
            { json: options.json, prefix: 'handoff prepare failed' },
          );
          return;
        }
        if (raw > HANDOFF_MAX_ITEMS) {
          emitCliStructuredError(
            makeCliStructuredError(
              'INVALID_ARGUMENT',
              `invalid --max-items: value ${raw} exceeds maximum ${HANDOFF_MAX_ITEMS}`,
              repoRoot,
            ),
            { json: options.json, prefix: 'handoff prepare failed' },
          );
          return;
        }
        maxItems = raw;
      }

      let packet: AgentHandoffPacket;
      try {
        packet = getAgentHandoffPacket(repoRoot, {
          agent_id: options.agent.trim(),
          max_items: maxItems,
        });
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError(
            'HANDOFF_PREPARE_FAILED',
            error instanceof Error ? error.message : String(error),
            repoRoot,
          ),
          { json: options.json, prefix: 'handoff prepare failed' },
        );
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: packet,
          artifacts: [],
          warnings: packet.warnings.map((w) => `${w.code}: ${w.message}`),
        }));
        return;
      }

      printHuman(packet);
    });
}

function printHuman(packet: AgentHandoffPacket): void {
  console.log(`agent: ${packet.agent_id} (${packet.agent.status ?? 'missing'}) mode=${packet.agent.operating_mode ?? 'unset'}`);
  if (packet.agent.task) {
    console.log(`task: ${packet.agent.task}${packet.agent.task_truncated ? '…' : ''}`);
  }
  console.log(`Handoff: ${packet.handoff.summary}`);
  console.log(
    `handoff_ready=${packet.handoff.handoff_ready ? 'yes' : 'no'}`
      + ` next_agent_may_continue=${packet.handoff.next_agent_may_continue ? 'yes' : 'no'}`
      + ` requires_current_agent_action=${packet.handoff.requires_current_agent_action ? 'yes' : 'no'}`,
  );
  if (packet.handoff.required_before_handoff.length > 0) {
    console.log(`required_before_handoff: ${packet.handoff.required_before_handoff.join(', ')}`);
  }
  console.log(
    `owned_work: claims=${packet.owned_work.active_claims_count} intents=${packet.owned_work.active_intents_count}`
      + ` releasable=${packet.owned_work.releasable_intents_count} dirty_claimed=${packet.owned_work.dirty_claimed_files_count}`,
  );
  console.log(
    `workspace: dirty=${packet.workspace.dirty ? 'yes' : 'no'} unclaimed_dirty=${packet.workspace.unclaimed_dirty_count}`
      + ` staged_unclaimed=${packet.workspace.staged_unclaimed_count} staged_other_agent=${packet.workspace.staged_other_agent_count}`,
  );
  console.log(
    `coordination: conflicts_involving_agent=${packet.coordination.conflicts_involving_agent_count}`
      + ` still_blocking=${packet.coordination.still_blocking_conflicts_involving_agent_count}`
      + ` stale_coordination=${packet.coordination.stale_coordination_present ? 'yes' : 'no'}`,
  );
  if (packet.blockers.length > 0) {
    console.log('blockers:');
    for (const b of packet.blockers) console.log(`  [${b.code}] ${b.message}`);
  }
  if (packet.warnings.length > 0) {
    console.log('warnings:');
    for (const w of packet.warnings) console.log(`  [${w.code}] ${w.message}`);
  }
  console.log('safe_cli_commands:');
  for (const c of packet.safe_cli_commands) console.log(`  - ${c}`);
  console.log('next_agent_cli_commands:');
  for (const c of packet.next_agent_cli_commands) console.log(`  - ${c}`);
  console.log('do_not_do:');
  for (const d of packet.do_not_do) console.log(`  - ${d}`);
}
