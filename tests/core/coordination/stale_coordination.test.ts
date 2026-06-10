import { describe, expect, test } from 'vitest';

import {
  computeIntentOwnerStatus,
  summarizeStaleCoordination,
  DEFAULT_STALE_SAMPLE_ITEMS,
} from '../../../src/core/coordination/stale_coordination.js';
import type { AgentSession, ClaimIntent, FileClaim } from '../../../src/core/coordination/types.js';

/**
 * Phase 2C: stale coordination summary core contract.
 *
 * What breaks if removed:
 *   - counts could silently start being computed from capped samples;
 *   - owner-status mapping (active/stale/terminated/missing) could drift;
 *   - recommendations could start implying automatic or cross-agent cleanup.
 */

function agent(id: string, status: AgentSession['status']): AgentSession {
  return {
    agent_id: id,
    agent_name: id,
    agent_type: 'codex',
    terminal_session_id: null,
    started_at: '2026-06-10T00:00:00.000Z',
    last_heartbeat_at: '2026-06-10T00:00:00.000Z',
    status,
    pid: null,
    claims: [],
    metadata: {},
  };
}

function claim(id: string, agentId: string, status: FileClaim['status'], p = `src/${id}.ts`): FileClaim {
  return {
    claim_id: id,
    agent_id: agentId,
    path: p,
    mode: 'exclusive',
    status,
    created_at: '2026-06-10T00:00:00.000Z',
    released_at: null,
    metadata: {},
  };
}

function intent(id: string, agentId: string, claimIds: string[], status: ClaimIntent['status'] = 'active'): ClaimIntent {
  return {
    intent_id: id,
    agent_id: agentId,
    intent: `work ${id}`,
    status,
    created_at: '2026-06-10T00:00:00.000Z',
    updated_at: '2026-06-10T00:00:00.000Z',
    claim_ids: claimIds,
    paths: claimIds.map((c) => `src/${c}.ts`),
  };
}

describe('computeIntentOwnerStatus', () => {
  const byId = new Map<string, AgentSession>([
    ['a-active', agent('a-active', 'active')],
    ['a-idle', agent('a-idle', 'idle')],
    ['a-stale', agent('a-stale', 'stale')],
    ['a-term', agent('a-term', 'terminated')],
    ['a-unknown', agent('a-unknown', 'unknown')],
  ]);

  test('maps computed agent statuses onto owner statuses', () => {
    expect(computeIntentOwnerStatus(byId, 'a-active')).toBe('active');
    expect(computeIntentOwnerStatus(byId, 'a-idle')).toBe('active');
    expect(computeIntentOwnerStatus(byId, 'a-stale')).toBe('stale');
    expect(computeIntentOwnerStatus(byId, 'a-term')).toBe('terminated');
    expect(computeIntentOwnerStatus(byId, 'a-unknown')).toBe('stale');
    expect(computeIntentOwnerStatus(byId, 'nobody')).toBe('missing');
  });
});

