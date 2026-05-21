import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerDesktopComposerIpcHandlers } from '../../src/app/desktop/composer_bridge.js';
import { generatePromptPreview } from '../../src/app/desktop/prompt_preview_service.js';
import { sendFinalPromptForRun, type DesktopTerminalServiceLike } from '../../src/app/desktop/prompt_send_service.js';
import { runPromptPipeline } from '../../src/core/prompting/pipeline.js';
import { sha256 } from '../../src/core/terminal/hash.js';

interface FakeTerminalService {
  active: { sessionId: string; cwd: string; pid: number; shell: string } | undefined;
  writes: string[];
  failOnWrite?: boolean;
  excerpt?: string;
  writeInput(data: string): void;
  getActiveSessionInfo(): { sessionId: string; cwd: string; pid: number; shell: string } | undefined;
  getActiveCleanExcerpt(): string | undefined;
}

function createFakeService(active: FakeTerminalService['active'], failOnWrite = false, excerpt?: string): FakeTerminalService {
  const writes: string[] = [];
  return {
    active,
    writes,
    failOnWrite,
    excerpt,
    writeInput(data: string) {
      if (this.failOnWrite) throw new Error('simulated PTY failure');
      writes.push(data);
    },
    getActiveSessionInfo() {
      return this.active;
    },
    getActiveCleanExcerpt() {
      return this.excerpt;
    },
  };
}

function createFakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
      handlers.set(channel, listener);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`missing IPC handler: ${channel}`);
      return handler({}, ...args);
    },
  };
}

