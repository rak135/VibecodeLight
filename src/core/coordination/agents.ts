import { randomUUID } from 'crypto';

import { CoordinationError } from './errors.js';
import { HEARTBEAT_TTL_MS, computeAgentStatus } from './heartbeat.js';
import { loadCoordinationState, writeCoordinationState } from './state.js';
import { isAgentType, type AgentSession, type AgentStatus, type AgentType } from './types.js';

/**
 * Persistent agent session registry (Phase 2).
 *
 * Hard rules enforced here:
 *   - The ONLY file ever written is `.vibecode/coordination/state.json`, via
 *     `writeCoordinationState`. No source files, no lock files, no config.json.
 *   - Reads (`listAgents`, `getAgentStatus`) are read-only and never write —
 *     a missing state file yields an empty list.
 *   - `stale` is computed-only: persisted status is one of
 *     active/idle/terminated; `stale` is overlaid at read time.
 *   - Mutations preserve existing claim/conflict/handoff state outside the
 *     single agent session being changed.
 */

/** Caller-supplied fields for a new agent session. */
export interface RegisterAgentInput {
  agent_name: string;
  agent_type: AgentType | string;
  terminal_session_id?: string | null;
  pid?: number | null;
  metadata?: Record<string, unknown>;
}

/** Options for a mutating agent operation. `now`/`agentId` are test seams. */
export interface AgentMutationOptions {
  /** Override the wall clock (ISO-8601). */
  now?: string;
  /** Override the generated agent id (must be unique). */
  agentId?: string;
}

/** Options for a read-only agent query. */
export interface AgentReadOptions {
  /** Override the wall clock (ISO-8601) used for stale computation. */
  now?: string;
  /** Override the heartbeat TTL used for stale computation. */
  ttlMs?: number;
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

/** Generate a stable, unique, filesystem/JSON-safe agent id. */
function generateAgentId(existing: ReadonlySet<string>): string {
  let id = `agent-${randomUUID()}`;
  while (existing.has(id)) id = `agent-${randomUUID()}`;
  return id;
}

/** Overlay the computed status onto a stored session for read responses. */
function withComputedStatus(agent: AgentSession, nowMs: number, ttlMs: number): AgentSession {
  return { ...agent, status: computeAgentStatus(agent, nowMs, ttlMs) };
}

/**
 * Register a new agent session. Validates the input, writes the session into
 * `state.json` (creating it if needed), and returns the created session with
 * status `active`. Throws {@link CoordinationError} on invalid input.
 */
export function registerAgent(
  repoRoot: string,
  input: RegisterAgentInput,
  options: AgentMutationOptions = {},
): AgentSession {
  const agentName = typeof input.agent_name === 'string' ? input.agent_name.trim() : '';
  if (agentName.length === 0) {
    throw new CoordinationError('INVALID_AGENT_NAME', 'agent_name must be a non-empty string');
  }
  if (!isAgentType(input.agent_type)) {
    throw new CoordinationError(
      'INVALID_AGENT_TYPE',
      `invalid agent_type: ${JSON.stringify(input.agent_type)}`,
      { agent_type: input.agent_type },
    );
  }

  const now = nowIso(options.now);
  const state = loadCoordinationState(repoRoot, { now });
  const existingIds = new Set(state.agents.map((a) => a.agent_id));
  const agentId = options.agentId ?? generateAgentId(existingIds);

  const session: AgentSession = {
    agent_id: agentId,
    agent_name: agentName,
    agent_type: input.agent_type,
    terminal_session_id: input.terminal_session_id ?? null,
    started_at: now,
    last_heartbeat_at: now,
    status: 'active',
    pid: input.pid ?? null,
    claims: [],
    metadata: input.metadata ?? {},
  };

  writeCoordinationState(repoRoot, {
    ...state,
    last_updated: now,
    agents: [...state.agents, session],
  });

  return session;
}

/**
 * List all registered agents with their computed (stale-aware) status.
 * Read-only: a missing state file yields an empty list and writes nothing.
 */
export function listAgents(repoRoot: string, options: AgentReadOptions = {}): AgentSession[] {
  const now = nowIso(options.now);
  const ttlMs = options.ttlMs ?? HEARTBEAT_TTL_MS;
  const nowMs = Date.parse(now);
  const state = loadCoordinationState(repoRoot, { now });
  return state.agents.map((agent) => withComputedStatus(agent, nowMs, ttlMs));
}

/**
 * Return one agent by id, with its computed status. Throws
 * {@link CoordinationError} `AGENT_NOT_FOUND` if no such agent exists.
 */
export function getAgentStatus(
  repoRoot: string,
  agentId: string,
  options: AgentReadOptions = {},
): AgentSession {
  const agent = listAgents(repoRoot, options).find((a) => a.agent_id === agentId);
  if (!agent) {
    throw new CoordinationError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`, { agent_id: agentId });
  }
  return agent;
}

/** Result of an explicit heartbeat, including the pre-heartbeat lifecycle status. */
export interface AgentHeartbeatDetail {
  /** The persisted session after the heartbeat (status `active`). */
  agent: AgentSession;
  /** True when the agent's computed status was `stale` before this heartbeat. */
  was_stale: boolean;
  /** Computed (stale-aware) status before this heartbeat. */
  previous_status: AgentStatus;
}

/**
 * Record a heartbeat: update `last_heartbeat_at` and set status `active`
 * (reviving a stale/idle/unknown agent). Phase 2C hardening:
 *   - a terminated agent is blocked with `AGENT_TERMINATED` (never revived);
 *   - ONLY `last_heartbeat_at` and `status` change — mode/task metadata,
 *     claims, intents, and identity fields are untouched.
 * Never creates an agent implicitly — throws `AGENT_NOT_FOUND` for an
 * unknown id.
 */
export function heartbeatAgentDetailed(
  repoRoot: string,
  agentId: string,
  options: AgentMutationOptions = {},
): AgentHeartbeatDetail {
  const now = nowIso(options.now);
  const state = loadCoordinationState(repoRoot, { now });
  const index = state.agents.findIndex((a) => a.agent_id === agentId);
  if (index === -1) {
    throw new CoordinationError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`, { agent_id: agentId });
  }

