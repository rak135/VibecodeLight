import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { addFileClaim, releaseFileClaim } from '../../../src/core/coordination/claims.js';
import { recordConflict, listConflicts, resolveConflict } from '../../../src/core/coordination/conflicts.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';
import { HEARTBEAT_TTL_MS } from '../../../src/core/coordination/heartbeat.js';
import {
  triageConflict,
  summarizeConflictTriage,
  listConflictTriages,
  getConflictTriageDetail,
  type ConflictTriageDetail,
} from '../../../src/core/coordination/conflict_triage.js';
import { loadCoordinationState } from '../../../src/core/coordination/state.js';

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function build(repoRoot: string, agentId: string, now?: string): void {
  registerAgent(
    repoRoot,
    { agent_name: agentId, agent_type: 'codex', metadata: { operating_mode: 'build', task: 'work' } },
    { agentId, ...(now ? { now } : {}) },
  );
}

describe('Phase 2D — conflict triage', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-conflict-triage-');
  });

  afterEach(() => repo.cleanup());

  test('triage for active blocking claim includes blocking agent status', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-1' });

    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'Claim denied for src/app.ts.',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: t0 });
    const detail = triageConflict({
      conflict,
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      now: t0,
    });

    expect(detail.conflict_id).toBe('conflict-1');
    expect(detail.triage_status).toBe('still_blocking');
    expect(detail.still_actively_blocking).toBe(true);
    expect(detail.blocking_agent_id).toBe('agent-a');
    expect(detail.blocking_agent_status).toBe('active');
    expect(detail.requesting_agent_id).toBe('agent-b');
    expect(detail.requesting_agent_status).toBe('active');
    expect(detail.warning_codes).toContain('CONFLICT_STILL_BLOCKING');
  });

  test('triage detects stale blocking agent', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    const staleTime = new Date(Date.parse(t0) + HEARTBEAT_TTL_MS + 1000).toISOString();
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-1' });

    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: staleTime });
    const detail = triageConflict({
      conflict,
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      now: staleTime,
    });

    expect(detail.triage_status).toBe('stale_blocking');
    expect(detail.blocking_agent_status).toBe('stale');
    expect(detail.warning_codes).toContain('CONFLICT_OWNER_STALE');
  });

  test('triage detects terminated blocking agent', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-1' });
    markAgentTerminated(repo.repoRoot, 'agent-a', { now: t0 });

    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: t0 });
    const detail = triageConflict({
      conflict,
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      now: t0,
    });

    expect(detail.blocking_agent_status).toBe('terminated');
    expect(detail.warning_codes).toContain('CONFLICT_OWNER_TERMINATED');
  });

  test('triage detects missing blocking agent', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-nonexistent'],
      involved_agents: ['agent-missing'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: t0 });
    const detail = triageConflict({
      conflict,
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      now: t0,
    });

    expect(detail.blocking_agent_status).toBe('missing');
    expect(detail.warning_codes).toContain('CONFLICT_OWNER_MISSING');
    expect(detail.warning_codes).toContain('CONFLICT_REFERENCES_MISSING_CLAIM');
  });

  test('triage detects released blocking claim (no longer blocking)', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-1' });

    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    // Release the blocking claim.
    releaseFileClaim(repo.repoRoot, 'claim-1', { now: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: t0 });
    const detail = triageConflict({
      conflict,
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      now: t0,
    });

    expect(detail.triage_status).toBe('cleared');
    expect(detail.blocking_claim_released).toBe(true);
    expect(detail.still_actively_blocking).toBe(false);
    expect(detail.warning_codes).toContain('CONFLICT_BLOCKING_CLAIM_RELEASED');
    expect(detail.warning_codes).toContain('CONFLICT_NO_LONGER_BLOCKING');
  });

  test('triage includes blocking intent when available', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-1' });

    // Record intent directly in state (bypassing bulk claims to avoid stale-agent gate).
    const stateFile = path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.intents.push({
      intent_id: 'intent-1',
      agent_id: 'agent-a',
      intent: 'implement feature X',
      status: 'active',
      created_at: t0,
      updated_at: t0,
      claim_ids: ['claim-1'],
      paths: ['src/app.ts'],
    });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const loadedState = loadCoordinationState(repo.repoRoot, { now: t0 });
    const detail = triageConflict({
      conflict,
      agents: loadedState.agents,
      claims: loadedState.claims,
      intents: loadedState.intents,
      now: t0,
    });

    expect(detail.blocking_intent).not.toBeNull();
    expect(detail.blocking_intent!.intent_id).toBe('intent-1');
    expect(detail.blocking_intent!.intent).toBe('implement feature X');
    expect(detail.blocking_intent!.status).toBe('active');
  });

  test('triage detects released blocking intent', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-1' });

    // Record a released intent directly in state.
    const stateFile = path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.intents.push({
      intent_id: 'intent-1',
      agent_id: 'agent-a',
      intent: 'implement feature X',
      status: 'released',
      created_at: t0,
      updated_at: t0,
      released_at: t0,
      released_by_agent_id: 'agent-a',
      claim_ids: ['claim-1'],
      paths: ['src/app.ts'],
    });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    // Release the claim (and intent would be released via intent lifecycle).
    releaseFileClaim(repo.repoRoot, 'claim-1', { now: t0 });

    const loadedState2 = loadCoordinationState(repo.repoRoot, { now: t0 });
    const detail = triageConflict({
      conflict,
      agents: loadedState2.agents,
      claims: loadedState2.claims,
      intents: loadedState2.intents,
      now: t0,
    });

    expect(detail.blocking_claim_released).toBe(true);
    expect(detail.triage_status).toBe('cleared');
  });

  test('triage is read-only (no state mutation)', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-1' });

    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const stateBefore = JSON.stringify(loadCoordinationState(repo.repoRoot, { now: t0 }));
    triageConflict({
      conflict,
      agents: loadCoordinationState(repo.repoRoot, { now: t0 }).agents,
      claims: loadCoordinationState(repo.repoRoot, { now: t0 }).claims,
      intents: loadCoordinationState(repo.repoRoot, { now: t0 }).intents,
      now: t0,
    });
    const stateAfter = JSON.stringify(loadCoordinationState(repo.repoRoot, { now: t0 }));

    expect(stateBefore).toBe(stateAfter);
  });

  test('triage includes recommended next tools and commands', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-1' });

    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: t0 });
    const detail = triageConflict({
      conflict,
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      now: t0,
    });

    expect(detail.recommended_next_tools.length).toBeGreaterThan(0);
    expect(detail.recommended_next_tools).toContain('vibecode_conflicts_list');
    expect(detail.recommended_next_tools).toContain('vibecode_claims_list');
    expect(detail.recommended_cli_commands.length).toBeGreaterThan(0);
  });

  test('resolved conflict has triage_status resolved', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: [],
      involved_agents: ['agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    resolveConflict(repo.repoRoot, 'conflict-1', { resolved_at: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: t0 });
    const resolvedConflict = listConflicts(repo.repoRoot, undefined, { now: t0 })[0];
    const detail = triageConflict({
      conflict: resolvedConflict,
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      now: t0,
    });

    expect(detail.triage_status).toBe('resolved');
  });

  test('old/malformed conflict record does not crash triage', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    // A conflict with minimal fields.
    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: [],
      involved_agents: [],
      involved_files: [],
      severity: 'low',
      description: 'minimal',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: t0 });
    const detail = triageConflict({
      conflict,
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      now: t0,
    });

    expect(detail.conflict_id).toBe('conflict-1');
    expect(detail.blocking_agent_id).toBeNull();
    expect(detail.requesting_agent_id).toBeNull();
  });

  test('listConflictTriages returns enriched summaries', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-1' });

    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: t0 });
    const result = listConflictTriages({
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      conflicts: listConflicts(repo.repoRoot, undefined, { now: t0 }),
      now: t0,
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].conflict_id).toBe('conflict-1');
    expect(result.conflicts[0].triage_status).toBe('still_blocking');
    expect(result.conflicts[0].blocking_agent_id).toBe('agent-a');
    expect(result.conflicts[0].warning_codes).toContain('CONFLICT_STILL_BLOCKING');
  });

  test('getConflictTriageDetail returns null for missing conflict', () => {
    const state = loadCoordinationState(repo.repoRoot);
    const detail = getConflictTriageDetail({
      conflictId: 'nonexistent',
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      conflicts: [],
    });

    expect(detail).toBeNull();
  });

  test('conflict involving current agent as requester', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-1' });

    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: t0 });
    const detail = triageConflict({
      conflict,
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      currentAgentId: 'agent-b',
      now: t0,
    });

    expect(detail.requesting_agent_id).toBe('agent-b');
    // When current agent is the requester, recommendations should still be safe.
    expect(detail.recommended_next_tools.length).toBeGreaterThan(0);
  });

  test('conflict involving current agent as blocker', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-1' });

    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: t0 });
    const detail = triageConflict({
      conflict,
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      currentAgentId: 'agent-a',
      now: t0,
    });

    expect(detail.blocking_agent_id).toBe('agent-a');
    // Current agent is the blocker — they should release their own claim.
    expect(detail.recommended_next_tools).toContain('vibecode_claims_list');
  });

  test('no source or git mutation from triage', () => {
    const t0 = '2026-06-10T00:00:00.000Z';
    fs.mkdirSync(path.join(repo.repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.repoRoot, 'src', 'app.ts'), 'export const x = 1;\n', 'utf8');

    build(repo.repoRoot, 'agent-a', t0);
    const conflict = recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: t0,
      involved_claims: [],
      involved_agents: ['agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now: t0 });

    const state = loadCoordinationState(repo.repoRoot, { now: t0 });
    triageConflict({
      conflict,
      agents: state.agents,
      claims: state.claims,
      intents: state.intents,
      now: t0,
    });

    expect(fs.readFileSync(path.join(repo.repoRoot, 'src', 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
  });
});
