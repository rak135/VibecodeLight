import { getCoordinationPaths, loadCoordinationState } from './state.js';
import { HEARTBEAT_TTL_MS, computeAgentStatus } from './heartbeat.js';
import type { AgentSession, WorkspaceCoordinationState } from './types.js';
import fs from 'fs';

/**
 * Shared, read-only coordination status service.
 *
 * This is the single source of truth consumed by BOTH the CLI
 * (`vibecode coordination status`) and the MCP tool
 * (`vibecode_coordination_status`). Neither adapter reimplements the logic;
 * they both call `getCoordinationStatus`. It never writes to disk.
 */

/** Count summary of the coordination collections. */
export interface CoordinationStatusSummary {
  agents: number;
  claims: number;
  conflicts: number;
  handoffs: number;
}

/** Stable result returned by the coordination status service. */
export interface CoordinationStatusResult {
  /** Absolute repo root. */
  workspace_root: string;
  /** Absolute path to `.vibecode/coordination/state.json`. */
  state_file: string;
  /** Whether the generated state file exists yet. */
  state_file_exists: boolean;
  /** Document schema version. */
  version: number;
  /** ISO-8601 timestamp of the last state write (or "now" for an empty state). */
  last_updated: string;
  /** Per-collection counts. */
  summary: CoordinationStatusSummary;
  /** Registered agents, each with its computed (stale-aware) status. */
  agents: AgentSession[];
  /** The full coordination state (stored statuses, not stale-overlaid). */
  state: WorkspaceCoordinationState;
}

/**
 * Read the current coordination status for a repo. Read-only and resilient:
 * a missing or corrupt state file yields a stable empty status.
 */
export function getCoordinationStatus(
  repoRoot: string,
  options: { now?: string } = {},
): CoordinationStatusResult {
  const now = options.now ?? new Date().toISOString();
  const { stateFile } = getCoordinationPaths(repoRoot);
  const stateFileExists = fs.existsSync(stateFile);
  const state = loadCoordinationState(repoRoot, { now });
  const nowMs = Date.parse(now);
  const agents = state.agents.map((agent) => ({
    ...agent,
    status: computeAgentStatus(agent, nowMs, HEARTBEAT_TTL_MS),
  }));
  return {
    workspace_root: repoRoot,
    state_file: stateFile,
    state_file_exists: stateFileExists,
    version: state.version,
    last_updated: state.last_updated,
    summary: {
      agents: state.agents.length,
      claims: state.claims.length,
      conflicts: state.conflicts.length,
      handoffs: state.handoffs.length,
    },
    agents,
    state,
  };
}
