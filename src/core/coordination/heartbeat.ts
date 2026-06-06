import type { AgentSession, AgentStatus } from './types.js';

/**
 * Heartbeat / stale detection.
 *
 * Stale detection is **computed-only**: `computeAgentStatus` derives a display
 * status from a stored session plus an explicit `nowMs`, and never mutates or
 * persists anything. The stored status only changes through the explicit
 * register/heartbeat/terminate mutations in `agents.ts`. Passing `nowMs`
 * (rather than reading the clock here) keeps stale tests deterministic.
 */

/** Default heartbeat time-to-live: 5 minutes. */
export const HEARTBEAT_TTL_MS = 5 * 60 * 1000;

/**
 * Derive the effective status of an agent at time `nowMs`.
 *
 * Rules (in order):
 *   1. `terminated` stays `terminated`.
 *   2. An unparseable `last_heartbeat_at` yields `unknown`.
 *   3. A heartbeat strictly older than `ttlMs` yields `stale`.
 *   4. Otherwise the stored `idle` is preserved; anything else is `active`.
 */
export function computeAgentStatus(
  agent: Pick<AgentSession, 'status' | 'last_heartbeat_at'>,
  nowMs: number,
  ttlMs: number = HEARTBEAT_TTL_MS,
): AgentStatus {
  if (agent.status === 'terminated') return 'terminated';

  const heartbeatMs = Date.parse(agent.last_heartbeat_at);
  if (Number.isNaN(heartbeatMs)) return 'unknown';

  if (nowMs - heartbeatMs > ttlMs) return 'stale';
  if (agent.status === 'idle') return 'idle';
  return 'active';
}
