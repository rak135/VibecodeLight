// tests/app/desktop/artifact_actions.test.ts
// Tests that preload exposes narrow artifact actions and renderer does not access fs directly

describe('artifact actions boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test('preload exposes artifacts with only copyToClipboard, openPath, readClipboard, and readRunArtifact', async () => {
    const ipcRenderer = { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const contextBridge = { exposeInMainWorld: vi.fn() };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(api)).toContain('artifacts');
    const artifacts = api['artifacts'] as Record<string, unknown>;
    expect(Object.keys(artifacts).sort()).toEqual(['copyToClipboard', 'openPath', 'readClipboard', 'readRunArtifact']);
  });

  test('artifacts.readClipboard invokes artifacts:readClipboard IPC channel', async () => {
    const ipcRenderer = { invoke: vi.fn().mockResolvedValue('clip text'), send: vi.fn(), on: vi.fn() };
    const contextBridge = { exposeInMainWorld: vi.fn() };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>];
    const artifacts = api['artifacts'] as Record<string, (...args: unknown[]) => unknown>;
    await artifacts.readClipboard();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('artifacts:readClipboard');
  });

  test('artifacts.copyToClipboard invokes artifacts:copyToClipboard IPC channel', async () => {
    const ipcRenderer = { invoke: vi.fn().mockResolvedValue(undefined), send: vi.fn(), on: vi.fn() };
    const contextBridge = { exposeInMainWorld: vi.fn() };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>];
    const artifacts = api['artifacts'] as Record<string, (...args: unknown[]) => unknown>;
    artifacts.copyToClipboard('hello');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('artifacts:copyToClipboard', 'hello');
  });

  test('artifacts.openPath invokes artifacts:openPath IPC channel', async () => {
    const ipcRenderer = { invoke: vi.fn().mockResolvedValue({ ok: true }), send: vi.fn(), on: vi.fn() };
    const contextBridge = { exposeInMainWorld: vi.fn() };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>];
    const artifacts = api['artifacts'] as Record<string, (...args: unknown[]) => unknown>;
    await artifacts.openPath('/some/path');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('artifacts:openPath', '/some/path');
  });

  test('renderer does not import fs or child_process directly', () => {
    const fs = require('fs');
    const path = require('path');
    const repoRoot = path.resolve(__dirname, '../../..');
    const rendererHtml = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer', 'index.html');
    const html = fs.readFileSync(rendererHtml, 'utf8');
    expect(html).not.toMatch(/require\(['"]fs['"]\)/);
    expect(html).not.toMatch(/require\(['"]child_process['"]\)/);
    expect(html).not.toMatch(/window\.require/);
  });
});
