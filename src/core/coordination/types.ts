/**
 * Multi-agent coordination — Phase 1 data model (read-only status foundation).
 *
 * Coordination in VibecodeLight is **advisory**:
 *   - no source files are hard-locked,
 *   - claims/agents/conflicts/handoffs are tracked as plain data, and
 *   - the user (and later guards) remain the final authority.
 *
 * Phase 2 adds the {@link AgentSession} shape (persistent agent registry +
 * heartbeat). The remaining element shapes for claims, conflicts, and handoffs
 * (FileClaim, ConflictRecord, HandoffRequest — see
 * docs/MULTI_AGENT_CONFLICT_DESIGN.md) arrive in later phases; those arrays stay
 * empty and are typed as read-only `unknown[]` to avoid prematurely freezing
 * element schemas that future phases will define.
 */

/** Schema version for the generated coordination state document. */
export const COORDINATION_STATE_VERSION = 1 as const;

/** Recognized agent runtimes. `custom` is the escape hatch for anything else. */
export const AGENT_TYPES = ['claude', 'codex', 'hermes', 'opencode', 'custom'] as const;

/** A coordinating agent's runtime kind. */
export type AgentType = (typeof AGENT_TYPES)[number];

/**
 * Lifecycle status of an agent session.
 *   - `active`     — registered and heartbeating within the TTL,
 *   - `idle`       — alive but intentionally quiet (reserved; never auto-set),
 *   - `stale`      — heartbeat older than the TTL (computed-only at read time),
 *   - `terminated` — explicitly ended,
 *   - `unknown`    — heartbeat timestamp could not be interpreted.
 */
export type AgentStatus = 'active' | 'idle' | 'stale' | 'terminated' | 'unknown';

/**
 * A persistent agent session, stored in the `agents` array of the workspace
 * coordination state. `claims` stays an empty array in Phase 2 — claim behavior
 * is intentionally not implemented yet.
 */
export interface AgentSession {
  /** Stable, unique, filesystem/JSON-safe identifier. */
  agent_id: string;
  /** Human-friendly label (duplicates allowed across distinct agent_ids). */
  agent_name: string;
  /** Runtime kind. */
  agent_type: AgentType;
  /** Owning terminal session id, when the agent runs inside a Vibecode terminal. */
  terminal_session_id: string | null;
  /** ISO-8601 timestamp of registration. */
  started_at: string;
  /** ISO-8601 timestamp of the last heartbeat (or registration). */
  last_heartbeat_at: string;
  /** Lifecycle status (computed-only `stale` is overlaid at read time). */
  status: AgentStatus;
  /** OS process id, when known. */
  pid: number | null;
  /** Advisory file claims (Phase 2: always empty). */
  claims: string[];
  /** Free-form, caller-provided metadata. */
  metadata: Record<string, unknown>;
}

/** Type guard: is `value` one of the recognized {@link AgentType}s? */
export function isAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && (AGENT_TYPES as readonly string[]).includes(value);
}

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
  /** Registered agent sessions. */
  agents: readonly AgentSession[];
  /** Advisory file claims (Phase 1: always empty). */
  claims: readonly unknown[];
  /** Detected conflicts (Phase 1: always empty). */
  conflicts: readonly unknown[];
  /** Handoff requests (Phase 1: always empty). */
  handoffs: readonly unknown[];
}
