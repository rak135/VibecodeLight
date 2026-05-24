import fs from 'fs';
import os from 'os';
import path from 'path';

function makeFinalizedRun(repoRoot: string, runId: string, finalPromptContent: string): { runDir: string; finalPromptPath: string } {
  const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
  fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
  const finalPromptPath = path.join(runDir, 'output', 'final_prompt.md');
  fs.writeFileSync(finalPromptPath, finalPromptContent, 'utf8');
  return { runDir, finalPromptPath };
}

type ActiveSession = { sessionId: string; cwd: string; pid: number; shell: string };

interface FakeTerminalService {
  active: ActiveSession | undefined;
  sessions: Map<string, ActiveSession>;
  writes: Array<{ sessionId: string; data: string }>;
  failOnWrite?: boolean;
  writeInput(sessionId: string, data: string): void;
  getActiveSessionInfo(): ActiveSession | undefined;
  getSession(sessionId: string): ActiveSession | undefined;
}

function createFakeService(active: ActiveSession | undefined, failOnWrite = false): FakeTerminalService {
  const writes: Array<{ sessionId: string; data: string }> = [];
  const sessions = new Map<string, ActiveSession>();
  if (active) sessions.set(active.sessionId, active);
  return {
    active,
    sessions,
    writes,
    failOnWrite,
    writeInput(sessionId: string, data: string) {
      if (this.failOnWrite) throw new Error('simulated PTY failure');
      writes.push({ sessionId, data });
    },
    getActiveSessionInfo() {
      return this.active;
    },
    getSession(sessionId: string) {
      return this.sessions.get(sessionId);
    },
  };
}

