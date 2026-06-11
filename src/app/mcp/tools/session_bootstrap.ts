import {
  getSessionBootstrap,
  type BootstrapCodeGraphStatus,
  type SessionBootstrapResult,
} from '../../../core/agent_session/bootstrap.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateBoundedInteger,
  validateNonEmptyString,
  SESSION_BOOTSTRAP_INPUT_SCHEMA,
  HARD_MAX_BOOTSTRAP_ITEMS,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import { buildMcpServerIdentity, type McpServerIdentity } from '../server_identity.js';

/**
 * Phase 1A — `vibecode_session_bootstrap`.
 *
 * One-call orientation for a fresh coding agent in the bound repo. Thin wrapper
 * over the shared core service (`core/agent_session/bootstrap`) — the same
 * service the `vibecode session bootstrap` CLI command uses, so MCP and CLI
 * return equivalent data. Read-only BY DEFAULT: it writes only generated
 * `.vibecode/coordination/state.json`, and only when asked to register
 * (register=true) or heartbeat (agent_id supplied). It never reads arbitrary
 * source files and never mutates git.
 */
const TOOL_NAME = 'vibecode_session_bootstrap';
const ALLOWED_KEYS = new Set([
  'agent_id',
  'register',
  'agent_mode',
  'agent_name',
  'agent_type',
  'task',
  'terminal_session_id',
  'run_ref',
  'max_items',
  'include_instructions',
]);

export interface SessionBootstrapToolDeps {
  /** Test seam: override CodeGraph status resolution (avoids spawning the binary). */
  codegraphStatus?: (repoRoot: string) => Promise<BootstrapCodeGraphStatus>;
}

/** Map a core blocker code to a stable MCP error code for invocation failures. */
function blockerErrorCode(code: string | undefined): McpErrorCode {
  switch (code) {
    case 'AGENT_NOT_FOUND':
      return 'AGENT_NOT_FOUND';
    case 'AGENT_TERMINATED':
      return 'AGENT_TERMINATED';
    case 'INVALID_AGENT_MODE':
    case 'AGENT_TASK_REQUIRED':
      return 'INVALID_ARGUMENT';
    default:
      return 'SESSION_BOOTSTRAP_FAILED';
  }
}

function renderText(result: SessionBootstrapResult, serverIdentity: McpServerIdentity): string {
  const lines: string[] = ['# Vibecode session bootstrap', ''];
  lines.push(`repo_root: ${result.repo_root}`);
  lines.push(
    `mcp_server: ${serverIdentity.server_name} ${serverIdentity.server_version}`
      + ` tools=${serverIdentity.tool_count} started_at=${serverIdentity.started_at}`,
  );
  lines.push(
    `git: branch=${result.git.branch ?? '(n/a)'} head=${result.git.head ?? '(n/a)'} dirty=${result.git.dirty ? 'yes' : 'no'} changed=${result.git.changed_counts.total}`,
  );
  if (result.current_agent) {
    lines.push(
      `agent: ${result.current_agent.agent_id} (${result.current_agent.status}) mode=${result.current_agent.operating_mode ?? 'unset'}`,
    );
  } else {
    lines.push('agent: (none registered)');
  }
  lines.push(
    `agents: total=${result.agents.total} active=${result.agents.active} stale=${result.agents.stale}`,
  );
  lines.push(
    `claims: own=${result.claims.counts.own} other_active=${result.claims.counts.other_active} stale=${result.claims.counts.stale}`,
  );
  if (result.active_work_intents.length > 0) {
    lines.push('active_work_intents:');
    for (const intent of result.active_work_intents) {
      lines.push(`  - ${intent.intent_id} "${intent.intent}" claims=${intent.claim_count} paths=${intent.sample_paths.join(', ')}${intent.sample_truncated ? ', …' : ''}`);
    }
  }
  lines.push(`conflicts_unresolved: ${result.conflicts.unresolved_count}`);
  if (result.stale_coordination.has_stale_state) {
    const stale = result.stale_coordination;
    lines.push(
      `stale_coordination: agents=${stale.stale_agents_count} claims=${stale.stale_active_claims_count}`
        + ` stale_owned_intents=${stale.active_intents_owned_by_stale_agents_count + stale.active_intents_owned_by_terminated_agents_count + stale.active_intents_owned_by_missing_agents_count}`
        + ` claimless_intents=${stale.active_intents_with_no_active_claims_count}`,
    );
  }
  lines.push(
    `current_run: ${result.current_run.run_id ?? '(none)'} scan_available=${result.scan.current_run_scan_available ? 'yes' : 'no'}`,
  );
  lines.push(
    `codegraph: available=${result.codegraph.available ? 'yes' : 'no'} initialized=${result.codegraph.initialized ? 'yes' : 'no'}`,
  );
  const preflight = result.runtime_awareness;
  lines.push(
    `preflight: can_edit=${preflight.commit_guard.can_edit ? 'yes' : 'no'}`
      + ` finalize_ready=${preflight.commit_guard.finalize_ready ? 'yes' : 'no'}`
      + ` commit_guard_ready=${preflight.commit_guard.commit_guard_ready ? 'yes' : 'no'}`
      + ` isolated_commit_possible=${preflight.commit_guard.isolated_commit_possible ? 'yes' : 'no'}`
      + ` needs_heartbeat=${preflight.agent.needs_heartbeat ? 'yes' : 'no'}`,
  );
  lines.push(`Recovery: ${preflight.recovery.summary}`);
  if (result.blockers.length > 0) {
    lines.push('', 'blockers:');
    for (const b of result.blockers) lines.push(`  - [${b.code}] ${b.message}`);
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const w of result.warnings) lines.push(`  - [${w.code}] ${w.message}`);
  }
  lines.push('', 'agent_protocol:');
  for (const step of result.agent_protocol) lines.push(`  - ${step}`);
  lines.push('', 'recommended_next_tools:');
  for (const t of result.recommended_next_tools) lines.push(`  - ${t}`);
  if (result.recommended_tool_profiles.length > 0) {
    lines.push('', 'recommended_tool_profiles:');
    for (const p of result.recommended_tool_profiles) lines.push(`  - ${p.profile_id}: ${p.reason}`);
  }
  return lines.join('\n');
}

