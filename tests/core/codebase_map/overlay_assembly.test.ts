import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test, beforeEach, afterEach } from 'vitest';

import { assembleOverlayData } from '../../../src/core/codebase_map/overlay_assembly.js';
import type { SceneOverlayInput } from '../../../src/core/codebase_map/scene.js';

/**
 * Tests for overlay data assembly: the module that gathers read-only
 * operational data (git changes, current run context, coordination claims/
 * conflicts) and produces a SceneOverlayInput for the scene builder.
 *
 * Protected invariants:
 *   - git changed_files populated from workspace git status
 *   - current_run populated from flash_output_meta.json when available
 *   - agents populated from coordination overview claims
 *   - conflicts populated from coordination overview conflicts
 *   - missing data produces empty overlays, not a crash
 *   - no mutation of repo or .vibecode state
 */

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-overlay-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('assembleOverlayData', () => {
  test('returns empty overlays when no data sources exist', () => {
    const result = assembleOverlayData(repoRoot);
    expect(result.git).toBeUndefined();
    expect(result.current_run).toBeUndefined();
    expect(result.agents).toBeUndefined();
    expect(result.conflicts).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  test('populates git overlay from git changed files', () => {
    // Create a mock git status by providing changed_files directly
    const result = assembleOverlayData(repoRoot, {
      gitChangedFiles: [
        { path: 'src/a.ts', status: 'modified', staged: false, unstaged: true, untracked: false, index_status: ' ', worktree_status: 'M' },
        { path: 'src/b.ts', status: 'added', staged: true, unstaged: false, untracked: false, index_status: 'A', worktree_status: ' ' },
        { path: 'new_file.ts', status: 'untracked', staged: false, unstaged: false, untracked: true, index_status: '?', worktree_status: '?' },
      ],
    });

    expect(result.git).toBeDefined();
    expect(result.git!.changed_files).toContain('src/a.ts');
    expect(result.git!.changed_files).toContain('src/b.ts');
    expect(result.git!.changed_files).toContain('new_file.ts');
    expect(result.git!.dirty).toBe(true);
  });

  test('git overlay has empty changed_files when no changes', () => {
    const result = assembleOverlayData(repoRoot, {
      gitChangedFiles: [],
    });

    expect(result.git).toBeDefined();
    expect(result.git!.changed_files).toEqual([]);
    expect(result.git!.dirty).toBe(false);
  });

  test('populates current_run overlay from flash_output_meta', () => {
    const runDir = path.join(repoRoot, '.vibecode', 'runs', 'test-run');
    const flashDir = path.join(runDir, 'flash');
    fs.mkdirSync(flashDir, { recursive: true });
    fs.writeFileSync(
      path.join(flashDir, 'flash_output_meta.json'),
      JSON.stringify({
        relevant_files: ['src/index.ts', 'src/utils.ts'],
        files_to_read_with_tools: ['src/app.ts'],
        relevant_tests: ['src/utils.test.ts'],
      }),
      'utf8',
    );

    const result = assembleOverlayData(repoRoot, {
      currentRunDir: runDir,
      currentRunId: 'test-run',
    });

    expect(result.current_run).toBeDefined();
    expect(result.current_run!.run_id).toBe('test-run');
    expect(result.current_run!.selected_files).toEqual(['src/index.ts', 'src/utils.ts']);
    expect(result.current_run!.files_to_read).toEqual(['src/app.ts']);
    expect(result.current_run!.relevant_tests).toEqual(['src/utils.test.ts']);
  });

  test('current_run overlay handles missing flash_output_meta gracefully', () => {
    const runDir = path.join(repoRoot, '.vibecode', 'runs', 'test-run');
    fs.mkdirSync(runDir, { recursive: true });

    const result = assembleOverlayData(repoRoot, {
      currentRunDir: runDir,
      currentRunId: 'test-run',
    });

    expect(result.current_run).toBeDefined();
    expect(result.current_run!.run_id).toBe('test-run');
    expect(result.current_run!.selected_files).toEqual([]);
    expect(result.current_run!.files_to_read).toEqual([]);
    expect(result.current_run!.relevant_tests).toEqual([]);
  });

  test('current_run overlay handles malformed flash_output_meta gracefully', () => {
    const runDir = path.join(repoRoot, '.vibecode', 'runs', 'test-run');
    const flashDir = path.join(runDir, 'flash');
    fs.mkdirSync(flashDir, { recursive: true });
    fs.writeFileSync(
      path.join(flashDir, 'flash_output_meta.json'),
      'NOT VALID JSON{{{',
      'utf8',
    );

    const result = assembleOverlayData(repoRoot, {
      currentRunDir: runDir,
      currentRunId: 'test-run',
    });

    expect(result.current_run).toBeDefined();
    expect(result.current_run!.selected_files).toEqual([]);
  });

  test('populates agents overlay from coordination claims', () => {
    const result = assembleOverlayData(repoRoot, {
      coordinationClaims: [
        { claim_id: 'c1', path: 'src/index.ts', mode: 'exclusive', status: 'active', agent_id: 'agent-1', agent_name: 'test-agent' },
        { claim_id: 'c2', path: 'src/utils.ts', mode: 'shared', status: 'active', agent_id: 'agent-2' },
      ],
    });

    expect(result.agents).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const claims = result.agents!.claims!;
    expect(claims.length).toBe(2);
    expect(claims[0].path).toBe('src/index.ts');
    expect(claims[0].agent_id).toBe('agent-1');
    expect(claims[0].agent_name).toBe('test-agent');
    expect(claims[0].stale).toBe(false);
  });

  test('agents overlay marks stale claims correctly', () => {
    const result = assembleOverlayData(repoRoot, {
      coordinationClaims: [
        { claim_id: 'c1', path: 'src/a.ts', mode: 'exclusive', status: 'stale', agent_id: 'agent-1' },
      ],
      staleAgentIds: new Set(['agent-1']),
    });

    expect(result.agents).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const claims = result.agents!.claims!;
    expect(claims.length).toBe(1);
    expect(claims[0].stale).toBe(true);
  });

  test('populates conflicts overlay from coordination conflicts', () => {
    const result = assembleOverlayData(repoRoot, {
      coordinationConflicts: [
        { conflict_id: 'conf-1', conflict_type: 'claim_denied', severity: 'warning', status: 'detected', involved_files: ['src/index.ts'], detected_at: new Date().toISOString() },
      ],
    });

    expect(result.conflicts).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const conflicts = result.conflicts!.conflicts!;
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].id).toBe('conf-1');
    expect(conflicts[0].path).toBe('src/index.ts');
    expect(conflicts[0].status).toBe('detected');
  });

  test('conflicts overlay skips resolved conflicts', () => {
    const result = assembleOverlayData(repoRoot, {
      coordinationConflicts: [
        { conflict_id: 'conf-1', conflict_type: 'claim_denied', severity: 'warning', status: 'resolved', involved_files: ['src/a.ts'], detected_at: new Date().toISOString() },
        { conflict_id: 'conf-2', conflict_type: 'stale_claim', severity: 'info', status: 'detected', involved_files: ['src/b.ts'], detected_at: new Date().toISOString() },
      ],
    });

    expect(result.conflicts).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const conflicts = result.conflicts!.conflicts!;
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].id).toBe('conf-2');
  });

  test('all overlays populated simultaneously', () => {
    const runDir = path.join(repoRoot, '.vibecode', 'runs', 'test-run');
    const flashDir = path.join(runDir, 'flash');
    fs.mkdirSync(flashDir, { recursive: true });
    fs.writeFileSync(
      path.join(flashDir, 'flash_output_meta.json'),
      JSON.stringify({ relevant_files: ['src/index.ts'] }),
      'utf8',
    );

    const result = assembleOverlayData(repoRoot, {
      gitChangedFiles: [
        { path: 'src/utils.ts', status: 'modified', staged: false, unstaged: true, untracked: false, index_status: ' ', worktree_status: 'M' },
      ],
      currentRunDir: runDir,
      currentRunId: 'run-1',
      coordinationClaims: [
        { claim_id: 'c1', path: 'src/app.ts', mode: 'exclusive', status: 'active', agent_id: 'a1' },
      ],
      coordinationConflicts: [
        { conflict_id: 'cf1', conflict_type: 'claim_denied', severity: 'warning', status: 'detected', involved_files: ['src/app.ts'], detected_at: new Date().toISOString() },
      ],
    });

    expect(result.git).toBeDefined();
    expect(result.current_run).toBeDefined();
    expect(result.agents).toBeDefined();
    expect(result.conflicts).toBeDefined();
  });

  test('missing coordination data produces empty agents/conflicts overlays', () => {
    const result = assembleOverlayData(repoRoot, {
      coordinationClaims: [],
      coordinationConflicts: [],
    });

    expect(result.agents).toBeDefined();
    expect(result.agents!.claims).toEqual([]);
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts!.conflicts).toEqual([]);
  });
});
