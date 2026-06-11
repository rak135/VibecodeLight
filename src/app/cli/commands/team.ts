import path from 'path';

import { Command } from 'commander';

import {
  getTeamStatusOverview,
  TEAM_STATUS_MAX_AGENTS,
  TEAM_STATUS_MAX_ITEMS,
  type TeamStatusOverview,
} from '../../../core/agent_session/team_status.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface TeamCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

/**
 * Register `vibecode team …` commands (Phase 4C).
 *
 * Ships the `status` subcommand: a thin wrapper over the shared core service
 * (`core/agent_session/team_status`) — the same service the
 * `vibecode_team_status` MCP tool uses — so CLI and MCP return equivalent
 * data. Strictly read-only: never registers, heartbeats, releases, claims,
 * reaps, transfers ownership, assigns the next agent, or mutates git/source
 * state.
 */
export function registerTeamCommands(
  program: Command,
  dependencies: TeamCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const team = program
    .command('team')
    .description('Team coordination overview (read-only; never assigns work)');

  team
    .command('status')
    .description('Read-only team status: all agents, claims, intents, conflicts, and safe next commands')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--max-agents <n>', 'Cap on number of agents in the overview')
    .option('--max-items <n>', 'Cap on sample lists')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; maxAgents?: string; maxItems?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);

      let maxAgents: number | undefined;
      if (options.maxAgents !== undefined) {
        const raw = Number(options.maxAgents);
        if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
          emitCliStructuredError(
            makeCliStructuredError(
              'INVALID_ARGUMENT',
              `invalid --max-agents: expected a positive integer, got ${JSON.stringify(options.maxAgents)}`,
              repoRoot,
            ),
            { json: options.json, prefix: 'team status failed' },
          );
          return;
        }
        if (raw > TEAM_STATUS_MAX_AGENTS) {
          emitCliStructuredError(
            makeCliStructuredError(
              'INVALID_ARGUMENT',
              `invalid --max-agents: value ${raw} exceeds maximum ${TEAM_STATUS_MAX_AGENTS}`,
              repoRoot,
            ),
            { json: options.json, prefix: 'team status failed' },
          );
          return;
        }
        maxAgents = raw;
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
            { json: options.json, prefix: 'team status failed' },
          );
          return;
        }
        if (raw > TEAM_STATUS_MAX_ITEMS) {
          emitCliStructuredError(
            makeCliStructuredError(
              'INVALID_ARGUMENT',
              `invalid --max-items: value ${raw} exceeds maximum ${TEAM_STATUS_MAX_ITEMS}`,
              repoRoot,
            ),
            { json: options.json, prefix: 'team status failed' },
          );
          return;
        }
        maxItems = raw;
      }

      let overview: TeamStatusOverview;
      try {
        overview = getTeamStatusOverview(repoRoot, {
          max_agents: maxAgents,
          max_items: maxItems,
        });
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError(
            'TEAM_STATUS_FAILED',
            error instanceof Error ? error.message : String(error),
            repoRoot,
          ),
          { json: options.json, prefix: 'team status failed' },
        );
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: overview,
          artifacts: [],
          warnings: overview.warnings,
        }));
        return;
      }

      printHuman(overview);
    });
}

function printHuman(overview: TeamStatusOverview): void {
  const s = overview.summary;
  console.log(
    `Team: ${s.agents_active} active, ${s.agents_stale} stale, ${s.agents_terminated} terminated;`
      + ` ${s.active_claims} active claims; ${s.active_intents} active intents;`
      + ` ${s.unresolved_conflicts} unresolved conflict(s);`
      + ` stale_coordination=${s.stale_coordination_present ? 'yes' : 'no'}`,
  );
  console.log(
    `workspace: dirty=${overview.workspace.dirty ? 'yes' : 'no'}`
      + ` staged_blockers=${s.staged_blockers_present ? 'yes' : 'no'}`,
  );
  if (overview.agents.length > 0) {
    console.log('Agents:');
    for (const a of overview.agents) {
      console.log(
        `  - ${a.agent_id} ${a.mode ?? 'unset'} ${a.status}: ${a.recommended_action}`
          + ` — ${a.active_claims_count} claims, ${a.active_intents_count} intents`,
      );
    }
  }
  if (overview.agents_truncated) {
    console.log(`  (agents truncated at ${overview.agents.length})`);
  }
  if (overview.blockers.length > 0) {
    console.log('blockers:');
    for (const b of overview.blockers) console.log(`  - ${b}`);
  }
  if (overview.warnings.length > 0) {
    console.log('warnings:');
    for (const w of overview.warnings) console.log(`  - ${w}`);
  }
  if (overview.recommended_cli_commands.length > 0) {
    console.log('Next:');
    for (const c of overview.recommended_cli_commands) console.log(`  - ${c}`);
  }
}
