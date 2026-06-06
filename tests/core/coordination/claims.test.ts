import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent, heartbeatAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import {
  addFileClaim,
  listFileClaims,
  getClaimStatusForPath,
  releaseFileClaim,
} from '../../../src/core/coordination/claims.js';
import { CoordinationError } from '../../../src/core/coordination/errors.js';
import { HEARTBEAT_TTL_MS } from '../../../src/core/coordination/heartbeat.js';
import {
  getCoordinationPaths,
  loadCoordinationState,
  writeCoordinationState,
} from '../../../src/core/coordination/state.js';

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

describe('advisory file claims', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-claims-core-');
  });

  afterEach(() => repo.cleanup());

  test('adds an exclusive advisory claim and persists it in coordination state', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'Codex A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );

    const result = addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: '.\\src\\feature.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:01:00.000Z', claimId: 'claim-1' },
    );

    expect(result.claim).toMatchObject({
      claim_id: 'claim-1',
      agent_id: 'agent-1',
      path: 'src/feature.ts',
      mode: 'exclusive',
      status: 'active',
      created_at: '2026-06-06T00:01:00.000Z',
    });
    expect(result.denied).toBe(false);

    const state = loadCoordinationState(repo.repoRoot);
    expect(state.claims).toEqual([result.claim]);
    expect(state.agents[0].claims).toEqual(['claim-1']);
    expect(listFiles(repo.repoRoot)).toEqual(['.vibecode/coordination/state.json']);
  });

  test('allows overlapping shared claims from active agents', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-a' });
    registerAgent(repo.repoRoot, { agent_name: 'B', agent_type: 'claude' }, { agentId: 'agent-b' });

    const a = addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src', mode: 'shared' }, { claimId: 'claim-a' });
    const b = addFileClaim(repo.repoRoot, { agent_id: 'agent-b', path: 'src/app.ts', mode: 'shared' }, { claimId: 'claim-b' });

    expect(a.denied).toBe(false);
    expect(b.denied).toBe(false);
    expect(listFileClaims(repo.repoRoot).map((claim) => claim.claim_id)).toEqual(['claim-a', 'claim-b']);
  });

  test('denies an exclusive claim that overlaps an active shared claim', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-a' });
    registerAgent(repo.repoRoot, { agent_name: 'B', agent_type: 'claude' }, { agentId: 'agent-b' });
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'shared' }, { claimId: 'claim-a' });

    const denied = addFileClaim(repo.repoRoot, { agent_id: 'agent-b', path: 'src', mode: 'exclusive' });

    expect(denied.denied).toBe(true);
    expect(denied.error?.code).toBe('CLAIM_DENIED');
    expect(denied.conflicting_claims.map((claim) => claim.claim_id)).toEqual(['claim-a']);
    expect(loadCoordinationState(repo.repoRoot).claims).toHaveLength(1);
  });

  test('allows an exclusive claim when the only overlapping claim belongs to a stale agent', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-a' },
    );
    registerAgent(
      repo.repoRoot,
      { agent_name: 'B', agent_type: 'claude' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-b' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-stale' },
    );

    const later = new Date(Date.parse('2026-06-06T00:00:00.000Z') + HEARTBEAT_TTL_MS + 1000).toISOString();
    heartbeatAgent(repo.repoRoot, 'agent-b', { now: later });
    const claim = addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-b', path: 'src', mode: 'exclusive' },
      { now: later, claimId: 'claim-new' },
    );

    expect(claim.denied).toBe(false);
    expect(claim.claim?.claim_id).toBe('claim-new');
  });

  test('rejects missing, stale, and terminated agents when adding a claim', () => {
    expect(() =>
      addFileClaim(repo.repoRoot, { agent_id: 'missing', path: 'src/a.ts', mode: 'exclusive' }),
    ).toThrowError(CoordinationError);

    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-a' },
    );
    const later = new Date(Date.parse('2026-06-06T00:00:00.000Z') + HEARTBEAT_TTL_MS + 1000).toISOString();
    expect(() =>
      addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/a.ts', mode: 'exclusive' }, { now: later }),
    ).toThrowError(CoordinationError);

    registerAgent(repo.repoRoot, { agent_name: 'B', agent_type: 'claude' }, { agentId: 'agent-b' });
    markAgentTerminated(repo.repoRoot, 'agent-b');
    expect(() =>
      addFileClaim(repo.repoRoot, { agent_id: 'agent-b', path: 'src/b.ts', mode: 'exclusive' }),
    ).toThrowError(CoordinationError);
  });

  test('rejects invalid paths before writing state', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-a' });

    for (const invalid of ['', '..\\outside.ts', '.vibecode/coordination/state.json', '.']) {
      try {
        addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: invalid, mode: 'exclusive' });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CoordinationError);
        expect((err as CoordinationError).code).toBe('INVALID_CLAIM_PATH');
      }
    }
    expect(loadCoordinationState(repo.repoRoot).claims).toEqual([]);
  });

  test('status for a path reports overlapping active claims and claimability', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-a' });
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src', mode: 'shared' }, { claimId: 'claim-a' });

    const status = getClaimStatusForPath(repo.repoRoot, 'src/app.ts');

    expect(status.path).toBe('src/app.ts');
    expect(status.matching_claims.map((claim) => claim.claim_id)).toEqual(['claim-a']);
    expect(status.can_claim_shared).toBe(true);
    expect(status.can_claim_exclusive).toBe(false);
  });

  test('release marks a claim released and removes it from the agent active claim list', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-a' });
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { claimId: 'claim-a' });

    const released = releaseFileClaim(repo.repoRoot, 'claim-a', { now: '2026-06-06T00:05:00.000Z' });

    expect(released.claim.status).toBe('released');
    expect(released.claim.released_at).toBe('2026-06-06T00:05:00.000Z');
    const state = loadCoordinationState(repo.repoRoot);
    expect(state.claims[0]).toMatchObject({ claim_id: 'claim-a', status: 'released' });
    expect(state.agents[0].claims).toEqual([]);
  });

  test('normalization round-trips existing claim arrays without conflict records', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-a' });
    const state = loadCoordinationState(repo.repoRoot);
    writeCoordinationState(repo.repoRoot, {
      ...state,
      conflicts: [{ conflict_id: 'existing' }] as never,
      handoffs: [{ handoff_id: 'existing' }] as never,
    });

    const denied = addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' },
      { claimId: 'claim-a' },
    );

    expect(denied.denied).toBe(false);
    const onDisk = loadCoordinationState(repo.repoRoot);
    expect(onDisk.conflicts).toEqual([{ conflict_id: 'existing' }]);
    expect(onDisk.handoffs).toEqual([{ handoff_id: 'existing' }]);
  });
});
