import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { ptyIntegrationEnabled } from '../setup/pty_integration.js';

const repoRoot = path.resolve(__dirname, '../..');

// Real ConPTY integration is opt-in (`pnpm test:pty`); see
// tests/setup/pty_integration.ts for why it is gated.
describe.skipIf(!ptyIntegrationEnabled)('PTY integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-pty-demo-'));
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# PTY demo fixture\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runTerminalDemo starts real PTY and returns ok true output shell and pid', async () => {
    const { runTerminalDemo } = await import('../../src/core/terminal/terminal_demo.js');

    const result = await runTerminalDemo({ repo: tmpDir });

    expect(result.ok).toBe(true);
    expect(result.excerpt).toContain('VIBECODE_PTY_OK');
    expect(result.shell).toBeTruthy();
    expect(result.pid).toBeGreaterThan(0);
  }, 20000);

  test('session closes cleanly without forbidden artifacts', async () => {
    const { runTerminalDemo } = await import('../../src/core/terminal/terminal_demo.js');

    const result = await runTerminalDemo({ repo: tmpDir });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.vibecode', 'runs'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'terminal', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'terminal', 'terminal_excerpt_after.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'after'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'output', 'final_prompt.md'))).toBe(false);
  }, 20000);

  test('--repo tmpdir runs in that directory', async () => {
    const { runTerminalDemo } = await import('../../src/core/terminal/terminal_demo.js');

    const result = await runTerminalDemo({ repo: tmpDir });

    expect(result.ok).toBe(true);
    expect(path.resolve(result.cwd ?? '')).toBe(path.resolve(tmpDir));
  }, 20000);

  test('--json flag returns envelope with ok field', () => {
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
  }, 40000);
});
