import fs from 'fs';
import os from 'os';
import path from 'path';

import { runPromptCommand, type PromptSendTerminal } from '../../../src/app/cli/index.js';
import { BRACKETED_PASTE_START, BRACKETED_PASTE_END } from '../../../src/core/terminal/send_prompt.js';

function makeRepo(prefix = 'vibecode-cli-auto-approve-'): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'fixture.ts'), 'export const fixture = true;\n', 'utf8');
  return repoRoot;
}

function makeWriter() {
  let text = '';
  return {
    writer: { write: (chunk: string) => { text += chunk; return true; } },
    get text() { return text; },
  };
}

function makeFakeTerminal(repoRoot: string): { terminal: PromptSendTerminal; writes: string[]; closed: () => boolean } {
  const writes: string[] = [];
  let closedFlag = false;
  return {
    writes,
    closed: () => closedFlag,
    terminal: {
      writer: {
        sessionId: 'cli-auto-approve-test',
        cwd: repoRoot,
        write: (data: string) => { writes.push(data); },
      },
      close: () => { closedFlag = true; },
    },
  };
}

describe('prompt --auto-approve CLI behavior', () => {
  test('sends final_prompt.md and records auto_approve=true in send_metadata.json', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    const fake = makeFakeTerminal(repoRoot);
    try {
      const result = await runPromptCommand({
        task: 'cli auto approve sends prompt',
        repoRoot,
        mock: true,
        live: false,
        json: true,
        autoApprove: true,
        sendTerminal: fake.terminal,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The exact saved final_prompt.md is what was pasted (bracketed + Enter).
      const finalPrompt = fs.readFileSync(result.finalPromptPath, 'utf8');
      const pasteWrites = fake.writes.slice(0, -1);
      expect(fake.writes.at(-1)).toBe('\r');
      expect(pasteWrites.join('')).toBe(BRACKETED_PASTE_START + finalPrompt + BRACKETED_PASTE_END);
      expect(fake.closed()).toBe(true);

      // send_metadata.json is written with auto_approve = true.
      const metaPath = path.join(repoRoot, '.vibecode', 'runs', result.run_id, 'terminal', 'send_metadata.json');
      expect(fs.existsSync(metaPath)).toBe(true);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      expect(meta.auto_approve).toBe(true);

      // Current mirror is written only after a successful send.
      expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'current', 'send_metadata.json'))).toBe(true);

      // JSON envelope reports the auto-approved send.
      const envelope = JSON.parse(stdout.text.trim());
      expect(envelope.ok).toBe(true);
      expect(envelope.data.auto_approve).toBe(true);
      expect(envelope.data.send.ok).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('without --auto-approve, no terminal send happens and no send_metadata.json is written', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    const fake = makeFakeTerminal(repoRoot);
    try {
      const result = await runPromptCommand({
        task: 'cli without auto approve does not send',
        repoRoot,
        mock: true,
        live: false,
        json: false,
        sendTerminal: fake.terminal,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(fake.writes).toEqual([]);
      const metaPath = path.join(repoRoot, '.vibecode', 'runs', result.run_id, 'terminal', 'send_metadata.json');
      expect(fs.existsSync(metaPath)).toBe(false);
      expect(stdout.text).toContain('no terminal send');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('desktop.auto_approve.enabled=true does not make CLI prompt auto-approve without flag', async () => {
    const repoRoot = makeRepo();
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-auto-approve-appdata-'));
    const stdout = makeWriter();
    const stderr = makeWriter();
    const fake = makeFakeTerminal(repoRoot);
    const prevLocalAppData = process.env.LOCALAPPDATA;
    try {
      process.env.LOCALAPPDATA = appData;
      const configDir = path.join(appData, 'vibecodelight');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.yaml'), [
        'version: 1',
        'desktop:',
        '  auto_approve:',
        '    enabled: true',
        '',
      ].join('\n'), 'utf8');

      const result = await runPromptCommand({
        task: 'desktop auto approve must not affect cli',
        repoRoot,
        mock: true,
        live: false,
        json: true,
        sendTerminal: fake.terminal,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(fake.writes).toEqual([]);
      expect(JSON.parse(stdout.text.trim()).data.auto_approve).toBe(false);
      expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'runs', result.run_id, 'terminal', 'send_metadata.json'))).toBe(false);
    } finally {
      if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prevLocalAppData;
      fs.rmSync(appData, { recursive: true, force: true });
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('auto-approve reports a structured send failure when the CLI terminal cannot start', async () => {
    const repoRoot = makeRepo('vibecode-cli-auto-approve-fail-');
    const stdout = makeWriter();
    const stderr = makeWriter();

    try {
      vi.resetModules();
      const { PtyError } = await import('../../../src/adapters/pty/index.js');
      vi.doMock('../../../src/core/terminal/index.js', async () => {
        const actual = await vi.importActual<typeof import('../../../src/core/terminal/index.js')>(
          '../../../src/core/terminal/index.js',
        );
        return {
          ...actual,
          startTerminalSession: () => {
            throw new PtyError('TERMINAL_START_FAILED', 'simulated PTY startup failure');
          },
        };
      });

      const { runPromptCommand: runPromptCommandFresh } = await import('../../../src/app/cli/index.js');
      const result = await runPromptCommandFresh({
        task: 'cli auto approve reports terminal startup failure',
        repoRoot,
        mock: true,
        live: false,
        json: true,
        autoApprove: true,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const envelope = JSON.parse(stdout.text.trim());
      expect(envelope.ok).toBe(true);
      expect(envelope.data.auto_approve).toBe(true);
      expect(envelope.data.send.ok).toBe(false);
      expect(envelope.data.send.error.code).toBe('TERMINAL_START_FAILED');
      expect(envelope.data.send.error.message).toContain('simulated PTY startup failure');
      expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'current', 'send_metadata.json'))).toBe(false);
      expect(stderr.text).toBe('');
    } finally {
      vi.doUnmock('../../../src/core/terminal/index.js');
      vi.resetModules();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
