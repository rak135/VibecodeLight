import { listFileClaims } from './claims.js';
import { getCoordinationStatus } from './status.js';

/**
 * Phase 5A read-only coordination overview.
 *
 * A compact, presentation-friendly summary of the advisory coordination state,
 * built for the desktop observability surface. It is a THIN projection over the
 * existing shared read-only services (`getCoordinationStatus`, `listFileClaims`)
 * — it adds no new coordination semantics, never mutates generated state, and is
 * resilient to malformed conflict records.
 *
 * This phase is visibility-only: there is intentionally no claim creation,
 * release, reap, conflict resolution, watcher control, finalize, or commit
 * behavior here.
 */

/** Maximum number of recent items returned per category. */
export const COORDINATION_OVERVIEW_MAX_ITEMS = 5;

/** Compact, read-only view of a registered agent. */
export interface CoordinationOverviewAgentItem {
  agent_id: string;
  name: string;
  type: string;
  status: string;
  last_heartbeat_at?: string;
}

/** Compact, read-only view of an advisory file claim. */
export interface CoordinationOverviewClaimItem {
  claim_id: string;
  path: string;
  mode: string;
  status: string;
  agent_id: string;
  agent_name?: string;
}

/** Compact, read-only view of a recorded conflict. */
export interface CoordinationOverviewConflictItem {
  conflict_id: string;
  conflict_type: string;
  severity: string;
  status: string;
  involved_files: string[];
  detected_at: string;
}

/** The whole read-only coordination overview DTO. */
export interface CoordinationOverview {
  agents: {
    total: number;
    active: number;
    stale: number;
    terminated: number;
    items: CoordinationOverviewAgentItem[];
  };
  claims: {
    total: number;
    active: number;
    stale: number;
    released: number;
    items: CoordinationOverviewClaimItem[];
  };
  conflicts: {
    unresolved: number;
    recent: CoordinationOverviewConflictItem[];
  };
  evidence: {
    recent_count: number;
    warning_count: number;
    high_count: number;
    last_event_at: string | null;
  };
}

/** Defensive numeric parse for sorting; unparseable timestamps sort last. */
function parseTimeMs(value: unknown): number {
  if (typeof value !== 'string') return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** Tolerant projection of an unknown stored conflict into a compact item. */
function toConflictItem(raw: unknown): CoordinationOverviewConflictItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const involvedFiles = Array.isArray(c.involved_files)
    ? c.involved_files.filter((f): f is string => typeof f === 'string')
    : [];
  return {
    conflict_id: typeof c.conflict_id === 'string' ? c.conflict_id : '',
    conflict_type: typeof c.conflict_type === 'string' ? c.conflict_type : 'unknown',
    severity: typeof c.severity === 'string' ? c.severity : 'low',
    status: typeof c.status === 'string' ? c.status : 'detected',
    involved_files: involvedFiles,
    detected_at: typeof c.detected_at === 'string' ? c.detected_at : '',
  };
}

/**
 * Build the read-only coordination overview for a repo. Read-only and resilient:
 * a missing or corrupt state yields a stable zeroed overview, and malformed
 * conflict records are tolerated rather than thrown.
 */
export function getCoordinationOverview(
  repoRoot: string,
  options: { now?: string } = {},
): CoordinationOverview {
  const now = options.now ?? new Date().toISOString();
  const status = getCoordinationStatus(repoRoot, { now });

  // --- agents (status already overlays computed stale/terminated status) ---
  const agents = status.agents;
  const agentItems: CoordinationOverviewAgentItem[] = agents
    .slice(0, COORDINATION_OVERVIEW_MAX_ITEMS)
    .map((a) => ({
      agent_id: a.agent_id,
      name: a.agent_name,
      type: a.agent_type,
      status: a.status,
      last_heartbeat_at: a.last_heartbeat_at,
    }));

  // --- claims (listFileClaims overlays computed stale status; include released) ---
  const claims = listFileClaims(repoRoot, { now, includeReleased: true });
  const agentNameById = new Map(agents.map((a) => [a.agent_id, a.agent_name] as const));
  const claimItems: CoordinationOverviewClaimItem[] = claims
    .slice(0, COORDINATION_OVERVIEW_MAX_ITEMS)
    .map((c) => ({
      claim_id: c.claim_id,
      path: c.path,
      mode: c.mode,
      status: c.status,
      agent_id: c.agent_id,
      agent_name: agentNameById.get(c.agent_id),
    }));

  // --- conflicts (tolerant of malformed generated state) ---
  const rawConflicts = Array.isArray(status.state.conflicts) ? status.state.conflicts : [];
  const conflictItems = rawConflicts
    .map(toConflictItem)
    .filter((c): c is CoordinationOverviewConflictItem => c !== null);
  const recentConflicts = [...conflictItems]
    .sort((a, b) => parseTimeMs(b.detected_at) - parseTimeMs(a.detected_at))
    .slice(0, COORDINATION_OVERVIEW_MAX_ITEMS);
  const unresolved = conflictItems.filter((c) => c.status === 'detected').length;

  return {
    agents: {
      total: agents.length,
      active: agents.filter((a) => a.status === 'active').length,
      stale: agents.filter((a) => a.status === 'stale').length,
      terminated: agents.filter((a) => a.status === 'terminated').length,
      items: agentItems,
    },
    claims: {
      total: claims.length,
      active: claims.filter((c) => c.status === 'active').length,
      stale: claims.filter((c) => c.status === 'stale').length,
      released: claims.filter((c) => c.status === 'released').length,
      items: claimItems,
    },
    conflicts: {
      unresolved,
      recent: recentConflicts,
    },
    evidence: {
      recent_count: status.evidence.recent_count,
      warning_count: status.evidence.warning_count,
      high_count: status.evidence.high_count,
      last_event_at: status.evidence.last_event_at,
    },
  };
}
