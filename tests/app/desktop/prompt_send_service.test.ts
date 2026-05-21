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

interface FakeTerminalService {
  active: { sessionId: string; cwd: string; pid: number; shell: string } | undefined;
  writes: string[];
  writeInput(data: string): void;
  getActiveSessionInfo(): { sessionId: string; cwd: string; pid: number; shell: string } | undefined;
}

function createFakeService(active: FakeTerminalService['active']): FakeTerminalService {
  const writes: string[] = [];
  return {
    active,
    writes,
    writeInput(data: string) {
      writes.push(data);
    },
    getActiveSessionInfo() {
      return this.active;
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

  test('fails with NO_ACTIVE_TERMINAL when there is no active session', async () => {
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

  test('sends saved final_prompt.md content to the active terminal session and writes metadata', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
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

    expect(service.writes).toEqual([content]);
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

  test('sends terminal_excerpt_after.md when terminalExcerpt is provided', async () => {
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');
    const content = '# Task\nDo X\n';
    const { runDir } = makeFinalizedRun(tmpRepo, 'r5', content);
    const service = createFakeService({ sessionId: 'desktop-77-xyz', cwd: tmpRepo, pid: 77, shell: 'pwsh' });

    const result = await sendFinalPromptForRun({
      runId: 'r5',
      repoRoot: tmpRepo,
      terminalExcerpt: 'some terminal output\n',
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const excerptPath = path.join(runDir, 'terminal', 'terminal_excerpt_after.md');
    expect(fs.existsSync(excerptPath)).toBe(true);
    const content2 = fs.readFileSync(excerptPath, 'utf8');
    expect(content2).toContain('some terminal output');
  });

  test('does not write terminal_excerpt_after.md when terminalExcerpt is absent', async () => {
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

  test('does not call core/prompting/pipeline (no re-render at send time)', async () => {
    const sourcePath = path.resolve(__dirname, '../../../src/app/desktop/prompt_send_service.ts');
    const src = fs.readFileSync(sourcePath, 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*prompting\/(pipeline|renderer)/);
    expect(src).not.toMatch(/from\s+['"][^'"]*context\//);
    expect(src).not.toMatch(/from\s+['"][^'"]*adapters\/llm/);
  });
});