export function buildSessionBootstrapTool(deps: SessionBootstrapToolDeps = {}): McpToolDefinition {
  const inputSchema: JsonSchema = SESSION_BOOTSTRAP_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode session bootstrap',
    description:
      'One-call orientation for the bound repo: git/dirty state, current run + artifacts, active agents, claims/conflicts, evidence, scan availability, CodeGraph status, a bounded project-instruction excerpt, the agent operating protocol, and recommended next tools/commands. Read-only by default; pass register=true (with agent_mode read_only|build and a task) or an agent_id to write only generated coordination state.',
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

      // Strict type validation before passing to core.
      const agentId = args.agent_id === undefined || args.agent_id === null
        ? undefined
        : validateNonEmptyString(args.agent_id, 'agent_id');
      if (agentId && !agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);

      if (args.register !== undefined && args.register !== null && typeof args.register !== 'boolean') {
        return fail('INVALID_ARGUMENT', `invalid register: expected a boolean, got ${JSON.stringify(args.register)}`);
      }

      if (args.agent_mode !== undefined && args.agent_mode !== null && typeof args.agent_mode !== 'string') {
        return fail('INVALID_ARGUMENT', `invalid agent_mode: expected a string, got ${JSON.stringify(args.agent_mode)}`);
      }

      if (args.agent_name !== undefined && args.agent_name !== null) {
        const nameCheck = validateNonEmptyString(args.agent_name, 'agent_name');
        if (!nameCheck.ok) return fail('INVALID_ARGUMENT', nameCheck.message);
      }

      if (args.agent_type !== undefined && args.agent_type !== null && typeof args.agent_type !== 'string') {
        return fail('INVALID_ARGUMENT', `invalid agent_type: expected a string, got ${JSON.stringify(args.agent_type)}`);
      }

      if (args.task !== undefined && args.task !== null) {
        const taskCheck = validateNonEmptyString(args.task, 'task');
        if (!taskCheck.ok) return fail('INVALID_ARGUMENT', taskCheck.message);
      }

      const maxItems = validateBoundedInteger(args.max_items, 'max_items', HARD_MAX_BOOTSTRAP_ITEMS);
      if (!maxItems.ok) return fail('INVALID_ARGUMENT', maxItems.message);

      if (args.include_instructions !== undefined && args.include_instructions !== null && typeof args.include_instructions !== 'boolean') {
        return fail('INVALID_ARGUMENT', `invalid include_instructions: expected a boolean, got ${JSON.stringify(args.include_instructions)}`);
      }

      try {
        const result = await getSessionBootstrap({
          repoRoot: input.context.repoRoot,
          agent_id: agentId ? agentId.value : undefined,
          register: args.register === true,
          agent_mode: typeof args.agent_mode === 'string' ? args.agent_mode : undefined,
          agent_name: typeof args.agent_name === 'string' ? args.agent_name : undefined,
          agent_type: typeof args.agent_type === 'string' ? args.agent_type : undefined,
          task: typeof args.task === 'string' ? args.task : undefined,
          terminal_session_id: typeof args.terminal_session_id === 'string' ? args.terminal_session_id : undefined,
          run_ref: typeof args.run_ref === 'string' ? args.run_ref : undefined,
          max_items: maxItems.value,
          include_instructions: typeof args.include_instructions === 'boolean' ? args.include_instructions : undefined,
          codegraphStatus: deps.codegraphStatus,
        });

        if (!result.ok) {
          const blocker = result.blockers[0];
          return fail(blockerErrorCode(blocker?.code), blocker?.message ?? 'session bootstrap failed');
        }

        // Phase 2D follow-up: attach the RUNNING server build's identity so an
        // agent can detect a stale MCP server session (tool_count drift means
        // restart/reconnect). MCP-layer only — the shared core result and the
        // CLI command (which always reflects the current build) are unchanged.
        const serverIdentity = buildMcpServerIdentity(input.context.repoRoot);

        // Phase 3B: the live server fills the preflight `server` section (core
        // leaves it null) so the runtime_awareness block alone answers "is my
        // MCP server stale?". Same identity object as `server_identity`.
        const withServer = {
          ...result,
          runtime_awareness: { ...result.runtime_awareness, server: serverIdentity },
        };

        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderText(withServer, serverIdentity),
          data: { ...withServer, server_identity: serverIdentity },
          warnings: result.warnings.map((w) => `${w.code}: ${w.message}`),
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('SESSION_BOOTSTRAP_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
