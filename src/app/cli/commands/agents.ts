import path from 'path';

import { Command } from 'commander';

import {
  registerAgent,
  listAgents,
  heartbeatAgent,
  getAgentStatus,
  markAgentTerminated,
} from '../../../core/coordination/agents.js';
import { CoordinationError } from '../../../core/coordination/errors.js';
import type { AgentSession } from '../../../core/coordination/types.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface AgentsCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

/**
 * Register `vibecode agents …` commands (Phase 2: persistent sessions +
 * heartbeat). These are thin wrappers over the shared core services in
 * `core/coordination/agents` — the same services the MCP agent tools use — so
 * CLI and MCP stay in lockstep. All coordination logic lives in core; this
 * module only parses options, calls core, and formats the envelope.
 */
export function registerAgentsCommands(
  program: Command,
  dependencies: AgentsCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const agents = program
    .command('agents')
    .description('Multi-agent coordination: persistent agent sessions (advisory)');

  /** Run a core call and emit the canonical success/error envelope. */
  const handle = (
    repoRoot: string,
    json: boolean | undefined,
    prefix: string,
    run: () => Record<string, unknown>,
  ): void => {
    let data: Record<string, unknown>;
    try {
      data = run();
    } catch (error) {
      if (error instanceof CoordinationError) {
        emitCliStructuredError(makeCliStructuredError(error.code, error.message, repoRoot), {
          json,
          prefix,
        });
        return;
      }
      emitCliStructuredError(
        makeCliStructuredError(
          'AGENTS_COMMAND_FAILED',
          error instanceof Error ? error.message : String(error),
          repoRoot,
        ),
        { json, prefix },
      );
      return;
    }

    if (json) {
      console.log(JSON.stringify({ ok: true, data, artifacts: [], warnings: [] }));
      return;
    }
    printHuman(data);
  };

  agents
    .command('register')
    .description('Register a persistent agent session')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--name <name>', 'Human-friendly agent name')
    .option('--type <type>', 'Agent type: claude | codex | hermes | opencode | custom')
    .option('--terminal-session-id <id>', 'Owning terminal session id')
    .option('--pid <pid>', 'OS process id')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: {
      repo: string;
      name?: string;
      type?: string;
      terminalSessionId?: string;
      pid?: string;
      json?: boolean;
    }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.name || !options.type) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'agents register requires --name and --type.', repoRoot, [
            ...(options.name ? [] : ['Missing: --name <name>']),
            ...(options.type ? [] : ['Missing: --type <type>']),
          ]),
          { json: options.json, prefix: 'agents register failed' },
        );
        return;
      }
      const pid = options.pid !== undefined ? Number(options.pid) : null;
      handle(repoRoot, options.json, 'agents register failed', () => {
        const agent = registerAgent(repoRoot, {
          agent_name: options.name!,
          agent_type: options.type!,
          terminal_session_id: options.terminalSessionId ?? null,
          pid: Number.isFinite(pid) ? pid : null,
        });
        return { agent };
      });
    });

  agents
    .command('list')
    .description('List registered agents with their computed status')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      handle(repoRoot, options.json, 'agents list failed', () => ({
        agents: listAgents(repoRoot),
      }));
    });

  agents
    .command('heartbeat')
    .description('Record a heartbeat for an agent (revives stale/idle to active)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Agent id')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.agent) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'agents heartbeat requires --agent.', repoRoot, ['Missing: --agent <agent_id>']),
          { json: options.json, prefix: 'agents heartbeat failed' },
        );
        return;
      }
      handle(repoRoot, options.json, 'agents heartbeat failed', () => ({
        agent: heartbeatAgent(repoRoot, options.agent!),
      }));
    });

  agents
    .command('status')
    .description('Show one agent by id with its computed status')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Agent id')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.agent) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'agents status requires --agent.', repoRoot, ['Missing: --agent <agent_id>']),
          { json: options.json, prefix: 'agents status failed' },
        );
        return;
      }
      handle(repoRoot, options.json, 'agents status failed', () => ({
        agent: getAgentStatus(repoRoot, options.agent!),
      }));
    });

  agents
    .command('terminate')
    .description('Mark an agent as terminated')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Agent id')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (!options.agent) {
        emitCliStructuredError(
          makeCliStructuredError('MISSING_REQUIRED_OPTION', 'agents terminate requires --agent.', repoRoot, ['Missing: --agent <agent_id>']),
          { json: options.json, prefix: 'agents terminate failed' },
        );
        return;
      }
      handle(repoRoot, options.json, 'agents terminate failed', () => ({
        agent: markAgentTerminated(repoRoot, options.agent!),
      }));
    });
}

function printHuman(data: Record<string, unknown>): void {
  if (Array.isArray(data.agents)) {
    const list = data.agents as AgentSession[];
    console.log(`agents: ${list.length}`);
    for (const agent of list) {
      console.log(`  ${agent.agent_id} ${agent.agent_name} (${agent.agent_type}) status=${agent.status}`);
    }
    return;
  }
  if (data.agent) {
    const agent = data.agent as AgentSession;
    console.log(`agent_id: ${agent.agent_id}`);
    console.log(`agent_name: ${agent.agent_name}`);
    console.log(`agent_type: ${agent.agent_type}`);
    console.log(`status: ${agent.status}`);
    console.log(`last_heartbeat_at: ${agent.last_heartbeat_at}`);
  }
}
