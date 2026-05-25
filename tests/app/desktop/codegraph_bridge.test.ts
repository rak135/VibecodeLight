/**
 * Tests for CodeGraph IPC bridge (Phase 1.6).
 *
 * Verifies that:
 * - codegraph:status, codegraph:init, codegraph:sync, codegraph:reindex are
 *   registered as IPC handlers.
 * - Each handler delegates to the action service with the workspace repoRoot.
 * - Handler never spawns a real process (all calls use injected service stubs).
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';

import type {
  CodeGraphActionResult,
  CodeGraphStatusResult,
} from '../../../src/adapters/codegraph/codegraph_actions.js';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

type IpcMainHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function makeIpcMain() {
  const handlers: Record<string, IpcMainHandler> = {};
  return {
    handle: vi.fn((channel: string, handler: IpcMainHandler) => {
      handlers[channel] = handler;
    }),
    handlers,
  };
}

const REPO_ROOT = '/workspace/myrepo';

function stubWorkspace() {
  return {
    getRepoRoot: vi.fn().mockResolvedValue(REPO_ROOT),
  };
}

function stubActionService(
  overrides: {
    status?: Partial<CodeGraphStatusResult>;
    init?: Partial<CodeGraphActionResult>;
    sync?: Partial<CodeGraphActionResult>;
    reindex?: Partial<CodeGraphActionResult>;
  } = {},
) {
  return {
    getCodeGraphStatus: vi.fn().mockResolvedValue({
      ok: true, available: true, initialized: true, version: '0.9.4', warnings: [],
      ...overrides.status,
    }),
    initializeCodeGraphRepo: vi.fn().mockResolvedValue({
      ok: true, stdoutSummary: '', stderrSummary: '',
      ...overrides.init,
    }),
    syncCodeGraphRepo: vi.fn().mockResolvedValue({
      ok: true, stdoutSummary: '', stderrSummary: '',
      ...overrides.sync,
    }),
    reindexCodeGraphRepo: vi.fn().mockResolvedValue({
      ok: true, stdoutSummary: '', stderrSummary: '',
      ...overrides.reindex,
    }),
  };
}

// ---------------------------------------------------------------------------
// Import the bridge factory (lazy, to allow injection)
// ---------------------------------------------------------------------------

import { registerCodeGraphBridge } from '../../../src/app/desktop/codegraph_bridge.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerCodeGraphBridge', () => {
  test('registers codegraph:status IPC channel', () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService();
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);
    expect(Object.keys(ipcMain.handlers)).toContain('codegraph:status');
  });

  test('registers codegraph:init IPC channel', () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService();
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);
    expect(Object.keys(ipcMain.handlers)).toContain('codegraph:init');
  });

  test('registers codegraph:sync IPC channel', () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService();
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);
    expect(Object.keys(ipcMain.handlers)).toContain('codegraph:sync');
  });

  test('registers codegraph:reindex IPC channel', () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService();
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);
    expect(Object.keys(ipcMain.handlers)).toContain('codegraph:reindex');
  });
});

describe('codegraph:status handler', () => {
  test('calls getCodeGraphStatus with workspace repoRoot', async () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService();
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);

    await ipcMain.handlers['codegraph:status']({}, );
    expect(service.getCodeGraphStatus).toHaveBeenCalledWith(REPO_ROOT);
  });

  test('returns ok=true with status fields', async () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService();
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);

    const result = await ipcMain.handlers['codegraph:status']({});
    expect(result).toMatchObject({ ok: true, available: true, initialized: true });
  });

  test('returns ok=false with error when workspace repoRoot unavailable', async () => {
    const ipcMain = makeIpcMain();
    const workspace = { getRepoRoot: vi.fn().mockRejectedValue(new Error('workspace not found')) };
    const service = stubActionService();
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);

    const result = (await ipcMain.handlers['codegraph:status']({})) as CodeGraphStatusResult;
    expect(result.ok).toBe(false);
  });
});

describe('codegraph:init handler', () => {
  test('calls initializeCodeGraphRepo with workspace repoRoot', async () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService();
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);

    await ipcMain.handlers['codegraph:init']({});
    expect(service.initializeCodeGraphRepo).toHaveBeenCalledWith(REPO_ROOT);
  });

  test('returns ok=true on success', async () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService();
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);

    const result = await ipcMain.handlers['codegraph:init']({});
    expect(result).toMatchObject({ ok: true });
  });

  test('returns ok=false on command failure', async () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService({ init: { ok: false, error: { message: 'init failed' } } });
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);

    const result = (await ipcMain.handlers['codegraph:init']({})) as CodeGraphActionResult;
    expect(result.ok).toBe(false);
  });
});

describe('codegraph:sync handler', () => {
  test('calls syncCodeGraphRepo with workspace repoRoot', async () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService();
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);

    await ipcMain.handlers['codegraph:sync']({});
    expect(service.syncCodeGraphRepo).toHaveBeenCalledWith(REPO_ROOT);
  });

  test('returns ok=false on command failure', async () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService({ sync: { ok: false, error: { message: 'sync failed' } } });
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);

    const result = (await ipcMain.handlers['codegraph:sync']({})) as CodeGraphActionResult;
    expect(result.ok).toBe(false);
  });
});

describe('codegraph:reindex handler', () => {
  test('calls reindexCodeGraphRepo with workspace repoRoot', async () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService();
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);

    await ipcMain.handlers['codegraph:reindex']({});
    expect(service.reindexCodeGraphRepo).toHaveBeenCalledWith(REPO_ROOT);
  });

  test('returns ok=false on command failure', async () => {
    const ipcMain = makeIpcMain();
    const workspace = stubWorkspace();
    const service = stubActionService({ reindex: { ok: false, error: { message: 'reindex failed' } } });
    registerCodeGraphBridge(ipcMain as never, workspace as never, service as never);

    const result = (await ipcMain.handlers['codegraph:reindex']({})) as CodeGraphActionResult;
    expect(result.ok).toBe(false);
  });
});

describe('anti-scope: bridge does not expose MCP or context enrichment channels', () => {
  test('does not register mcp: channels', () => {
    const ipcMain = makeIpcMain();
    registerCodeGraphBridge(ipcMain as never, stubWorkspace() as never, stubActionService() as never);
    expect(Object.keys(ipcMain.handlers).some((k) => k.startsWith('mcp:'))).toBe(false);
  });

  test('does not register context:enrich channels', () => {
    const ipcMain = makeIpcMain();
    registerCodeGraphBridge(ipcMain as never, stubWorkspace() as never, stubActionService() as never);
    expect(Object.keys(ipcMain.handlers).some((k) => k.startsWith('context:'))).toBe(false);
  });
});
