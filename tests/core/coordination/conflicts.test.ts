import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import {
  recordConflict,
  listConflicts,
  resolveConflict,
  type ConflictRecord,
} from '../../../src/core/coordination/conflicts.js';
import { loadCoordinationState } from '../../../src/core/coordination/state.js';

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('conflict recording', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-conflicts-');
  });

  afterEach(() => repo.cleanup());

  test('records a claim_denied conflict and persists it in state.json', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-1' });
    registerAgent(repo.repoRoot, { agent_name: 'B', agent_type: 'claude' }, { agentId: 'agent-2' });
    addFileClaim(repo.repoRoot, { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' }, { claimId: 'claim-1' });

    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: '2026-06-06T00:01:00.000Z',
      involved_claims: ['claim-1'],
      involved_agents: ['agent-1', 'agent-2'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'Claim denied for src/app.ts: 1 overlapping active claim(s).',
      evidence: {
        detector: 'claim_manager',
        details: { requested: { agent_id: 'agent-2', path: 'src/app.ts', mode: 'exclusive' } },
      },
    }, { conflictId: 'conflict-1' });

    expect(conflict.conflict_id).toBe('conflict-1');
    expect(conflict.status).toBe('detected');
    expect(conflict.conflict_type).toBe('claim_denied');

    const state = loadCoordinationState(repo.repoRoot);
    expect(state.conflicts).toHaveLength(1);
    expect((state.conflicts as ConflictRecord[])[0].conflict_id).toBe('conflict-1');
  });

  test('conflicts list returns recorded conflicts', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-1' });

    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: '2026-06-06T00:01:00.000Z',
      involved_claims: ['claim-1'],
      involved_agents: ['agent-1', 'agent-2'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1' });

    const list = listConflicts(repo.repoRoot);
    expect(list).toHaveLength(1);
    expect(list[0].conflict_id).toBe('conflict-1');
  });

  test('conflicts list filters by status', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-1' });

    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: '2026-06-06T00:01:00.000Z',
      involved_claims: ['claim-1'],
      involved_agents: ['agent-1'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1' });

    resolveConflict(repo.repoRoot, 'conflict-1', {
      resolved_at: '2026-06-06T00:05:00.000Z',
      resolved_by: 'agent-1',
    });

    expect(listConflicts(repo.repoRoot, { status: 'detected' })).toHaveLength(0);
    expect(listConflicts(repo.repoRoot, { status: 'resolved' })).toHaveLength(1);
  });

  test('conflicts resolve marks conflict as resolved', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-1' });

    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: '2026-06-06T00:01:00.000Z',
      involved_claims: ['claim-1'],
      involved_agents: ['agent-1', 'agent-2'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1' });

    const resolved = resolveConflict(repo.repoRoot, 'conflict-1', {
      resolved_at: '2026-06-06T00:05:00.000Z',
      resolved_by: 'agent-1',
      resolution: { action: 'released_claim' },
    });

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).toBe('2026-06-06T00:05:00.000Z');
    expect(resolved.resolved_by).toBe('agent-1');

    const state = loadCoordinationState(repo.repoRoot);
    expect((state.conflicts as ConflictRecord[])[0].status).toBe('resolved');
  });

  test('resolve throws for unknown conflict id', () => {
    expect(() =>
      resolveConflict(repo.repoRoot, 'nonexistent', { resolved_at: '2026-06-06T00:05:00.000Z' }),
    ).toThrow('Conflict not found: nonexistent');
  });

  test('duplicate denial does not create unbounded duplicates', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-1' });
    registerAgent(repo.repoRoot, { agent_name: 'B', agent_type: 'claude' }, { agentId: 'agent-2' });
    addFileClaim(repo.repoRoot, { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' }, { claimId: 'claim-1' });

    const input = {
      conflict_type: 'claim_denied' as const,
      detected_at: '2026-06-06T00:01:00.000Z',
      involved_claims: ['claim-1'],
      involved_agents: ['agent-1', 'agent-2'],
      involved_files: ['src/app.ts'],
      severity: 'medium' as const,
      description: 'denied',
      evidence: { detector: 'claim_manager' as const, details: {} },
    };

    recordConflict(repo.repoRoot, input);
    recordConflict(repo.repoRoot, input);
    recordConflict(repo.repoRoot, input);

    const state = loadCoordinationState(repo.repoRoot);
    expect(state.conflicts).toHaveLength(1);
  });

  test('conflict recording does not alter claim behavior', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { agentId: 'agent-1' });
    registerAgent(repo.repoRoot, { agent_name: 'B', agent_type: 'claude' }, { agentId: 'agent-2' });
    const denied = addFileClaim(repo.repoRoot, { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' }, { claimId: 'claim-1' });

    // Record a conflict for the denial.
    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: '2026-06-06T00:01:00.000Z',
      involved_claims: ['claim-1'],
      involved_agents: ['agent-1', 'agent-2'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    });

    // Claim state should be unchanged — conflicts are additive.
    const state = loadCoordinationState(repo.repoRoot);
    expect(state.claims).toHaveLength(1);
    expect(state.claims[0].status).toBe('active');
    expect(state.claims[0].agent_id).toBe('agent-1');
  });

  test('no source or git mutation', () => {
    fs.mkdirSync(path.join(repo.repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.repoRoot, 'src', 'app.ts'), 'export const x = 1;\n', 'utf8');

    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: '2026-06-06T00:01:00.000Z',
      involved_claims: [],
      involved_agents: [],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    });

    expect(fs.readFileSync(path.join(repo.repoRoot, 'src', 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  test('resolved conflicts can be listed with type filter', () => {
    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: '2026-06-06T00:01:00.000Z',
      involved_claims: ['claim-1'],
      involved_agents: ['agent-1'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1' });

    recordConflict(repo.repoRoot, {
      conflict_type: 'stale_claim',
      detected_at: '2026-06-06T00:02:00.000Z',
      involved_claims: ['claim-2'],
      involved_agents: ['agent-2'],
      involved_files: ['src/b.ts'],
      severity: 'low',
      description: 'stale',
      evidence: { detector: 'claim_cleanup', details: {} },
    }, { conflictId: 'conflict-2' });

    expect(listConflicts(repo.repoRoot, { conflict_type: 'claim_denied' })).toHaveLength(1);
    expect(listConflicts(repo.repoRoot, { conflict_type: 'stale_claim' })).toHaveLength(1);
    expect(listConflicts(repo.repoRoot)).toHaveLength(2);
  });
});
