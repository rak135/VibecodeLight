import { CoordinationError } from './errors.js';
import type { AgentSession } from './types.js';

/**
 * Shared agent operating-mode validation for Phase 1A enforcement.
 *
 * This is the single source of truth for:
 *   - valid operating modes (read_only | build)
 *   - extracting mode/task from agent metadata
 *   - checking whether an agent may claim files or finalize/commit
 *
 * Bootstrap, claims, finalize_check, and commit_guard all use this module
 * instead of duplicating mode/task logic.
 */

/** Valid agent operating modes, chosen at session start and immutable. */
export const AGENT_OPERATING_MODES = ['read_only', 'build'] as const;

/** A coordinating agent's operating mode. */
export type AgentOperatingMode = (typeof AGENT_OPERATING_MODES)[number];

/** Type guard for {@link AgentOperatingMode}. */
export function isAgentOperatingMode(value: unknown): value is AgentOperatingMode {
  return value === 'read_only' || value === 'build';
}

/** Extract the operating_mode from an agent's metadata, or null if missing/invalid. */
export function getAgentOperatingMode(agent: AgentSession): AgentOperatingMode | null {
  const raw = agent.metadata?.operating_mode;
  return isAgentOperatingMode(raw) ? raw : null;
}

/** Extract the task/intent from an agent's metadata, or null if missing/empty. */
export function getAgentTask(agent: AgentSession): string | null {
  const raw = agent.metadata?.task;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

/**
 * Resolved operating-mode metadata for an agent session.
 * Both fields are required for a valid working session.
 */
export interface AgentModeValidation {
  operating_mode: AgentOperatingMode | null;
  task: string | null;
  valid: boolean;
}

/** Validate that an agent has both a valid operating mode and a non-empty task. */
export function validateAgentMode(agent: AgentSession): AgentModeValidation {
  const operating_mode = getAgentOperatingMode(agent);
  const task = getAgentTask(agent);
  return {
    operating_mode,
    task,
    valid: operating_mode !== null && task !== null,
  };
}

/**
 * Check whether an agent is allowed to claim files.
 * Only `build` agents with valid mode+task may claim.
 * Throws {@link CoordinationError} if the agent is not allowed.
 */
export function requireBuildAgent(agent: AgentSession): void {
  const mode = getAgentOperatingMode(agent);
  if (mode === null) {
    throw new CoordinationError(
      'INVALID_AGENT_MODE',
      `Agent ${agent.agent_id} has no valid operating_mode. Register through session_bootstrap with agent_mode (read_only | build) and task.`,
      { agent_id: agent.agent_id, operating_mode: mode },
    );
  }
  if (mode === 'read_only') {
    throw new CoordinationError(
      'READ_ONLY_AGENT',
      `Agent ${agent.agent_id} is operating in read_only mode and cannot claim files or modify the working tree.`,
      { agent_id: agent.agent_id, operating_mode: mode },
    );
  }
}

/**
 * Validate that an existing agent has valid mode/task metadata.
 * Returns a blocker notice if the agent is invalid, or null if valid.
 * Used by bootstrap to reject legacy agents without mode/task.
 */
export function validateExistingAgentMode(
  agent: AgentSession,
): { code: string; message: string } | null {
  const mode = getAgentOperatingMode(agent);
  const task = getAgentTask(agent);
  if (mode === null || task === null) {
    const missing: string[] = [];
    if (mode === null) missing.push('operating_mode');
    if (task === null) missing.push('task');
    return {
      code: 'INVALID_AGENT_SESSION',
      message: `Agent ${agent.agent_id} is missing required session metadata (${missing.join(', ')}). Re-register through session_bootstrap with register=true, agent_mode, and task.`,
    };
  }
  return null;
}

/**
 * Validate that a mode update for an existing agent does not change the mode.
 * Mode is immutable once set at registration time.
 * Returns an error message if the mode would change, or null if compatible.
 */
export function validateModeImmutability(
  existingMode: AgentOperatingMode | null,
  requestedMode: string | undefined,
): string | null {
  if (requestedMode === undefined) return null;
  if (!isAgentOperatingMode(requestedMode)) {
    return `invalid agent_mode: ${JSON.stringify(requestedMode)}`;
  }
  if (existingMode !== null && existingMode !== requestedMode) {
    return `agent_mode is immutable: agent was registered as ${existingMode}, cannot change to ${requestedMode}`;
  }
  return null;
}
