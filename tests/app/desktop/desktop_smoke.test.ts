import fs from 'fs';
import os from 'os';
import path from 'path';

import type { PtySession, PtySessionOptions } from '../../../src/adapters/pty/index.js';

type FakePty = PtySession & {
  shell: string;
  writes: string[];
  dataHandlers: Array<(data: string) => void>;
  exitHandlers: Array<(code: number | undefined) => void>;
  closed: boolean;
  emitData(data: string): void;
};

function createFakePty(): FakePty {
  const fake: FakePty = {
    pid: 9090,
    shell: 'pwsh',
    writes: [],
    dataHandlers: [],
    exitHandlers: [],
    closed: false,
    get isClosed() {
      return this.closed;
    },
    write(data: string) {
      this.writes.push(data);
      const marker = 'VIBECODE_ELECTRON_PTY_OK';
      if (data.includes(marker)) {
        setTimeout(() => this.emitData(`${marker}\r\n`), 5);
      }
    },
    resize() {},
    close() {
      this.closed = true;
    },
    onData(handler: (data: string) => void) {
      this.dataHandlers.push(handler);
    },
    onExit(handler: (code: number | undefined) => void) {
      this.exitHandlers.push(handler);
    },
    emitData(data: string) {
      for (const handler of this.dataHandlers) handler(data);
    },
  };
  return fake;
}

describe('desktop smoke', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-desktop-smoke-'));
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# smoke fixture\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runDesktopSmoke exercises DesktopTerminalService and detects VIBECODE_ELECTRON_PTY_OK', async () => {
    const fakePty = createFakePty();
    const ptyFactory = (_opts?: PtySessionOptions) => fakePty;
    const { runDesktopSmoke } = await import('../../../src/app/desktop/desktop_smoke.js');

    const result = await runDesktopSmoke({ repo: tmpDir, ptyFactory });

    expect(result.ok).toBe(true);
    expect(result.marker_seen).toBe(true);
    expect(result.cwd).toBe(path.resolve(tmpDir));
    expect(fakePty.closed).toBe(true);
  });

  test('runDesktopSmoke does not create terminal/send_metadata.json or after/ artifacts', async () => {
    const fakePty = createFakePty();
    const { runDesktopSmoke } = await import('../../../src/app/desktop/desktop_smoke.js');

    await runDesktopSmoke({ repo: tmpDir, ptyFactory: () => fakePty });

    expect(fs.existsSync(path.join(tmpDir, 'terminal', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.vibecode', 'runs'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'after'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'output', 'final_prompt.md'))).toBe(false);
  });

  test('runDesktopSmoke uses DesktopTerminalService from terminal_bridge', async () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../src/app/desktop/desktop_smoke.ts'),
      'utf8',
    );
    expect(src).toMatch(/DesktopTerminalService/);
    expect(src).toMatch(/from '\.\/terminal_bridge\.js'/);
  });
});
