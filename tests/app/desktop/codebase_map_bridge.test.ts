import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerDesktopCodebaseMapIpcHandlers } from '../../../src/app/desktop/codebase_map_bridge.js';

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

  function register() {
    const ipc = new FakeIpcMain();
    registerDesktopCodebaseMapIpcHandlers(ipc, { getRepoPath: () => repoRoot });
    return ipc;
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
    // Set up scan artifacts
    const runDir = path.join(repoRoot, '.vibecode', 'runs', 'test-run');
    const scanDir = path.join(runDir, 'scan');
    fs.mkdirSync(scanDir, { recursive: true });

    fs.writeFileSync(
      path.join(runDir, 'run_manifest.json'),
      JSON.stringify({ run_id: 'test-run', created_at: new Date().toISOString() }),
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
      JSON.stringify({ run_id: 'test-run' }),
      'utf8',
    );

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
});
