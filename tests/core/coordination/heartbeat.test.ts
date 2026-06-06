import { describe, expect, test } from 'vitest';

import {
  HEARTBEAT_TTL_MS,
  computeAgentStatus,
} from '../../../src/core/coordination/heartbeat.js';
import type { AgentSession } from '../../../src/core/coordination/types.js';

/**
 * Heartbeat / stale detection is deterministic: `computeAgentStatus` takes an
 * explicit `nowMs` so tests never depend on the wall clock. Stale is a
 * *computed-only* overlay — the stored status is never mutated by a read.
 */

function agent(overrides: Partial<AgentSession>): AgentSession {
  return {
    agent_id: 'agent-1',
    agent_name: 'A',
    agent_type: 'codex',
    terminal_session_id: null,
    started_at: '2026-06-06T00:00:00.000Z',
    last_heartbeat_at: '2026-06-06T00:00:00.000Z',
    status: 'active',
    pid: null,
    claims: [],
    metadata: {},
    ...overrides,
  };
}

describe('computeAgentStatus', () => {
  const base = Date.parse('2026-06-06T00:00:00.000Z');

  test('default TTL is 5 minutes', () => {
    expect(HEARTBEAT_TTL_MS).toBe(5 * 60 * 1000);
  });

  test('an active agent stays active before the TTL elapses', () => {
    const a = agent({ status: 'active' });
    const nowMs = base + HEARTBEAT_TTL_MS - 1;
    expect(computeAgentStatus(a, nowMs)).toBe('active');
  });

  test('an agent at exactly the TTL boundary is not yet stale', () => {
    const a = agent({ status: 'active' });
    expect(computeAgentStatus(a, base + HEARTBEAT_TTL_MS)).toBe('active');
  });

  test('an agent older than the TTL is computed as stale', () => {
    const a = agent({ status: 'active' });
    const nowMs = base + HEARTBEAT_TTL_MS + 1;
    expect(computeAgentStatus(a, nowMs)).toBe('stale');
  });

  test('an idle agent stays idle while fresh', () => {
    const a = agent({ status: 'idle' });
    expect(computeAgentStatus(a, base + 1000)).toBe('idle');
  });

  test('a terminated agent stays terminated regardless of heartbeat age', () => {
    const a = agent({ status: 'terminated' });
    expect(computeAgentStatus(a, base + HEARTBEAT_TTL_MS * 100)).toBe('terminated');
  });

  test('an unparseable heartbeat timestamp is reported as unknown', () => {
    const a = agent({ last_heartbeat_at: 'not-a-date' });
    expect(computeAgentStatus(a, base)).toBe('unknown');
  });

  test('a custom TTL is honored', () => {
    const a = agent({ status: 'active' });
    expect(computeAgentStatus(a, base + 2000, 1000)).toBe('stale');
    expect(computeAgentStatus(a, base + 500, 1000)).toBe('active');
  });
});
