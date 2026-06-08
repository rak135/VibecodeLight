import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import { initializeCoordinationState, getCoordinationPaths } from '../../../src/core/coordination/state.js';
import { getCoordinationStatus } from '../../../src/core/coordination/status.js';
import { recordFileChangeEvidence } from '../../../src/core/coordination/watcher.js';

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('getCoordinationStatus (shared core service)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-coord-status-');
  });
  afterEach(() => repo.cleanup());

  test('returns a stable empty status when no state file exists (read-only)', () => {
    const result = getCoordinationStatus(repo.repoRoot, { now: '2026-06-06T00:00:00.000Z' });

    expect(result.workspace_root).toBe(repo.repoRoot);
    expect(result.state_file).toBe(getCoordinationPaths(repo.repoRoot).stateFile);
    expect(result.state_file_exists).toBe(false);
    expect(result.version).toBe(1);
    expect(result.summary).toEqual({ agents: 0, claims: 0, conflicts: 0, handoffs: 0, unresolved_conflicts: 0, stale_claims: 0 });
    expect(result.state.agents).toEqual([]);
    expect(result.state.claims).toEqual([]);

    // Status must not initialize or write anything.
    expect(fs.existsSync(result.state_file)).toBe(false);
  });

  test('reports state_file_exists and counts from a written state', () => {
    initializeCoordinationState(repo.repoRoot, { now: '2026-06-06T00:00:00.000Z' });
    const result = getCoordinationStatus(repo.repoRoot);
    expect(result.state_file_exists).toBe(true);
    expect(result.last_updated).toBe('2026-06-06T00:00:00.000Z');
    expect(result.summary).toEqual({ agents: 0, claims: 0, conflicts: 0, handoffs: 0, unresolved_conflicts: 0, stale_claims: 0 });
  });

  test('reports persisted advisory claim counts without mutating state', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a' });
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' });

    const before = fs.readFileSync(getCoordinationPaths(repo.repoRoot).stateFile, 'utf8');
    const result = getCoordinationStatus(repo.repoRoot);

    expect(result.summary).toEqual({ agents: 1, claims: 1, conflicts: 0, handoffs: 0, unresolved_conflicts: 0, stale_claims: 0 });
    expect(fs.readFileSync(getCoordinationPaths(repo.repoRoot).stateFile, 'utf8')).toBe(before);
  });

  test('includes a compact evidence summary and never dumps the full event log', () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a' });
    recordFileChangeEvidence({ repoRoot: repo.repoRoot, path: 'src/a.ts', agent_id: 'agent-a' });

    const result = getCoordinationStatus(repo.repoRoot);
    expect(result.evidence.recent_count).toBe(1);
    expect(result.evidence.warning_count).toBe(1);
    expect(result.evidence.high_count).toBe(0);
    expect(typeof result.evidence.last_event_at).toBe('string');
    // The status surface must not carry the full event log.
    expect(Object.keys(result.evidence).sort()).toEqual(
      ['high_count', 'last_event_at', 'recent_count', 'warning_count'],
    );
    expect((result as unknown as { events?: unknown }).events).toBeUndefined();
  });

  test('empty repo reports a zeroed evidence summary', () => {
    const result = getCoordinationStatus(repo.repoRoot, { now: '2026-06-06T00:00:00.000Z' });
    expect(result.evidence).toEqual({ recent_count: 0, warning_count: 0, high_count: 0, last_event_at: null });
  });
});
