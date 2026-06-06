import {
  registerAgent,
  listAgents,
  heartbeatAgent,
  getAgentStatus,
} from '../../../core/coordination/agents.js';
import { CoordinationError } from '../../../core/coordination/errors.js';
import { isAgentType, type AgentSession } from '../../../core/coordination/types.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateNonEmptyString,
  validatePositiveInteger,
  AGENT_REGISTER_INPUT_SCHEMA,
  AGENT_HEARTBEAT_INPUT_SCHEMA,
  AGENTS_LIST_INPUT_SCHEMA,
  AGENT_STATUS_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

/**
 * Phase Coordination-2: persistent agent session MCP tools.
 *
 * Each tool is a thin wrapper over the shared core services in
 * `core/coordination/agents` — the same services the `vibecode agents …` CLI
 * uses — so MCP and CLI return equivalent data. The repo is bound to the server
 * at startup; these tools never accept a repo argument and never shell out to
 * the CLI. register/heartbeat write ONLY the advisory generated state at
 * `.vibecode/coordination/state.json`; no source/shell/git/terminal writes.
 */

/** Map a core CoordinationError onto a stable MCP error code. */
function mcpErrorForCoordination(
  error: CoordinationError,
  fallback: McpErrorCode,
): McpErrorCode {
  switch (error.code) {
    case 'AGENT_NOT_FOUND':
      return 'AGENT_NOT_FOUND';
    case 'INVALID_AGENT_TYPE':
    case 'INVALID_AGENT_NAME':
      return 'INVALID_ARGUMENT';
    default:
      return fallback;
  }
}

function agentLines(agent: AgentSession): string[] {
  return [
    `agent_id: ${agent.agent_id}`,
    `agent_name: ${agent.agent_name}`,
    `agent_type: ${agent.agent_type}`,
    `status: ${agent.status}`,
    `last_heartbeat_at: ${agent.last_heartbeat_at}`,
  ];
}

export function buildAgentRegisterTool(): McpToolDefinition {
  const inputSchema: JsonSchema = AGENT_REGISTER_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_agent_register';
  const ALLOWED_KEYS = new Set(['name', 'type', 'terminal_session_id', 'pid']);
  return {
    name: TOOL_NAME,
    title: 'Register agent session',
    description:
      'Register a persistent multi-agent coordination session for the bound repo (advisory). Writes only generated .vibecode/coordination/state.json; no source-file locks. Returns the created agent session.',
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

      const args = input.arguments ?? {};
      const name = validateNonEmptyString(args.name, 'name');
      if (!name.ok) return fail('INVALID_ARGUMENT', name.message);
      if (!isAgentType(args.type)) {
        return fail('INVALID_ARGUMENT', `invalid type: expected one of claude|codex|hermes|opencode|custom, got ${JSON.stringify(args.type)}`);
      }
      const pid = validatePositiveInteger(args.pid, 'pid');
      if (!pid.ok) return fail('INVALID_ARGUMENT', pid.message);
      const terminalSessionId =
        typeof args.terminal_session_id === 'string' ? args.terminal_session_id : null;

      let agent: AgentSession;
      try {
        agent = registerAgent(input.context.repoRoot, {
          agent_name: name.value,
          agent_type: args.type,
          terminal_session_id: terminalSessionId,
          pid: pid.value ?? null,
        });
      } catch (err) {
        if (err instanceof CoordinationError) {
          return fail(mcpErrorForCoordination(err, 'AGENT_REGISTER_FAILED'), err.message);
        }
        return fail('AGENT_REGISTER_FAILED', err instanceof Error ? err.message : String(err));
      }

      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: ['# Registered agent', '', ...agentLines(agent)].join('\n'),
        data: { agent },
        durationMs: Date.now() - started,
      });
    },
  };
}

export function buildAgentHeartbeatTool(): McpToolDefinition {
  const inputSchema: JsonSchema = AGENT_HEARTBEAT_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_agent_heartbeat';
  const ALLOWED_KEYS = new Set(['agent_id']);
  return {
    name: TOOL_NAME,
    title: 'Heartbeat agent session',
    description:
      'Record a heartbeat for a registered agent in the bound repo (advisory), reviving a stale/idle session to active. Writes only generated .vibecode/coordination/state.json.',
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
      const agentId = validateNonEmptyString((input.arguments ?? {}).agent_id, 'agent_id');
      if (!agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);

      let agent: AgentSession;
      try {
        agent = heartbeatAgent(input.context.repoRoot, agentId.value);
      } catch (err) {
        if (err instanceof CoordinationError) {
          return fail(mcpErrorForCoordination(err, 'AGENT_HEARTBEAT_FAILED'), err.message);
        }
        return fail('AGENT_HEARTBEAT_FAILED', err instanceof Error ? err.message : String(err));
      }

      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: ['# Agent heartbeat', '', ...agentLines(agent)].join('\n'),
        data: { agent },
        durationMs: Date.now() - started,
      });
    },
  };
}

export function buildAgentsListTool(): McpToolDefinition {
  const inputSchema: JsonSchema = AGENTS_LIST_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_agents_list';
  const ALLOWED_KEYS = new Set<string>();
  return {
    name: TOOL_NAME,
    title: 'List agent sessions',
    description:
      'List registered multi-agent coordination sessions for the bound repo, each with its computed (stale-aware) status. Read-only.',
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

      let agents: AgentSession[];
      try {
        agents = listAgents(input.context.repoRoot);
      } catch (err) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('AGENTS_LIST_FAILED', err instanceof Error ? err.message : String(err)),
        });
      }

      const text = [`# Agent sessions (${agents.length})`, '']
        .concat(agents.map((a) => `- ${a.agent_id} ${a.agent_name} (${a.agent_type}) status=${a.status}`))
        .join('\n');

      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text,
        data: { agents },
        durationMs: Date.now() - started,
      });
    },
  };
}

export function buildAgentStatusTool(): McpToolDefinition {
  const inputSchema: JsonSchema = AGENT_STATUS_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_agent_status';
  const ALLOWED_KEYS = new Set(['agent_id']);
  return {
    name: TOOL_NAME,
    title: 'Agent session status',
    description:
      'Return one registered agent session by id with its computed (stale-aware) status for the bound repo. Read-only.',
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
      const agentId = validateNonEmptyString((input.arguments ?? {}).agent_id, 'agent_id');
      if (!agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);

      let agent: AgentSession;
      try {
        agent = getAgentStatus(input.context.repoRoot, agentId.value);
      } catch (err) {
        if (err instanceof CoordinationError) {
          return fail(mcpErrorForCoordination(err, 'AGENT_STATUS_FAILED'), err.message);
        }
        return fail('AGENT_STATUS_FAILED', err instanceof Error ? err.message : String(err));
      }

      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: ['# Agent status', '', ...agentLines(agent)].join('\n'),
        data: { agent },
        durationMs: Date.now() - started,
      });
    },
  };
}
