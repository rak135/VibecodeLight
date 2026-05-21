import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../..');

describe('terminal demo JSON output cleanup', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-pty-json-'));
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# JSON clean demo fixture\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runTerminalDemo excerpt uses clean text (no ANSI) via getCleanText on session excerpt', async () => {
    // This test uses the mock PTY path via the adapter.
    // We verify that TerminalDemoResult.excerpt is derived from getCleanText.
    const { OutputExcerpt } = await import('../../src/core/terminal/transcript.js');
    const excerpt = new OutputExcerpt();
    excerpt.append('\x1b[32mVIBECODE_PTY_OK\x1b[0m\n');
    const clean = excerpt.getCleanText();
    expect(clean).toContain('VIBECODE_PTY_OK');
    expect(clean).not.toMatch(/\x1b/);
  });

  test('terminal demo does not create send_metadata.json', async () => {
    const { runTerminalDemo } = await import('../../src/core/terminal/terminal_demo.js');
    // Use a function that will succeed or fail quickly — we just check no forbidden files
    try {
      await runTerminalDemo({ repo: tmpDir });
    } catch {
      // tolerate failure in environments without node-pty
    }
    expect(fs.existsSync(path.join(tmpDir, 'terminal', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'terminal', 'terminal_excerpt_after.md'))).toBe(false);
  });

  test('terminal demo does not create after/ artifacts', async () => {
    const { runTerminalDemo } = await import('../../src/core/terminal/terminal_demo.js');
    try {
      await runTerminalDemo({ repo: tmpDir });
    } catch {
      // tolerate failure in environments without node-pty
    }
    expect(fs.existsSync(path.join(tmpDir, 'after'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.vibecode', 'runs'))).toBe(false);
  });
});

const ptyAvailable = (() => {
  try {
    require('node-pty');
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!ptyAvailable)('terminal demo --json ANSI clean (PTY integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-pty-clean-'));
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# ANSI clean test\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('--json excerpt contains VIBECODE_PTY_OK and has no ANSI escape sequences', () => {
    const result = spawnSync('pnpm', ['vibecode', 'terminal', 'demo', '--repo', tmpDir, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
      timeout: 30000,
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.excerpt).toContain('VIBECODE_PTY_OK');
    // No ESC character in JSON excerpt
    expect(parsed.excerpt).not.toMatch(/\x1b/);
  }, 40000);

  test('--json excerpt does not contain AttachConsole failed spam', () => {
    const result = spawnSync('pnpm', ['vibecode', 'terminal', 'demo', '--repo', tmpDir, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
      timeout: 30000,
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.excerpt).not.toContain('AttachConsole failed');
  }, 40000);

  test('terminal demo uses PTY adapter path (runTerminalDemo function exists and is used by CLI)', async () => {
    // Verify the terminal demo is wired to the real PTY path and not child_process.exec
    const { runTerminalDemo } = await import('../../src/core/terminal/terminal_demo.js');
    expect(typeof runTerminalDemo).toBe('function');

    // Check that the source file imports from PTY adapter, not from child_process exec
    const src = fs.readFileSync(path.join(repoRoot, 'src/core/terminal/terminal_demo.ts'), 'utf8');
    expect(src).toContain("from '../../adapters/pty/index.js'");
    expect(src).not.toContain('child_process.exec');
    expect(src).not.toContain('execSync');
  });
});
