import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  runPromptCommand,
  type PromptSendTerminal,
} from '../../../src/app/cli/index.js';

function makeRepo(prefix = 'vibecode-cli-send-envelope-'): string {
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
        sessionId: 'cli-send-envelope-test',
        cwd: repoRoot,
        write: (data: string) => { writes.push(data); },
      },
      close: () => { closedFlag = true; },
    },
  };
}

describe('runPromptCommand JSON success envelope — non-autoApprove path', () => {
  test('exposes the documented data key set, omits send envelope, and reports auto_approve=false', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    try {
      const result = await runPromptCommand({
        task: 'characterize json envelope shape',
        repoRoot,
        mock: true,
        live: false,
        json: true,
        autoApprove: false,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const lines = stdout.text.trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      const envelope = JSON.parse(lines[0]);

      // Top-level envelope shape.
      expect(envelope.ok).toBe(true);
      expect(Array.isArray(envelope.artifacts)).toBe(true);
      expect(Array.isArray(envelope.warnings)).toBe(true);

      const data = envelope.data;

      // Pin the current documented data key set.
      const requiredKeys = [
        'run_id',
        'runDir',
        'finalPromptPath',
        'flash_input_path',
        'repo_atlas_path',
        'task_slice_path',
        'relevance_selection_path',
        'flash_input_budget_path',
        'taskNormalizerEnabled',
        'taskNormalizerOk',
        'taskNormalizerLanguage',
        'taskIntentPath',
        'estimated_tokens',
        'hard_max_tokens',
        'provider_called',
        'auto_approve',
      ];
      for (const key of requiredKeys) {
        expect(data).toHaveProperty(key);
      }

      expect(typeof data.run_id).toBe('string');
      expect(typeof data.runDir).toBe('string');
      expect(typeof data.finalPromptPath).toBe('string');
      expect(typeof data.taskNormalizerEnabled).toBe('boolean');
      expect(typeof data.taskNormalizerOk).toBe('boolean');
      expect(typeof data.taskNormalizerLanguage).toBe('string');
      expect(data.auto_approve).toBe(false);

      // Without --auto-approve, the send envelope is omitted entirely (not null).
      expect('send' in data).toBe(false);
      expect(data.send).toBeUndefined();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runPromptCommand plain-text success output — non-autoApprove path', () => {
  test('prints run/runDir/final_prompt/artifacts header and the "no terminal send" note', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    try {
      const result = await runPromptCommand({
        task: 'characterize plain text output',
        repoRoot,
        mock: true,
        live: false,
        json: false,
        autoApprove: false,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Current plain-text success format lines.
      expect(stdout.text).toContain(`run: ${result.run_id}\n`);
      expect(stdout.text).toContain('runDir: ');
      expect(stdout.text).toContain('final_prompt: ');
      expect(stdout.text).toContain('artifacts:\n');

      // Without --auto-approve, the CLI prints a "no terminal send" note instead of an auto-approve send line.
      expect(stdout.text).toContain('note: no terminal send in this checkpoint');
      expect(stdout.text).not.toContain('auto-approve: sent final_prompt.md');
      // Happy path: no auto-approve failure line on stderr.
      expect(stderr.text).not.toContain('auto-approve send failed');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runPromptCommand auto-approve non-JSON send failure output', () => {
  test('prints "auto-approve send failed: <code> <message>" to stderr and still returns ok pipeline result', async () => {
    const repoRoot = makeRepo();
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
        task: 'auto-approve non-json failure output',
        repoRoot,
        mock: true,
        live: false,
        json: false,
        autoApprove: true,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      // Pipeline itself succeeded; the send envelope is the only failed thing.
      expect(result.ok).toBe(true);

      // The current failure line format includes the code and message.
      expect(stderr.text).toContain('auto-approve send failed:');
      expect(stderr.text).toContain('TERMINAL_START_FAILED');
      expect(stderr.text).toContain('simulated PTY startup failure');

      // Plain-text success header is still emitted for the pipeline portion.
      expect(stdout.text).toContain('final_prompt: ');
      // No success-line for the send (that line goes to stdout only on a successful send).
      expect(stdout.text).not.toContain('auto-approve: sent final_prompt.md');
    } finally {
      vi.doUnmock('../../../src/core/terminal/index.js');
      vi.resetModules();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runPromptCommand sendError.code derivation', () => {
  test('plain Error without a code property derives SEND_FAILED', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();

    try {
      vi.resetModules();
      vi.doMock('../../../src/core/terminal/index.js', async () => {
        const actual = await vi.importActual<typeof import('../../../src/core/terminal/index.js')>(
          '../../../src/core/terminal/index.js',
        );
        return {
          ...actual,
          startTerminalSession: () => {
            throw new Error('plain error with no code property');
          },
        };
      });

      const { runPromptCommand: runPromptCommandFresh } = await import('../../../src/app/cli/index.js');
      const result = await runPromptCommandFresh({
        task: 'sendError code derivation plain Error',
        repoRoot,
        mock: true,
        live: false,
        json: true,
        autoApprove: true,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(result.ok).toBe(true);
      const envelope = JSON.parse(stdout.text.trim());
      expect(envelope.ok).toBe(true);
      expect(envelope.data.auto_approve).toBe(true);
      expect(envelope.data.send.ok).toBe(false);
      expect(envelope.data.send.error.code).toBe('SEND_FAILED');
      expect(envelope.data.send.error.message).toContain('plain error with no code property');
      expect(Array.isArray(envelope.data.send.error.details)).toBe(true);
    } finally {
      vi.doUnmock('../../../src/core/terminal/index.js');
      vi.resetModules();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('generic Error with a string code property uses that code verbatim', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();

    try {
      vi.resetModules();
      vi.doMock('../../../src/core/terminal/index.js', async () => {
        const actual = await vi.importActual<typeof import('../../../src/core/terminal/index.js')>(
          '../../../src/core/terminal/index.js',
        );
        return {
          ...actual,
          startTerminalSession: () => {
            const error = new Error('generic error with custom code');
            (error as Error & { code: string }).code = 'GENERIC_CUSTOM_CODE';
            throw error;
          },
        };
      });

      const { runPromptCommand: runPromptCommandFresh } = await import('../../../src/app/cli/index.js');
      const result = await runPromptCommandFresh({
        task: 'sendError code derivation generic Error with code',
        repoRoot,
        mock: true,
        live: false,
        json: true,
        autoApprove: true,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(result.ok).toBe(true);
      const envelope = JSON.parse(stdout.text.trim());
      expect(envelope.data.send.ok).toBe(false);
      expect(envelope.data.send.error.code).toBe('GENERIC_CUSTOM_CODE');
      expect(envelope.data.send.error.message).toContain('generic error with custom code');
    } finally {
      vi.doUnmock('../../../src/core/terminal/index.js');
      vi.resetModules();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runPromptCommand current_send_metadata behaviour in JSON envelope', () => {
  test('non-autoApprove path omits the send envelope entirely (no current_send_metadata key)', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    try {
      await runPromptCommand({
        task: 'current send metadata non auto approve',
        repoRoot,
        mock: true,
        live: false,
        json: true,
        autoApprove: false,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      const envelope = JSON.parse(stdout.text.trim());
      expect('send' in envelope.data).toBe(false);
      expect(envelope.data.send).toBeUndefined();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('autoApprove success path includes current_send_metadata as the .vibecode/current path', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    const fake = makeFakeTerminal(repoRoot);
    try {
      const result = await runPromptCommand({
        task: 'current send metadata auto approve success',
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

      const envelope = JSON.parse(stdout.text.trim());
      expect(envelope.data.send.ok).toBe(true);
      expect(envelope.data.send.auto_approve).toBe(true);
      expect(typeof envelope.data.send.sent_at).toBe('string');
      expect(envelope.data.send.sent_at.length).toBeGreaterThan(0);

      // send_metadata points at the run-folder artifact; current_send_metadata mirrors it under .vibecode/current/.
      expect(typeof envelope.data.send.send_metadata).toBe('string');
      expect(envelope.data.send.send_metadata).toContain(path.join('terminal', 'send_metadata.json'));

      expect(typeof envelope.data.send.current_send_metadata).toBe('string');
      expect(envelope.data.send.current_send_metadata).toContain(
        path.join('.vibecode', 'current', 'send_metadata.json'),
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