describe('DesktopPromptSendService', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-send-svc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('fails with NO_ACTIVE_TERMINAL when there is no active session and no target', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
    const { runDir } = makeFinalizedRun(tmpRepo, 'r1', '# task\n');
    const service = createFakeService(undefined);

    const result = await sendFinalPromptForRun({
      runId: 'r1',
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NO_ACTIVE_TERMINAL');

    expect(fs.existsSync(path.join(runDir, 'terminal', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'current', 'send_metadata.json'))).toBe(false);
    expect(service.writes).toEqual([]);
  });

  test('fails with ORIGIN_TERMINAL_CLOSED when targetSessionId no longer exists', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
    makeFinalizedRun(tmpRepo, 'r-origin', '# task\n');
    // Active session exists but a different one was the composer origin.
    const service = createFakeService({ sessionId: 'live-1', cwd: tmpRepo, pid: 1, shell: 'pwsh' });

    const result = await sendFinalPromptForRun({
      runId: 'r-origin',
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
      targetSessionId: 'origin-gone',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORIGIN_TERMINAL_CLOSED');
    // The still-live unrelated session must NOT receive a stray write.
    expect(service.writes).toEqual([]);
  });

  test('fails with RUN_NOT_FOUND when the run directory is missing', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
    const service = createFakeService({ sessionId: 's1', cwd: tmpRepo, pid: 1, shell: 'pwsh' });

    const result = await sendFinalPromptForRun({
      runId: 'does-not-exist',
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RUN_NOT_FOUND');
    expect(service.writes).toEqual([]);
  });

  test('fails with FINAL_PROMPT_NOT_FOUND and does not send when final_prompt.md is missing', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
    const runDir = path.join(tmpRepo, '.vibecode', 'runs', 'r2');
    fs.mkdirSync(runDir, { recursive: true });
    const service = createFakeService({ sessionId: 's1', cwd: tmpRepo, pid: 1, shell: 'pwsh' });

    const result = await sendFinalPromptForRun({
      runId: 'r2',
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FINAL_PROMPT_NOT_FOUND');
    expect(service.writes).toEqual([]);
  });

  test('sends saved final_prompt.md content as bracketed paste plus Enter to the active terminal session and writes metadata', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
    const { BRACKETED_PASTE_START, BRACKETED_PASTE_END } = await import('../../../src/core/terminal/send_prompt.js');
    const content = '# Task\nDo X\n';
    const { runDir, finalPromptPath } = makeFinalizedRun(tmpRepo, 'r3', content);
    const service = createFakeService({ sessionId: 'desktop-77-xyz', cwd: tmpRepo, pid: 77, shell: 'pwsh' });

    const result = await sendFinalPromptForRun({
      runId: 'r3',
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(service.writes).toEqual([
      { sessionId: 'desktop-77-xyz', data: BRACKETED_PASTE_START + content + BRACKETED_PASTE_END },
      { sessionId: 'desktop-77-xyz', data: '\r' },
    ]);
    expect(result.run_id).toBe('r3');
    expect(result.sentAt).toBe(result.metadata.sent_at);
    expect(result.sendMetadataPath).toBe(path.join(runDir, 'terminal', 'send_metadata.json'));
    expect(result.currentSendMetadataPath).toBe(path.join(tmpRepo, '.vibecode', 'current', 'send_metadata.json'));

    expect(fs.existsSync(result.sendMetadataPath)).toBe(true);
    expect(fs.existsSync(result.currentSendMetadataPath)).toBe(true);

    // Saved final prompt must not be mutated
    expect(fs.readFileSync(finalPromptPath, 'utf8')).toBe(content);

    // No after/ artifacts must be created by send
    expect(fs.existsSync(path.join(runDir, 'after'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'terminal', 'terminal_excerpt_after.md'))).toBe(false);
  });

  test('targetSessionId routes the paste to the named session, not the active one', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
    const content = '# Task\n';
    makeFinalizedRun(tmpRepo, 'r-target', content);
    const liveActive: ActiveSession = { sessionId: 'live-active', cwd: tmpRepo, pid: 100, shell: 'pwsh' };
    const origin: ActiveSession = { sessionId: 'origin-tile', cwd: tmpRepo, pid: 200, shell: 'pwsh' };
    const service = createFakeService(liveActive);
    service.sessions.set(origin.sessionId, origin);

    const result = await sendFinalPromptForRun({
      runId: 'r-target',
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
      targetSessionId: origin.sessionId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(service.writes.every((w) => w.sessionId === origin.sessionId)).toBe(true);
    expect(service.writes.some((w) => w.sessionId === liveActive.sessionId)).toBe(false);
    expect(result.metadata.terminal_session_id).toBe(origin.sessionId);
  });

  test('uses the existing active terminal session and never spawns a new process', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
    const content = 'send me\n';
    makeFinalizedRun(tmpRepo, 'r4', content);

    const service = createFakeService({ sessionId: 'desktop-stable', cwd: tmpRepo, pid: 4242, shell: 'pwsh' });
    // The service is the same object before and after: send must not touch shell startup.
    const before = service.active;

    await sendFinalPromptForRun({
      runId: 'r4',
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(service.active).toBe(before);
  });

  test('Approve & Send does NOT write terminal_excerpt_after.md', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
    const content = '# Task\nDo X\n';
    const { runDir } = makeFinalizedRun(tmpRepo, 'r5', content);
    const service = createFakeService({ sessionId: 'desktop-77-xyz', cwd: tmpRepo, pid: 77, shell: 'pwsh' });

    const result = await sendFinalPromptForRun({
      runId: 'r5',
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const excerptPath = path.join(runDir, 'terminal', 'terminal_excerpt_after.md');
    expect(fs.existsSync(excerptPath)).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'after'))).toBe(false);
  });

  test('does not write terminal_excerpt_after.md when excerpt is undefined', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
    const content = '# Task\nDo X\n';
    const { runDir } = makeFinalizedRun(tmpRepo, 'r6', content);
    const service = createFakeService({ sessionId: 'desktop-77-xyz', cwd: tmpRepo, pid: 77, shell: 'pwsh' });

    await sendFinalPromptForRun({
      runId: 'r6',
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(fs.existsSync(path.join(runDir, 'terminal', 'terminal_excerpt_after.md'))).toBe(false);
  });

  test('does not write terminal_excerpt_after.md on send failure', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
    const content = '# Task\nDo X\n';
    const { runDir } = makeFinalizedRun(tmpRepo, 'r7', content);
    const service = createFakeService(
      { sessionId: 'desktop-77-xyz', cwd: tmpRepo, pid: 77, shell: 'pwsh' },
      true,
    );

    const result = await sendFinalPromptForRun({
      runId: 'r7',
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'terminal', 'terminal_excerpt_after.md'))).toBe(false);
  });

  test('does not call core/prompting/pipeline (no re-render at send time)', async () => {
    const sourcePath = path.resolve(__dirname, '../../../src/app/desktop/prompt_send_service.ts');
    const src = fs.readFileSync(sourcePath, 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*prompting\/(pipeline|renderer)/);
    expect(src).not.toMatch(/from\s+['"][^'"]*context\//);
    expect(src).not.toMatch(/from\s+['"][^'"]*adapters\/llm/);
  });
});