  const stored = state.agents[index];
  const previousStatus = computeAgentStatus(stored, Date.parse(now), HEARTBEAT_TTL_MS);
  if (previousStatus === 'terminated') {
    throw new CoordinationError(
      'AGENT_TERMINATED',
      `Agent ${agentId} is terminated and cannot heartbeat. Register a new agent (session_bootstrap with register=true, agent_mode + task).`,
      { agent_id: agentId },
    );
  }

  const updated: AgentSession = {
    ...stored,
    last_heartbeat_at: now,
    status: 'active',
  };
  const agents = [...state.agents];
  agents[index] = updated;

  writeCoordinationState(repoRoot, { ...state, last_updated: now, agents });
  return { agent: updated, was_stale: previousStatus === 'stale', previous_status: previousStatus };
}

/**
 * Record a heartbeat and return the updated session. Thin wrapper over
 * {@link heartbeatAgentDetailed} for callers that do not need the
 * pre-heartbeat status.
 */
export function heartbeatAgent(
  repoRoot: string,
  agentId: string,
  options: AgentMutationOptions = {},
): AgentSession {
  return heartbeatAgentDetailed(repoRoot, agentId, options).agent;
}

/**
 * Mark an agent as `terminated` and persist it. Throws `AGENT_NOT_FOUND` for an
 * unknown id.
 */
export function markAgentTerminated(
  repoRoot: string,
  agentId: string,
  options: AgentMutationOptions = {},
): AgentSession {
  const now = nowIso(options.now);
  const state = loadCoordinationState(repoRoot, { now });
  const index = state.agents.findIndex((a) => a.agent_id === agentId);
  if (index === -1) {
    throw new CoordinationError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`, { agent_id: agentId });
  }

  const updated: AgentSession = { ...state.agents[index], status: 'terminated' };
  const agents = [...state.agents];
  agents[index] = updated;

  writeCoordinationState(repoRoot, { ...state, last_updated: now, agents });
  return updated;
}