describe('composer preview -> send integration flow', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-send-flow-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# send flow fixture\n', 'utf8');
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('preview then send writes send_metadata.json whose content hash equals saved final_prompt.md', async () => {
    const preview = await generatePromptPreview({ task: 'integration: send writes metadata', repoRoot: tmpRepo });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    // pre-send: no metadata yet
    expect(fs.existsSync(path.join(preview.runDir, 'terminal', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'current', 'send_metadata.json'))).toBe(false);

    const service = createFakeService({ sessionId: 'desktop-int-001', cwd: tmpRepo, pid: 1234, shell: 'pwsh' });
    const send = await sendFinalPromptForRun({
      runId: preview.run_id,
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(send.ok).toBe(true);
    if (!send.ok) return;

    // exactly the saved final_prompt.md content was written
    const onDisk = fs.readFileSync(preview.finalPromptPath, 'utf8');
    expect(service.writes).toEqual([onDisk]);
    expect(send.metadata.content_sha256).toBe(sha256(onDisk));

    // metadata + current mirror both exist
    expect(fs.existsSync(send.sendMetadataPath)).toBe(true);
    expect(fs.existsSync(send.currentSendMetadataPath)).toBe(true);

    // no after/ artifacts created by send
    expect(fs.existsSync(path.join(preview.runDir, 'after'))).toBe(false);
  });

  test('failed send (writer throws) does not create send_metadata.json or current mirror', async () => {
    const preview = await generatePromptPreview({ task: 'integration: failed send keeps state clean', repoRoot: tmpRepo });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const service = createFakeService({ sessionId: 'desktop-int-002', cwd: tmpRepo, pid: 4321, shell: 'pwsh' }, true);
    const send = await sendFinalPromptForRun({
      runId: preview.run_id,
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(send.ok).toBe(false);
    if (send.ok) return;
    expect(send.error.code).toBe('TERMINAL_WRITE_FAILED');

    expect(fs.existsSync(path.join(preview.runDir, 'terminal', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'current', 'send_metadata.json'))).toBe(false);
  });

  test('NO_ACTIVE_TERMINAL is reported when no terminal session is active', async () => {
    const preview = await generatePromptPreview({ task: 'integration: no active terminal', repoRoot: tmpRepo });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const service = createFakeService(undefined);
    const send = await sendFinalPromptForRun({
      runId: preview.run_id,
      repoRoot: tmpRepo,
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(send.ok).toBe(false);
    if (send.ok) return;
    expect(send.error.code).toBe('NO_ACTIVE_TERMINAL');
  });

  test('send with active terminal excerpt writes terminal_excerpt_after.md', async () => {
    const preview = await generatePromptPreview({ task: 'integration: gui send writes terminal excerpt', repoRoot: tmpRepo });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const service = createFakeService(
      { sessionId: 'desktop-int-003', cwd: tmpRepo, pid: 2468, shell: 'pwsh' },
      false,
      '\u001b[35mdesktop gui excerpt\u001b[0m\n',
    );
    const ipcMain = createFakeIpcMain();
    registerDesktopComposerIpcHandlers(ipcMain, {
      getRepoPath: () => tmpRepo,
      getTerminalService: () => service as DesktopTerminalServiceLike,
    });

    const send = await ipcMain.invoke('composer:sendPreview', preview.run_id) as Awaited<ReturnType<typeof sendFinalPromptForRun>>;

    expect(send.ok).toBe(true);
    const excerptPath = path.join(preview.runDir, 'terminal', 'terminal_excerpt_after.md');
    expect(fs.existsSync(excerptPath)).toBe(true);
    const excerpt = fs.readFileSync(excerptPath, 'utf8');
    expect(excerpt).toContain('desktop gui excerpt');
    expect(excerpt).not.toContain('\u001b[35m');
  });

  test('send without terminal excerpt does not write terminal_excerpt_after.md', async () => {
    const preview = await generatePromptPreview({ task: 'integration: gui send without terminal excerpt', repoRoot: tmpRepo });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const service = createFakeService({ sessionId: 'desktop-int-004', cwd: tmpRepo, pid: 2469, shell: 'pwsh' });
    const ipcMain = createFakeIpcMain();
    registerDesktopComposerIpcHandlers(ipcMain, {
      getRepoPath: () => tmpRepo,
      getTerminalService: () => service as DesktopTerminalServiceLike,
    });

    const send = await ipcMain.invoke('composer:sendPreview', preview.run_id) as Awaited<ReturnType<typeof sendFinalPromptForRun>>;

    expect(send.ok).toBe(true);
    expect(fs.existsSync(path.join(preview.runDir, 'terminal', 'terminal_excerpt_after.md'))).toBe(false);
  });

  test('include-terminal-context follow-up includes excerpt produced by desktop send', async () => {
    const preview = await generatePromptPreview({ task: 'integration: produce terminal context for follow-up', repoRoot: tmpRepo });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const knownExcerpt = 'known desktop send excerpt for follow-up\nsecond line\n';
    const service = createFakeService(
      { sessionId: 'desktop-int-005', cwd: tmpRepo, pid: 2470, shell: 'pwsh' },
      false,
      knownExcerpt,
    );
    const send = await sendFinalPromptForRun({
      runId: preview.run_id,
      repoRoot: tmpRepo,
      terminalExcerpt: service.getActiveCleanExcerpt(),
      terminalService: service as unknown as Parameters<typeof sendFinalPromptForRun>[0]['terminalService'],
    });

    expect(send.ok).toBe(true);
    const excerptPath = path.join(preview.runDir, 'terminal', 'terminal_excerpt_after.md');
    expect(fs.existsSync(excerptPath)).toBe(true);
    expect(fs.readFileSync(excerptPath, 'utf8')).toContain('known desktop send excerpt for follow-up');

    const followUp = await runPromptPipeline({
      task: 'integration: include previous terminal context',
      repoRoot: tmpRepo,
      mock: true,
      includeTerminalContext: true,
    });

    expect(followUp.ok).toBe(true);
    if (!followUp.ok) return;
    const flashInput = fs.readFileSync(path.join(followUp.runDir, 'flash', 'flash_input.md'), 'utf8');
    expect(flashInput).toContain('known desktop send excerpt for follow-up');
  });
});