describe('summarizeStaleCoordination', () => {
  test('clean state reports no stale state and no recommendations', () => {
    const summary = summarizeStaleCoordination({
      agents: [agent('a', 'active')],
      claims: [claim('c1', 'a', 'active')],
      intents: [intent('i1', 'a', ['c1'])],
    });
    expect(summary.has_stale_state).toBe(false);
    expect(summary.stale_agents_count).toBe(0);
    expect(summary.stale_active_claims_count).toBe(0);
    expect(summary.active_intents_owned_by_stale_agents_count).toBe(0);
    expect(summary.active_intents_with_no_active_claims_count).toBe(0);
    expect(summary.samples.stale_agents).toEqual([]);
    expect(summary.samples.stale_claims).toEqual([]);
    expect(summary.samples.stale_intents).toEqual([]);
    expect(summary.recommended_cli_commands).toEqual([]);
    expect(summary.samples_truncated).toBe(false);
  });

  test('stale agent with stale claims and a stale-owned active intent is fully counted', () => {
    const summary = summarizeStaleCoordination({
      agents: [agent('dead', 'stale'), agent('me', 'active')],
      claims: [claim('c1', 'dead', 'stale'), claim('c2', 'dead', 'stale'), claim('c3', 'me', 'active')],
      intents: [intent('i1', 'dead', ['c1', 'c2']), intent('i2', 'me', ['c3'])],
      currentAgentId: 'me',
    });
    expect(summary.has_stale_state).toBe(true);
    expect(summary.stale_agents_count).toBe(1);
    expect(summary.stale_active_claims_count).toBe(2);
    expect(summary.active_intents_owned_by_stale_agents_count).toBe(1);
    // A stale-owned intent's claims are computed stale (not active), so it also
    // counts as an active intent with no active claims.
    expect(summary.active_intents_with_no_active_claims_count).toBe(1);
    expect(summary.samples.stale_intents[0]).toMatchObject({
      intent_id: 'i1',
      agent_id: 'dead',
      owner_status: 'stale',
    });
    // Recommendations are explicit housekeeping commands only.
    expect(summary.recommended_cli_commands).toContain('vibecode claims list --json');
    expect(summary.recommended_cli_commands).toContain('vibecode claims reap --dry-run --json');
    expect(summary.recommended_cli_commands).toContain('vibecode agents heartbeat --agent me --json');
    // Never a cross-agent intent release.
    expect(summary.recommended_cli_commands.every((c) => !c.includes('intent-release'))).toBe(true);
  });

  test('terminated and missing intent owners are counted separately', () => {
    const summary = summarizeStaleCoordination({
      agents: [agent('term', 'terminated')],
      claims: [],
      intents: [intent('i1', 'term', []), intent('i2', 'ghost', [])],
    });
    expect(summary.active_intents_owned_by_terminated_agents_count).toBe(1);
    expect(summary.active_intents_owned_by_missing_agents_count).toBe(1);
    expect(summary.samples.stale_intents.map((s) => s.owner_status).sort()).toEqual(['missing', 'terminated']);
  });

  test('active intent with zero active claims is surfaced even with an active owner', () => {
    const summary = summarizeStaleCoordination({
      agents: [agent('a', 'active')],
      claims: [claim('c1', 'a', 'released')],
      intents: [intent('i1', 'a', ['c1'])],
    });
    expect(summary.has_stale_state).toBe(true);
    expect(summary.active_intents_with_no_active_claims_count).toBe(1);
    expect(summary.samples.intents_with_no_active_claims[0].intent_id).toBe('i1');
    expect(summary.active_intents_owned_by_stale_agents_count).toBe(0);
  });

  test('released intents are ignored', () => {
    const summary = summarizeStaleCoordination({
      agents: [agent('dead', 'stale')],
      claims: [],
      intents: [intent('i1', 'dead', [], 'released')],
    });
    expect(summary.active_intents_owned_by_stale_agents_count).toBe(0);
    expect(summary.active_intents_with_no_active_claims_count).toBe(0);
    // Stale agent alone still counts as stale state.
    expect(summary.has_stale_state).toBe(true);
    expect(summary.stale_agents_count).toBe(1);
  });

  test('samples are bounded by maxItems while counts cover everything', () => {
    const staleAgents = Array.from({ length: 15 }, (_, i) => agent(`dead-${i}`, 'stale' as const));
    const staleClaims = staleAgents.map((a, i) => claim(`c${i}`, a.agent_id, 'stale' as const));
    const summary = summarizeStaleCoordination({
      agents: staleAgents,
      claims: staleClaims,
      intents: staleAgents.map((a, i) => intent(`i${i}`, a.agent_id, [`c${i}`])),
      maxItems: 3,
    });
    expect(summary.stale_agents_count).toBe(15);
    expect(summary.stale_active_claims_count).toBe(15);
    expect(summary.active_intents_owned_by_stale_agents_count).toBe(15);
    expect(summary.samples.stale_agents).toHaveLength(3);
    expect(summary.samples.stale_claims).toHaveLength(3);
    expect(summary.samples.stale_intents).toHaveLength(3);
    expect(summary.samples_truncated).toBe(true);
  });

  test('default sample cap exists', () => {
    expect(DEFAULT_STALE_SAMPLE_ITEMS).toBeGreaterThan(0);
  });

  test('no heartbeat recommendation without a current agent', () => {
    const summary = summarizeStaleCoordination({
      agents: [agent('dead', 'stale')],
      claims: [],
      intents: [],
    });
    expect(summary.recommended_cli_commands.every((c) => !c.includes('heartbeat'))).toBe(true);
    expect(summary.recommended_cli_commands).toContain('vibecode claims reap --dry-run --json');
  });
});
