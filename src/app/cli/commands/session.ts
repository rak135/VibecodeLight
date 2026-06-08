import path from 'path';

import { Command } from 'commander';

import {
  getSessionBootstrap,
  SESSION_BOOTSTRAP_MAX_ITEMS,
  type SessionBootstrapResult,
} from '../../../core/agent_session/bootstrap.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface SessionCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

/**
 * Register `vibecode session …` commands (Phase 1A).
 *
 * Ships the `bootstrap` subcommand: a thin wrapper over the shared core service
 * (`core/agent_session/bootstrap`) — the same service the MCP tool
 * `vibecode_session_bootstrap` uses — so CLI and MCP return equivalent data.
 * Read-only by default; it writes only generated coordination state when asked
 * to register (`--register`) or heartbeat (`--agent`). It never mutates git or
 * source files.
 */
export function registerSessionCommands(
  program: Command,
  dependencies: SessionCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const session = program
    .command('session')
    .description('Agent session orientation (advisory; read-only by default)');

  session
    .command('bootstrap')
    .description('One-call orientation: git/run/agents/claims/conflicts/scan/codegraph + protocol + next steps')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Existing agent id to heartbeat/refresh')
    .option('--register', 'Register a NEW agent (requires --agent-mode and --task)')
    .option('--agent-mode <mode>', 'Operating mode for a new registration: read_only | build')
    .option('--name <name>', 'Human-friendly agent name for a new registration')
    .option('--type <type>', 'Agent type for a new registration: claude | codex | hermes | opencode | custom')
    .option('--task <text>', 'Task/intent for the session (required with --register)')
    .option('--terminal-session <id>', 'Owning terminal session id')
    .option('--run-ref <ref>', 'Run selection: current | latest | <run_id>', 'current')
    .option('--max-items <n>', 'Cap on per-section item lists')
    .option('--no-instructions', 'Skip the bounded project-instruction excerpt')
    .option('--json', 'Output canonical JSON envelope')
    .action(async (options: {
      repo: string;
      agent?: string;
      register?: boolean;
      agentMode?: string;
      name?: string;
      type?: string;
      task?: string;
      terminalSession?: string;
      runRef?: string;
      maxItems?: string;
      instructions?: boolean;
      json?: boolean;
    }) => {
      const repoRoot = path.resolve(options.repo);

      // Strict numeric validation for --max-items.
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
            { json: options.json, prefix: 'session bootstrap failed' },
          );
          return;
        }
        if (raw > SESSION_BOOTSTRAP_MAX_ITEMS) {
          emitCliStructuredError(
            makeCliStructuredError(
              'INVALID_ARGUMENT',
              `invalid --max-items: value ${raw} exceeds maximum ${SESSION_BOOTSTRAP_MAX_ITEMS}`,
              repoRoot,
            ),
            { json: options.json, prefix: 'session bootstrap failed' },
          );
          return;
        }
        maxItems = raw;
      }

      let result: SessionBootstrapResult;
      try {
        result = await getSessionBootstrap({
          repoRoot,
          agent_id: options.agent,
          register: options.register === true,
          agent_mode: options.agentMode,
          agent_name: options.name,
          agent_type: options.type,
          task: options.task,
          terminal_session_id: options.terminalSession,
          run_ref: options.runRef,
          max_items: maxItems,
          include_instructions: options.instructions !== false,
        });
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError(
            'SESSION_BOOTSTRAP_FAILED',
            error instanceof Error ? error.message : String(error),
            repoRoot,
          ),
          { json: options.json, prefix: 'session bootstrap failed' },
        );
        return;
      }

      if (!result.ok) {
        const blocker = result.blockers[0];
        emitCliStructuredError(
          makeCliStructuredError(
            blocker?.code ?? 'SESSION_BOOTSTRAP_FAILED',
            blocker?.message ?? 'session bootstrap failed',
            repoRoot,
          ),
          { json: options.json, prefix: 'session bootstrap failed' },
        );
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: result,
          artifacts: [],
          warnings: result.warnings.map((w) => `${w.code}: ${w.message}`),
        }));
        return;
      }

      printHuman(result);
    });
}

function printHuman(result: SessionBootstrapResult): void {
  console.log(`repo_root: ${result.repo_root}`);
  console.log(
    `git: branch=${result.git.branch ?? '(n/a)'} dirty=${result.git.dirty ? 'yes' : 'no'} changed=${result.git.changed_counts.total}`,
  );
  console.log(
    result.current_agent
      ? `agent: ${result.current_agent.agent_id} (${result.current_agent.status}) mode=${result.current_agent.operating_mode ?? 'unset'}`
      : 'agent: (none registered)',
  );
  console.log(
    `agents: total=${result.agents.total} active=${result.agents.active} stale=${result.agents.stale}`,
  );
  console.log(
    `claims: own=${result.claims.counts.own} other_active=${result.claims.counts.other_active} stale=${result.claims.counts.stale}`,
  );
  console.log(`conflicts_unresolved: ${result.conflicts.unresolved_count}`);
  console.log(`current_run: ${result.current_run.run_id ?? '(none)'} scan_available=${result.scan.current_run_scan_available ? 'yes' : 'no'}`);
  console.log(`codegraph: available=${result.codegraph.available ? 'yes' : 'no'} initialized=${result.codegraph.initialized ? 'yes' : 'no'}`);
  if (result.blockers.length > 0) {
    console.log('blockers:');
    for (const b of result.blockers) console.log(`  [${b.code}] ${b.message}`);
  }
  if (result.warnings.length > 0) {
    console.log('warnings:');
    for (const w of result.warnings) console.log(`  [${w.code}] ${w.message}`);
  }
  console.log('agent_protocol:');
  for (const step of result.agent_protocol) console.log(`  - ${step}`);
  console.log('recommended_next_tools:');
  for (const t of result.recommended_next_tools) console.log(`  - ${t}`);
  console.log('recommended_cli_commands:');
  for (const c of result.recommended_cli_commands) console.log(`  - ${c}`);
}
