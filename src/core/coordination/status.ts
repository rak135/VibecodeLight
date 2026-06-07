import { getCoordinationPaths, loadCoordinationState } from './state.js';
import { HEARTBEAT_TTL_MS, computeAgentStatus } from './heartbeat.js';
import { summarizeRecentEvidence, type EvidenceSummary } from './watcher.js';
import type { AgentSession, WorkspaceCoordinationState } from './types.js';
import type { ConflictRecord } from './conflicts.js';
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
  unresolved_conflicts: number;
  stale_claims: number;
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
  /**
   * Compact summary of recent watcher evidence (advisory, non-enforcing). The
   * full event log is intentionally NOT included here — read it with
   * `listCoordinationEvidence` / the evidence CLI/MCP surfaces.
   */
  evidence: EvidenceSummary;
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

  const staleAgentIds = new Set(
    agents.filter((a) => a.status === 'stale' || a.status === 'terminated').map((a) => a.agent_id),
  );
  const staleClaims = state.claims.filter(
    (claim) => claim.status !== 'released' && staleAgentIds.has(claim.agent_id),
  );
  // Generated conflict state is trusted but not schema-enforced on load
  // (see state.ts `normalize`); guard against malformed entries so status
  // reporting never crashes on bad state.
  const conflicts = (state.conflicts as readonly unknown[]).filter(
    (c): c is ConflictRecord => !!c && typeof c === 'object',
  );
  const unresolvedConflicts = conflicts.filter((c) => c.status === 'detected');

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
      unresolved_conflicts: unresolvedConflicts.length,
      stale_claims: staleClaims.length,
    },
    agents,
    evidence: summarizeRecentEvidence(repoRoot),
    state,
  };
}
