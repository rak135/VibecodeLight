import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import { recordConflict } from '../../../src/core/coordination/conflicts.js';
import {
  getCoordinationOverview,
  COORDINATION_OVERVIEW_MAX_ITEMS,
} from '../../../src/core/coordination/overview.js';
import { getCoordinationPaths, initializeCoordinationState } from '../../../src/core/coordination/state.js';
import { recordFileChangeEvidence } from '../../../src/core/coordination/watcher.js';

/**
 * Phase 5A read-only coordination overview DTO.
 *
 * Protected invariant: the desktop observability surface gets a compact,
 * read-only summary of agents/claims/conflicts/evidence derived from the same
 * shared coordination services the CLI/MCP use. Building the overview must never
 * write generated state and must survive malformed conflicts.
 */

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

// A heartbeat far enough in the past to be stale relative to `now`.
const NOW = '2026-06-07T12:00:00.000Z';
const STALE_HEARTBEAT = '2026-06-07T11:00:00.000Z'; // 1h ago > 5m TTL

describe('getCoordinationOverview', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-coord-overview-');
  });
  afterEach(() => repo.cleanup());

  test('returns a zeroed empty overview when no state file exists (read-only)', () => {
    const overview = getCoordinationOverview(repo.repoRoot, { now: NOW });

    expect(overview.agents).toEqual({ total: 0, active: 0, stale: 0, terminated: 0, items: [] });
    expect(overview.claims).toEqual({ total: 0, active: 0, stale: 0, released: 0, items: [] });
    expect(overview.conflicts).toEqual({ unresolved: 0, recent: [] });
    expect(overview.evidence).toEqual({ recent_count: 0, warning_count: 0, high_count: 0, last_event_at: null });

    // Reading the overview must not create the state file.
    expect(fs.existsSync(getCoordinationPaths(repo.repoRoot).stateFile)).toBe(false);
  });

  test('summarizes active and stale agents', () => {
    registerAgent(repo.repoRoot, { agent_name: 'Alice', agent_type: 'codex' }, { agentId: 'agent-a', now: NOW });
    // A second agent with an old heartbeat is computed-stale at NOW.
    registerAgent(
      repo.repoRoot,
      { agent_name: 'Bob', agent_type: 'claude' },
      { agentId: 'agent-b', now: STALE_HEARTBEAT },
    );

    const overview = getCoordinationOverview(repo.repoRoot, { now: NOW });

    expect(overview.agents.total).toBe(2);
    expect(overview.agents.active).toBe(1);
    expect(overview.agents.stale).toBe(1);
    expect(overview.agents.terminated).toBe(0);

    const byId = new Map(overview.agents.items.map((a) => [a.agent_id, a]));
    expect(byId.get('agent-a')).toMatchObject({ name: 'Alice', type: 'codex', status: 'active' });
    expect(byId.get('agent-b')).toMatchObject({ name: 'Bob', type: 'claude', status: 'stale' });
    expect(typeof byId.get('agent-a')?.last_heartbeat_at).toBe('string');
  });

  test('summarizes claims with the owning agent name and stale/released breakdown', () => {
    registerAgent(repo.repoRoot, { agent_name: 'Alice', agent_type: 'codex' }, { agentId: 'agent-a', now: NOW });
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: NOW });

    const overview = getCoordinationOverview(repo.repoRoot, { now: NOW });

    expect(overview.claims.total).toBe(1);
    expect(overview.claims.active).toBe(1);
    expect(overview.claims.released).toBe(0);
    expect(overview.claims.items[0]).toMatchObject({
      path: 'src/app.ts',
      mode: 'exclusive',
      status: 'active',
      agent_id: 'agent-a',
      agent_name: 'Alice',
    });
  });

  test('marks a claim stale when its owning agent is stale', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'Bob', agent_type: 'claude' },
      { agentId: 'agent-b', now: STALE_HEARTBEAT },
    );
    addFileClaim(repo.repoRoot, { agent_id: 'agent-b', path: 'src/b.ts', mode: 'exclusive' }, { now: STALE_HEARTBEAT });

    const overview = getCoordinationOverview(repo.repoRoot, { now: NOW });

    expect(overview.claims.total).toBe(1);
    expect(overview.claims.stale).toBe(1);
    expect(overview.claims.active).toBe(0);
    expect(overview.claims.items[0]).toMatchObject({ status: 'stale', agent_id: 'agent-b' });
  });

  test('summarizes unresolved conflicts and recent conflict items', () => {
    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: NOW,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-a', 'agent-b'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'claim denied on src/app.ts',
      evidence: { detector: 'claim_manager', details: {} },
    });

    const overview = getCoordinationOverview(repo.repoRoot, { now: NOW });

    expect(overview.conflicts.unresolved).toBe(1);
    expect(overview.conflicts.recent).toHaveLength(1);
    expect(overview.conflicts.recent[0]).toMatchObject({
      conflict_id: conflict.conflict_id,
      conflict_type: 'claim_denied',
      severity: 'medium',
      status: 'detected',
      involved_files: ['src/app.ts'],
      detected_at: NOW,
    });
  });

  test('summarizes evidence counts and last event time', () => {
    registerAgent(repo.repoRoot, { agent_name: 'Alice', agent_type: 'codex' }, { agentId: 'agent-a', now: NOW });
    recordFileChangeEvidence({ repoRoot: repo.repoRoot, path: 'src/unclaimed.ts', agent_id: 'agent-a' });

    const overview = getCoordinationOverview(repo.repoRoot, { now: NOW });

    expect(overview.evidence.recent_count).toBe(1);
    expect(overview.evidence.warning_count).toBe(1);
    expect(overview.evidence.high_count).toBe(0);
    expect(typeof overview.evidence.last_event_at).toBe('string');
  });

  test('caps each category to a small number of recent items', () => {
    for (let i = 0; i < COORDINATION_OVERVIEW_MAX_ITEMS + 3; i += 1) {
      registerAgent(
        repo.repoRoot,
        { agent_name: `Agent ${i}`, agent_type: 'custom' },
        { agentId: `agent-${i}`, now: NOW },
      );
    }

    const overview = getCoordinationOverview(repo.repoRoot, { now: NOW });

    expect(overview.agents.total).toBe(COORDINATION_OVERVIEW_MAX_ITEMS + 3);
    expect(overview.agents.items.length).toBe(COORDINATION_OVERVIEW_MAX_ITEMS);
  });

  test('does not crash on malformed conflicts in generated state', () => {
    initializeCoordinationState(repo.repoRoot, { now: NOW });
    const stateFile = getCoordinationPaths(repo.repoRoot).stateFile;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.conflicts = [
      null,
      'not-an-object',
      42,
      { conflict_id: 'ok-1', conflict_type: 'claim_denied', status: 'detected', detected_at: NOW, severity: 'low', involved_files: ['x'] },
      { conflict_id: 'bad-1' }, // missing most fields
    ];
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const overview = getCoordinationOverview(repo.repoRoot, { now: NOW });

    // The one well-formed detected conflict is counted; malformed entries are
    // tolerated (not counted as crashes).
    expect(overview.conflicts.unresolved).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(overview.conflicts.recent)).toBe(true);
    expect(overview.conflicts.recent.length).toBeLessThanOrEqual(COORDINATION_OVERVIEW_MAX_ITEMS);
  });

  test('does not mutate generated state when building the overview', () => {
    registerAgent(repo.repoRoot, { agent_name: 'Alice', agent_type: 'codex' }, { agentId: 'agent-a', now: NOW });
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: NOW });
    const stateFile = getCoordinationPaths(repo.repoRoot).stateFile;
    const before = fs.readFileSync(stateFile, 'utf8');

    getCoordinationOverview(repo.repoRoot, { now: NOW });

    expect(fs.readFileSync(stateFile, 'utf8')).toBe(before);
  });
});
