import fs from 'fs';
import os from 'os';
import path from 'path';

interface CapturedIpc {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  invoke(channel: string, ...args: unknown[]): unknown;
}

function createFakeIpc(): CapturedIpc {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler registered for ${channel}`);
      return handler({}, ...args);
    },
  };
}

describe('desktop preload artifact read API', () => {
  let repoRoot: string;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-artifact-read-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('artifacts.readRunArtifact returns content for allowed paths', async () => {
    const runId = '2026-05-24_001';
    const artifactPath = path.join(repoRoot, '.vibecode', 'runs', runId, 'output', 'final_prompt.md');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, '# final prompt\n', 'utf8');

    const { registerDesktopArtifactIpcHandlers } = await import('../../../src/app/desktop/artifact_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopArtifactIpcHandlers(ipc, { getRepoPath: () => repoRoot });

    const result = (await ipc.invoke('artifacts:readRunArtifact', runId, 'output/final_prompt.md')) as {
      ok: boolean;
      content?: string;
      error?: string;
    };

    expect(result).toEqual({ ok: true, content: '# final prompt\n' });
  });

  test('artifacts.readRunArtifact rejects disallowed paths with error', async () => {
    const runId = '2026-05-24_001';
    const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });

    const { registerDesktopArtifactIpcHandlers } = await import('../../../src/app/desktop/artifact_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopArtifactIpcHandlers(ipc, { getRepoPath: () => repoRoot });

    const result = (await ipc.invoke('artifacts:readRunArtifact', runId, '../secrets.env')) as {
      ok: boolean;
      error?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not allowed|allow/i);
  });

  test('artifacts.readRunArtifact returns error for missing file gracefully', async () => {
    const runId = '2026-05-24_001';
    const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });

    const { registerDesktopArtifactIpcHandlers } = await import('../../../src/app/desktop/artifact_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopArtifactIpcHandlers(ipc, { getRepoPath: () => repoRoot });

    const result = (await ipc.invoke('artifacts:readRunArtifact', runId, 'flash/flash_output.md')) as {
      ok: boolean;
      error?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found|no such file/i);
  });

  test('preload exposes readRunArtifact through artifacts IPC namespace', async () => {
    const ipcRenderer = { invoke: vi.fn().mockResolvedValue({ ok: true, content: 'ok' }), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const contextBridge = { exposeInMainWorld: vi.fn() };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>];
    const artifacts = api['artifacts'] as Record<string, (...args: unknown[]) => unknown>;
    await artifacts.readRunArtifact('run-1', 'flash/flash_output.md');

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('artifacts:readRunArtifact', 'run-1', 'flash/flash_output.md');
  });
});
