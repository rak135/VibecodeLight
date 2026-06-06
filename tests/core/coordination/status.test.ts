import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { initializeCoordinationState, getCoordinationPaths } from '../../../src/core/coordination/state.js';
import { getCoordinationStatus } from '../../../src/core/coordination/status.js';

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
    expect(result.summary).toEqual({ agents: 0, claims: 0, conflicts: 0, handoffs: 0 });
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
    expect(result.summary).toEqual({ agents: 0, claims: 0, conflicts: 0, handoffs: 0 });
  });
});
