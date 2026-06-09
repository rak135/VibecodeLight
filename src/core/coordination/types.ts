/**
 * Multi-agent coordination — Phase 1 data model (read-only status foundation).
 *
 * Coordination in VibecodeLight is **advisory**:
 *   - no source files are hard-locked,
 *   - claims/agents/conflicts/handoffs are tracked as plain data, and
 *   - the user (and later guards) remain the final authority.
 *
 * Phase 2 adds the {@link AgentSession} shape (persistent agent registry +
 * heartbeat). Phase 3A adds {@link FileClaim}: advisory file claims persisted in
 * the same generated state document. Conflicts/handoffs remain future phases.
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

/** Advisory claim compatibility mode. */
export type ClaimMode = 'exclusive' | 'shared';

/**
 * Lifecycle status of an advisory file claim.
 * `stale` and `unknown` are computed for read responses; persisted claims are
 * normally `active` or `released`.
 */
export type ClaimStatus = 'active' | 'released' | 'stale' | 'unknown';

/**
 * A persistent agent session, stored in the `agents` array of the workspace
 * coordination state. `claims` stores active advisory claim ids owned by this
 * agent.
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
  /** Active advisory file claim ids owned by this agent. */
  claims: string[];
  /** Free-form, caller-provided metadata. */
  metadata: Record<string, unknown>;
}

/**
 * Lifecycle status of an agent-declared work intent (Phase 2A).
 * Phase 2A only ever creates `active` intents; `closed` is reserved for a later
 * release-by-intent phase.
 */
export type ClaimIntentStatus = 'active' | 'closed';

/**
 * An agent-declared work scope (Phase 2A).
 *
 * Core truth: Vibecode does NOT decide which files an agent needs. The agent
 * researches the task and explicitly declares the paths it intends to work on;
 * an intent is the readable, extendable record of that declaration. It belongs
 * to exactly one agent, references the advisory claims created for it, and is
 * never inferred, expanded, or auto-populated.
 */
export interface ClaimIntent {
  /** Stable, unique, filesystem/JSON-safe identifier. */
  intent_id: string;
  /** Owning registered agent id. Only this agent may extend the intent. */
  agent_id: string;
  /** Non-empty agent-declared intent/work-scope text. */
  intent: string;
  /** Lifecycle status (Phase 2A only sets `active`). */
  status: ClaimIntentStatus;
  /** ISO-8601 timestamp of creation. */
  created_at: string;
  /** ISO-8601 timestamp of the last extension/update. */
  updated_at: string;
  /** Advisory claim ids created for this intent. */
  claim_ids: string[];
  /** Normalized repository-relative POSIX paths declared for this intent. */
  paths: string[];
}

/** Advisory claim over a repository-relative path. No source-file lock exists. */
export interface FileClaim {
  /** Stable, unique, filesystem/JSON-safe identifier. */
  claim_id: string;
  /** Owning registered agent id. */
  agent_id: string;
  /** Normalized repository-relative POSIX path. */
  path: string;
  /** Compatibility mode. */
  mode: ClaimMode;
  /** Stored or computed claim status. */
  status: ClaimStatus;
  /** ISO-8601 timestamp of claim creation. */
  created_at: string;
  /** ISO-8601 timestamp of release, when explicitly released. */
  released_at: string | null;
  /** Free-form, caller-provided metadata. */
  metadata: Record<string, unknown>;
}

/** Type guard: is `value` one of the recognized {@link AgentType}s? */
export function isAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && (AGENT_TYPES as readonly string[]).includes(value);
}

/** Type guard: is `value` one of the recognized {@link ClaimMode}s? */
export function isClaimMode(value: unknown): value is ClaimMode {
  return value === 'exclusive' || value === 'shared';
}

/**
 * The whole-workspace coordination state, persisted as generated state at
 * `.vibecode/coordination/state.json`.
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
  /** Advisory file claims. */
  claims: readonly FileClaim[];
  /** Detected conflicts (Phase 1: always empty). */
  conflicts: readonly unknown[];
  /** Handoff requests (Phase 1: always empty). */
  handoffs: readonly unknown[];
  /** Agent-declared work intents (Phase 2A; older states normalize to []). */
  intents: readonly ClaimIntent[];
}
