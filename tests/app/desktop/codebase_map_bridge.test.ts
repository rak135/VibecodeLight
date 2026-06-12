import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test, beforeEach, afterEach } from 'vitest';

import { registerDesktopCodebaseMapIpcHandlers } from '../../../src/app/desktop/codebase_map_bridge.js';
import type { SceneOverlayInput } from '../../../src/core/codebase_map/scene.js';

interface Handler {
  (event: unknown, ...args: unknown[]): unknown;
}

class FakeIpcMain {
  handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler) {
    this.handlers.set(channel, listener);
  }
  invoke(channel: string, ...args: unknown[]) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  }
}

describe('desktop codebase map bridge', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cmap-bridge-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function register(assembleOverlay?: (repoRoot: string, runDir?: string, runId?: string) => SceneOverlayInput) {
    const ipc = new FakeIpcMain();
    registerDesktopCodebaseMapIpcHandlers(ipc, { getRepoPath: () => repoRoot, assembleOverlay });
    return ipc;
  }

  function setupScanArtifacts(runId = 'test-run') {
    const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
    const scanDir = path.join(runDir, 'scan');
    fs.mkdirSync(scanDir, { recursive: true });

    fs.writeFileSync(
      path.join(runDir, 'run_manifest.json'),
      JSON.stringify({ run_id: runId, created_at: new Date().toISOString() }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(scanDir, 'file_inventory.json'),
      JSON.stringify([
        { path: 'src/a.ts', extension: '.ts', kind: 'source', bytes: 100, lines: 10 },
        { path: 'README.md', extension: '.md', kind: 'doc', is_doc: true, bytes: 200, lines: 20 },
      ]),
      'utf8',
    );
    fs.writeFileSync(
      path.join(scanDir, 'imports.json'),
      JSON.stringify({ imports: [], warnings: [] }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(scanDir, 'entrypoints.json'),
      JSON.stringify({ entrypoints: [], warnings: [] }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(scanDir, 'tests.json'),
      JSON.stringify({ tests: [], test_configs: [], warnings: [] }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(scanDir, 'git_status.json'),
      JSON.stringify({ git_available: false }),
      'utf8',
    );

    // Write current pointer
    const currentDir = path.join(repoRoot, '.vibecode', 'current');
    fs.mkdirSync(currentDir, { recursive: true });
    fs.writeFileSync(
      path.join(currentDir, 'run_manifest.json'),
      JSON.stringify({ run_id: runId }),
      'utf8',
    );

    return runDir;
  }

  test('codebaseMap:getOverview returns ok with fallback when no scan exists', async () => {
    const ipc = register();
    const result = (await ipc.invoke('codebaseMap:getOverview')) as {
      ok: boolean;
      repo_root: string;
      source: { kind: string };
      nodes: unknown[];
      edges: unknown[];
      warnings: string[];
    };

    expect(result.ok).toBe(true);
    expect(result.repo_root).toBe(repoRoot);
    expect(result.source.kind).toBe('fallback');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('codebaseMap:getOverview returns fallback when repo path is empty', async () => {
    const ipc = new FakeIpcMain();
    registerDesktopCodebaseMapIpcHandlers(ipc, { getRepoPath: () => '' });
    const result = (await ipc.invoke('codebaseMap:getOverview')) as {
      ok: boolean;
      repo_root: string;
      warnings: string[];
    };

    expect(result.ok).toBe(true);
    expect(result.repo_root).toBe('');
    expect(result.warnings.some((w) => w.includes('No repository root'))).toBe(true);
  });

  test('codebaseMap:getOverview returns nodes when scan artifacts exist', async () => {
    setupScanArtifacts();

    const ipc = register();
    const result = (await ipc.invoke('codebaseMap:getOverview')) as {
      ok: boolean;
      nodes: Array<{ path: string; kind: string }>;
      summary: { total_nodes: number };
    };

    expect(result.ok).toBe(true);
    expect(result.nodes.length).toBe(2);
    expect(result.summary.total_nodes).toBe(2);
  });

  test('bridge returns overlays in response', async () => {
    setupScanArtifacts();

    const fakeOverlay: SceneOverlayInput = {
      git: { changed_files: ['src/a.ts'], dirty: true },
    };
    const ipc = register(() => fakeOverlay);
    const result = (await ipc.invoke('codebaseMap:getOverview')) as {
      ok: boolean;
      overlays: { git?: { changed_files: string[] } };
    };

    expect(result.ok).toBe(true);
    expect(result.overlays).toBeDefined();
    expect(result.overlays.git).toBeDefined();
    expect(result.overlays.git!.changed_files).toContain('src/a.ts');
  });

  test('bridge marks nodes with overlay status flags', async () => {
    setupScanArtifacts();

    const fakeOverlay: SceneOverlayInput = {
      git: { changed_files: ['src/a.ts'], dirty: true },
      agents: { claims: [{ path: 'README.md', agent_id: 'a1', agent_name: 'test-agent' }] },
    };
    const ipc = register(() => fakeOverlay);
    const result = (await ipc.invoke('codebaseMap:getOverview')) as {
      ok: boolean;
      nodes: Array<{ path: string; changed?: boolean; claimed?: boolean; conflicted?: boolean }>;
    };

    const nodeA = result.nodes.find((n) => n.path === 'src/a.ts');
    expect(nodeA).toBeDefined();
    expect(nodeA!.changed).toBe(true);
    expect(nodeA!.claimed).toBeUndefined();

    const readme = result.nodes.find((n) => n.path === 'README.md');
    expect(readme).toBeDefined();
    expect(readme!.claimed).toBe(true);
    expect(readme!.changed).toBeUndefined();
  });

  test('bridge returns current_run overlay', async () => {
    setupScanArtifacts();

    const fakeOverlay: SceneOverlayInput = {
      current_run: {
        run_id: 'test-run',
        selected_files: ['src/a.ts'],
        files_to_read: ['README.md'],
        relevant_tests: [],
      },
    };
    const ipc = register(() => fakeOverlay);
    const result = (await ipc.invoke('codebaseMap:getOverview')) as {
      ok: boolean;
      overlays: { current_run?: { run_id: string; selected_files: string[] } };
    };

    expect(result.overlays.current_run).toBeDefined();
    expect(result.overlays.current_run!.run_id).toBe('test-run');
    expect(result.overlays.current_run!.selected_files).toEqual(['src/a.ts']);
  });

  test('bridge returns conflicts overlay', async () => {
    setupScanArtifacts();

    const fakeOverlay: SceneOverlayInput = {
      conflicts: {
        conflicts: [{ id: 'c1', path: 'src/a.ts', status: 'detected' }],
      },
    };
    const ipc = register(() => fakeOverlay);
    const result = (await ipc.invoke('codebaseMap:getOverview')) as {
      ok: boolean;
      overlays: { conflicts?: { conflicts: Array<{ id: string }> } };
      nodes: Array<{ path: string; conflicted?: boolean }>;
    };

    expect(result.overlays.conflicts).toBeDefined();
    expect(result.overlays.conflicts!.conflicts.length).toBe(1);

    const nodeA = result.nodes.find((n) => n.path === 'src/a.ts');
    expect(nodeA!.conflicted).toBe(true);
  });

  test('bridge returns empty overlays when assembler returns empty', async () => {
    setupScanArtifacts();

    const ipc = register(() => ({}));
    const result = (await ipc.invoke('codebaseMap:getOverview')) as {
      ok: boolean;
      overlays: Record<string, unknown>;
    };

    expect(result.ok).toBe(true);
    expect(result.overlays).toBeDefined();
    expect(result.overlays.git).toBeUndefined();
    expect(result.overlays.current_run).toBeUndefined();
    expect(result.overlays.agents).toBeUndefined();
    expect(result.overlays.conflicts).toBeUndefined();
  });

  test('bridge remains read-only: no mutation IPC channels added', () => {
    const ipc = new FakeIpcMain();
    registerDesktopCodebaseMapIpcHandlers(ipc, { getRepoPath: () => repoRoot });

    const channels = Array.from(ipc.handlers.keys());
    expect(channels).toEqual(['codebaseMap:getOverview']);
    // No claim, release, resolve, or mutation channels
    for (const ch of channels) {
      expect(ch).not.toMatch(/claim|release|resolve|mutation|create|delete/i);
    }
  });
});
