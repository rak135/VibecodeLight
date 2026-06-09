import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  COORDINATION_STATE_VERSION,
  createEmptyCoordinationState,
  getCoordinationPaths,
  initializeCoordinationState,
  loadCoordinationState,
} from '../../../src/core/coordination/state.js';

/**
 * Phase 1 coordination state: read-only by default. Advisory model only —
 * no filesystem locks, no source-file mutation. All generated state lives
 * under .vibecode/coordination/.
 */

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

/** Recursively list every file path relative to a root (sorted, posix sep). */
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

describe('coordination state paths', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-coord-paths-');
  });
  afterEach(() => repo.cleanup());

  test('state lives under .vibecode/coordination/state.json', () => {
    const paths = getCoordinationPaths(repo.repoRoot);
    expect(paths.dir).toBe(path.join(repo.repoRoot, '.vibecode', 'coordination'));
    expect(paths.stateFile).toBe(path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json'));
    // Generated state must never escape the .vibecode/ generated tree.
    const rel = path.relative(path.join(repo.repoRoot, '.vibecode'), paths.stateFile);
    expect(rel.startsWith('..')).toBe(false);
  });
});

describe('createEmptyCoordinationState', () => {
  test('produces the minimal default empty state', () => {
    const state = createEmptyCoordinationState('/repo/root', '2026-06-06T00:00:00.000Z');
    expect(state).toEqual({
      version: COORDINATION_STATE_VERSION,
      workspace_root: '/repo/root',
      last_updated: '2026-06-06T00:00:00.000Z',
      agents: [],
      claims: [],
      conflicts: [],
      handoffs: [],
      intents: [],
    });
    expect(COORDINATION_STATE_VERSION).toBe(1);
  });
});

describe('loadCoordinationState (read-only)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-coord-load-');
  });
  afterEach(() => repo.cleanup());

  test('missing state file returns a stable empty state without writing anything', () => {
    // Seed a representative source file so we can prove it is untouched.
    fs.mkdirSync(path.join(repo.repoRoot, 'src'), { recursive: true });
    const sourcePath = path.join(repo.repoRoot, 'src', 'example.ts');
    fs.writeFileSync(sourcePath, 'export const x = 1;\n', 'utf8');
    const before = listFiles(repo.repoRoot);

    const state = loadCoordinationState(repo.repoRoot, { now: '2026-06-06T00:00:00.000Z' });

    expect(state.version).toBe(COORDINATION_STATE_VERSION);
    expect(state.workspace_root).toBe(repo.repoRoot);
    expect(state.agents).toEqual([]);
    expect(state.claims).toEqual([]);
    expect(state.conflicts).toEqual([]);
    expect(state.handoffs).toEqual([]);

    // Read-only: no files created, no source files modified.
    expect(listFiles(repo.repoRoot)).toEqual(before);
    expect(fs.existsSync(getCoordinationPaths(repo.repoRoot).stateFile)).toBe(false);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe('export const x = 1;\n');
    // No lock files are ever created — claims are advisory only.
    expect(listFiles(repo.repoRoot).some((p) => p.endsWith('.lock'))).toBe(false);
  });

  test('loads a previously written empty state from disk', () => {
    const { state } = initializeCoordinationState(repo.repoRoot, { now: '2026-06-06T00:00:00.000Z' });
    const loaded = loadCoordinationState(repo.repoRoot);
    expect(loaded).toEqual(state);
  });
});

describe('initializeCoordinationState', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-coord-init-');
  });
  afterEach(() => repo.cleanup());

  test('writes only .vibecode/coordination/state.json and leaves source untouched', () => {
    fs.mkdirSync(path.join(repo.repoRoot, 'src'), { recursive: true });
    const sourcePath = path.join(repo.repoRoot, 'src', 'example.ts');
    fs.writeFileSync(sourcePath, 'export const x = 1;\n', 'utf8');

    const result = initializeCoordinationState(repo.repoRoot, { now: '2026-06-06T00:00:00.000Z' });

    expect(result.created).toBe(true);
    expect(result.stateFile).toBe(getCoordinationPaths(repo.repoRoot).stateFile);
    expect(fs.existsSync(result.stateFile)).toBe(true);

    // Source file is untouched.
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe('export const x = 1;\n');

    // The only new files are under .vibecode/coordination/.
    const files = listFiles(repo.repoRoot);
    const newFiles = files.filter((p) => p !== 'src/example.ts');
    for (const p of newFiles) {
      expect(p.startsWith('.vibecode/coordination/')).toBe(true);
    }
    expect(newFiles).toEqual(['.vibecode/coordination/state.json']);
    // Still no lock files.
    expect(files.some((p) => p.endsWith('.lock'))).toBe(false);
  });

  test('is idempotent: a second call does not recreate an existing state file', () => {
    const first = initializeCoordinationState(repo.repoRoot, { now: '2026-06-06T00:00:00.000Z' });
    expect(first.created).toBe(true);
    const second = initializeCoordinationState(repo.repoRoot, { now: '2026-06-07T00:00:00.000Z' });
    expect(second.created).toBe(false);
    // Existing state is preserved (timestamp from the first write).
    expect(second.state.last_updated).toBe('2026-06-06T00:00:00.000Z');
  });
});
