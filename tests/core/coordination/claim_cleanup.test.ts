import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import {
  reapStaleClaims,
} from '../../../src/core/coordination/claim_cleanup.js';
import { HEARTBEAT_TTL_MS } from '../../../src/core/coordination/heartbeat.js';
import { loadCoordinationState, writeCoordinationState } from '../../../src/core/coordination/state.js';

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('reapStaleClaims', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-reap-');
  });

  afterEach(() => repo.cleanup());

  test('dry-run reports stale claims without mutating state', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-1' },
    );

    const later = new Date(Date.parse('2026-06-06T00:00:00.000Z') + HEARTBEAT_TTL_MS + 1000).toISOString();
    const result = reapStaleClaims({ repoRoot: repo.repoRoot, now: later, mode: 'dry_run' });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('dry_run');
    expect(result.stale_agents).toHaveLength(1);
    expect(result.stale_agents[0].agent_id).toBe('agent-1');
    expect(result.stale_claims).toHaveLength(1);
    expect(result.stale_claims[0].claim_id).toBe('claim-1');
    expect(result.reaped_claims).toHaveLength(0);

    // State is unchanged.
    const state = loadCoordinationState(repo.repoRoot);
    expect(state.claims[0].status).toBe('active');
  });

  test('apply marks stale-agent claims as released with reaped metadata', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-1' },
    );

    const later = new Date(Date.parse('2026-06-06T00:00:00.000Z') + HEARTBEAT_TTL_MS + 1000).toISOString();
    const result = reapStaleClaims({ repoRoot: repo.repoRoot, now: later, mode: 'apply' });

    expect(result.ok).toBe(true);
    expect(result.reaped_claims).toHaveLength(1);
    expect(result.reaped_claims[0].claim_id).toBe('claim-1');
    expect(result.reaped_claims[0].status).toBe('released');
    expect(result.reaped_claims[0].metadata.reaped).toBe(true);
    expect(result.reaped_claims[0].metadata.reap_reason).toBe('stale_agent_reap');

    const state = loadCoordinationState(repo.repoRoot);
    expect(state.claims[0].status).toBe('released');
    expect(state.claims[0].metadata.reaped).toBe(true);
    expect(state.agents[0].claims).toEqual([]);
  });

  test('active agent claims are not reaped', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-1' },
    );

    const result = reapStaleClaims({ repoRoot: repo.repoRoot, now: '2026-06-06T00:01:00.000Z', mode: 'apply' });

    expect(result.stale_agents).toHaveLength(0);
    expect(result.stale_claims).toHaveLength(0);
    expect(result.reaped_claims).toHaveLength(0);

    const state = loadCoordinationState(repo.repoRoot);
    expect(state.claims[0].status).toBe('active');
  });

  test('terminated agent claims are reaped', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-1' },
    );
    markAgentTerminated(repo.repoRoot, 'agent-1', { now: '2026-06-06T00:02:00.000Z' });

    const result = reapStaleClaims({ repoRoot: repo.repoRoot, now: '2026-06-06T00:03:00.000Z', mode: 'apply' });

    expect(result.stale_agents).toHaveLength(1);
    expect(result.stale_agents[0].status).toBe('terminated');
    expect(result.reaped_claims).toHaveLength(1);

    const state = loadCoordinationState(repo.repoRoot);
    expect(state.claims[0].status).toBe('released');
  });

  test('after reaping, another active agent can claim the same file', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-1' },
    );

    const later = new Date(Date.parse('2026-06-06T00:00:00.000Z') + HEARTBEAT_TTL_MS + 1000).toISOString();
    reapStaleClaims({ repoRoot: repo.repoRoot, now: later, mode: 'apply' });

    // Register a new active agent.
    registerAgent(
      repo.repoRoot,
      { agent_name: 'B', agent_type: 'claude' },
      { now: later, agentId: 'agent-2' },
    );

    const claim = addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-2', path: 'src/app.ts', mode: 'exclusive' },
      { now: later, claimId: 'claim-2' },
    );

    expect(claim.denied).toBe(false);
    expect(claim.claim?.claim_id).toBe('claim-2');
  });

  test('missing state returns stable empty result', () => {
    const result = reapStaleClaims({ repoRoot: repo.repoRoot, now: '2026-06-06T00:00:00.000Z' });

    expect(result.ok).toBe(true);
    expect(result.stale_agents).toHaveLength(0);
    expect(result.stale_claims).toHaveLength(0);
    expect(result.reaped_claims).toHaveLength(0);
  });

  test('no source or git mutation', () => {
    fs.mkdirSync(path.join(repo.repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.repoRoot, 'src', 'app.ts'), 'export const x = 1;\n', 'utf8');

    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-1' },
    );

    const later = new Date(Date.parse('2026-06-06T00:00:00.000Z') + HEARTBEAT_TTL_MS + 1000).toISOString();
    reapStaleClaims({ repoRoot: repo.repoRoot, now: later, mode: 'apply' });

    expect(fs.readFileSync(path.join(repo.repoRoot, 'src', 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  test('already released claims are not reaped again', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-1' },
    );

    // Release the claim first.
    const state = loadCoordinationState(repo.repoRoot);
    const released = { ...state.claims[0], status: 'released' as const, released_at: '2026-06-06T00:01:00.000Z' };
    const claims = [...state.claims];
    claims[0] = released;
    writeCoordinationState(repo.repoRoot, { ...state, claims, last_updated: '2026-06-06T00:01:00.000Z' });

    const later = new Date(Date.parse('2026-06-06T00:00:00.000Z') + HEARTBEAT_TTL_MS + 1000).toISOString();
    const result = reapStaleClaims({ repoRoot: repo.repoRoot, now: later, mode: 'apply' });

    expect(result.reaped_claims).toHaveLength(0);
  });
});
