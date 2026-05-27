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

function writeRun(
  runsDir: string,
  runId: string,
  opts: { withFinalPrompt: boolean; createdAt: string; task: string },
): void {
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    `${JSON.stringify({ run_id: runId, task: opts.task, repo_root: 'x', created_at: opts.createdAt }, null, 2)}\n`,
    'utf8',
  );
  if (opts.withFinalPrompt) {
    fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'output', 'final_prompt.md'), '# final', 'utf8');
  }
}

describe('desktop runs bridge', () => {
  let repoRoot: string;

  beforeEach(() => {
    vi.resetModules();
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-runs-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('runs:list returns historical runs sorted newest first', async () => {
    const runsDir = path.join(repoRoot, '.vibecode', 'runs');
    writeRun(runsDir, '2026-05-20_001', { withFinalPrompt: true, createdAt: '2026-05-20T10:00:00.000Z', task: 'first' });
    writeRun(runsDir, '2026-05-21_001', { withFinalPrompt: false, createdAt: '2026-05-21T10:00:00.000Z', task: 'second' });

    const { registerDesktopRunsIpcHandlers } = await import('../../../src/app/desktop/runs_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopRunsIpcHandlers(ipc, { getRepoPath: () => repoRoot });

    const result = (await ipc.invoke('runs:list')) as {
      ok: boolean;
      runs: Array<{ run_id: string; has_final_prompt: boolean }>;
    };
    expect(result.ok).toBe(true);
    expect(result.runs.map((r) => r.run_id)).toEqual(['2026-05-21_001', '2026-05-20_001']);
    expect(result.runs[1].has_final_prompt).toBe(true);
  });

  test('runs:list returns an empty list when no runs exist', async () => {
    const { registerDesktopRunsIpcHandlers } = await import('../../../src/app/desktop/runs_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopRunsIpcHandlers(ipc, { getRepoPath: () => repoRoot });

    const result = (await ipc.invoke('runs:list')) as { ok: boolean; runs: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.runs).toEqual([]);
  });

  test('runs:show returns real artifacts for an existing run', async () => {
    const runsDir = path.join(repoRoot, '.vibecode', 'runs');
    writeRun(runsDir, '2026-05-20_001', { withFinalPrompt: true, createdAt: '2026-05-20T10:00:00.000Z', task: 'demo task' });

    const { registerDesktopRunsIpcHandlers } = await import('../../../src/app/desktop/runs_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopRunsIpcHandlers(ipc, { getRepoPath: () => repoRoot });

    const result = (await ipc.invoke('runs:show', '2026-05-20_001')) as {
      ok: boolean;
      run?: { run_id: string; task: string; artifacts: { final_prompt?: string } };
    };
    expect(result.ok).toBe(true);
    expect(result.run?.run_id).toBe('2026-05-20_001');
    expect(result.run?.task).toBe('demo task');
    expect(result.run?.artifacts.final_prompt).toBeDefined();
  });

  test('runs:show surfaces the core-derived CodeGraph status (renderer does not parse it)', async () => {
    const runsDir = path.join(repoRoot, '.vibecode', 'runs');
    writeRun(runsDir, '2026-05-25_001', { withFinalPrompt: true, createdAt: '2026-05-25T10:00:00.000Z', task: 'cg task' });
    const scanDir = path.join(runsDir, '2026-05-25_001', 'scan');
    fs.mkdirSync(scanDir, { recursive: true });
    fs.writeFileSync(
      path.join(scanDir, 'external_tools.json'),
      `${JSON.stringify({ tools: { codegraph: { available: true, initialized: true, mode: 'detect-only', warnings: [] } } })}\n`,
      'utf8',
    );

    const { registerDesktopRunsIpcHandlers } = await import('../../../src/app/desktop/runs_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopRunsIpcHandlers(ipc, { getRepoPath: () => repoRoot });

    const result = (await ipc.invoke('runs:show', '2026-05-25_001')) as {
      ok: boolean;
      run?: { codegraph?: { state: string; label: string; mode: string | null; usageNote: string; usedForContext?: boolean } };
    };
    expect(result.ok).toBe(true);
    expect(result.run?.codegraph?.state).toBe('ready');
    expect(result.run?.codegraph?.label).toBe('CodeGraph: ready');
    expect(result.run?.codegraph?.mode).toBe('detect-only');
    expect(result.run?.codegraph?.usageNote.toLowerCase()).toContain('detect-only');
    expect(result.run?.codegraph?.usedForContext).toBe(false);
  });

  test('runs:show returns a neutral unknown CodeGraph status when no scan artifact exists', async () => {
    const runsDir = path.join(repoRoot, '.vibecode', 'runs');
    writeRun(runsDir, '2026-05-25_002', { withFinalPrompt: false, createdAt: '2026-05-25T10:00:00.000Z', task: 'no scan' });

    const { registerDesktopRunsIpcHandlers } = await import('../../../src/app/desktop/runs_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopRunsIpcHandlers(ipc, { getRepoPath: () => repoRoot });

    const result = (await ipc.invoke('runs:show', '2026-05-25_002')) as {
      ok: boolean;
      run?: { codegraph?: { state: string } };
    };
    expect(result.ok).toBe(true);
    expect(result.run?.codegraph?.state).toBe('unknown');
  });

  test('runs:show returns RUN_NOT_FOUND for a missing run', async () => {
    const { registerDesktopRunsIpcHandlers } = await import('../../../src/app/desktop/runs_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopRunsIpcHandlers(ipc, { getRepoPath: () => repoRoot });

    const result = (await ipc.invoke('runs:show', 'does-not-exist')) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('RUN_NOT_FOUND');
  });

  test('runs:show requires a run id', async () => {
    const { registerDesktopRunsIpcHandlers } = await import('../../../src/app/desktop/runs_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopRunsIpcHandlers(ipc, { getRepoPath: () => repoRoot });

    const result = (await ipc.invoke('runs:show', '')) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('RUN_ID_REQUIRED');
  });
});
