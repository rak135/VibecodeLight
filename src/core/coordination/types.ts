/**
 * Multi-agent coordination — Phase 1 data model (read-only status foundation).
 *
 * Coordination in VibecodeLight is **advisory**:
 *   - no source files are hard-locked,
 *   - claims/agents/conflicts/handoffs are tracked as plain data, and
 *   - the user (and later guards) remain the final authority.
 *
 * This module intentionally ships only the minimal top-level workspace state.
 * The concrete element shapes for agents, claims, conflicts, and handoffs
 * (FileClaim, AgentSession, ConflictRecord, HandoffRequest — see
 * docs/MULTI_AGENT_CONFLICT_DESIGN.md) arrive in later phases. For Phase 1 the
 * arrays are always empty, so they are typed as read-only `unknown[]` to avoid
 * prematurely freezing element schemas that future phases will define.
 */

/** Schema version for the generated coordination state document. */
export const COORDINATION_STATE_VERSION = 1 as const;

/**
 * The whole-workspace coordination state, persisted as generated state at
 * `.vibecode/coordination/state.json`. Phase 1 keeps every collection empty.
 */
export interface WorkspaceCoordinationState {
  /** Document schema version. */
  version: number;
  /** Absolute repo root this state describes. */
  workspace_root: string;
  /** ISO-8601 timestamp of the last write. */
  last_updated: string;
  /** Registered agent sessions (Phase 1: always empty). */
  agents: readonly unknown[];
  /** Advisory file claims (Phase 1: always empty). */
  claims: readonly unknown[];
  /** Detected conflicts (Phase 1: always empty). */
  conflicts: readonly unknown[];
  /** Handoff requests (Phase 1: always empty). */
  handoffs: readonly unknown[];
}
