import path from 'path';

import type { PtySession, PtySessionOptions } from '../../../src/adapters/pty/index.js';

type FakePtySession = PtySession & {
  shell: string;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  dataHandlers: Array<(data: string) => void>;
  exitHandlers: Array<(code: number | undefined) => void>;
  closed: boolean;
  emitData(data: string): void;
  emitExit(code: number | undefined): void;
};

function createFakePty(): FakePtySession {
  const fake = {
    pid: 4242,
    shell: 'pwsh',
    writes: [] as string[],
    resizes: [] as Array<{ cols: number; rows: number }>,
    dataHandlers: [] as Array<(data: string) => void>,
    exitHandlers: [] as Array<(code: number | undefined) => void>,
    closed: false,
    get isClosed() {
      return this.closed;
    },
    write(data: string) {
      this.writes.push(data);
    },
    resize(cols: number, rows: number) {
      this.resizes.push({ cols, rows });
    },
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
    emitExit(code: number | undefined) {
      for (const handler of this.exitHandlers) handler(code);
    },
  } satisfies FakePtySession;

  return fake;
}

describe('DesktopTerminalService', () => {
  test('uses existing PTY adapter abstraction through injectable factory', async () => {
    const fakePty = createFakePty();
    const factory = vi.fn((_options?: PtySessionOptions) => fakePty);
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(factory);
    service.startSession(process.cwd(), 100, 32);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toMatchObject({ cols: 100, rows: 32 });
  });

  test('starts session with requested repo path as cwd', async () => {
    const fakePty = createFakePty();
    const factory = vi.fn((_options?: PtySessionOptions) => fakePty);
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const repoPath = path.resolve(process.cwd(), 'fixture-repo');

    const service = new DesktopTerminalService(factory);
    const metadata = service.startSession(repoPath, 120, 40);

    expect(factory.mock.calls[0][0]).toMatchObject({ cwd: repoPath, cols: 120, rows: 40 });
    expect(metadata).toEqual({ pid: fakePty.pid, cwd: repoPath, shell: fakePty.shell });
  });

  test('forwards input to PTY session and resizes active session', async () => {
    const fakePty = createFakePty();
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(() => fakePty);
    service.startSession(process.cwd(), 80, 24);
    service.writeInput('git status\r');
    service.resize(132, 43);

    expect(fakePty.writes).toEqual(['git status\r']);
    expect(fakePty.resizes).toEqual([{ cols: 132, rows: 43 }]);
  });

  test('emits terminal output and exit events', async () => {
    const fakePty = createFakePty();
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const onData = vi.fn();
    const onExit = vi.fn();

    const service = new DesktopTerminalService(() => fakePty);
    service.onData(onData);
    service.onExit(onExit);
    service.startSession(process.cwd(), 80, 24);
    fakePty.emitData('hello from pty');
    fakePty.emitExit(0);

    expect(onData).toHaveBeenCalledWith('hello from pty');
    expect(onExit).toHaveBeenCalledWith(0);
  });

  test('closes session cleanly', async () => {
    const fakePty = createFakePty();
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(() => fakePty);
    service.startSession(process.cwd(), 80, 24);
    await service.closeSession();

    expect(fakePty.closed).toBe(true);
  });
});
