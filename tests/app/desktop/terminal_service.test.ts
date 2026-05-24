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

let nextFakePid = 4242;
function createFakePty(): FakePtySession {
  const pid = nextFakePid++;
  const fake = {
    pid,
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
    expect(metadata).toMatchObject({ pid: fakePty.pid, cwd: repoPath, shell: fakePty.shell });
    expect(typeof metadata.sessionId).toBe('string');
    expect(metadata.sessionId.length).toBeGreaterThan(0);
  });

  test('getActiveSessionInfo returns the running session and clears after close', async () => {
    const fakePty = createFakePty();
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(() => fakePty);
    expect(service.getActiveSessionInfo()).toBeUndefined();

    const metadata = service.startSession(process.cwd(), 80, 24);
    const active = service.getActiveSessionInfo();
    expect(active).toBeDefined();
    expect(active?.sessionId).toBe(metadata.sessionId);
    expect(active?.pid).toBe(fakePty.pid);
    expect(active?.cwd).toBe(metadata.cwd);
    expect(active?.shell).toBe(fakePty.shell);

    await service.closeSession(metadata.sessionId);
    expect(service.getActiveSessionInfo()).toBeUndefined();
  });

  test('forwards input to the targeted PTY session and resizes it', async () => {
    const fakePty = createFakePty();
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(() => fakePty);
    const meta = service.startSession(process.cwd(), 80, 24);
    service.writeInput(meta.sessionId, 'git status\r');
    service.resize(meta.sessionId, 132, 43);

    expect(fakePty.writes).toEqual(['git status\r']);
    expect(fakePty.resizes).toEqual([{ cols: 132, rows: 43 }]);
  });

  test('emits terminal output and exit events tagged with sessionId', async () => {
    const fakePty = createFakePty();
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const onData = vi.fn();
    const onExit = vi.fn();

    const service = new DesktopTerminalService(() => fakePty);
    service.onData(onData);
    service.onExit(onExit);
    const meta = service.startSession(process.cwd(), 80, 24);
    fakePty.emitData('hello from pty');
    fakePty.emitExit(0);

    expect(onData).toHaveBeenCalledWith(meta.sessionId, 'hello from pty');
    expect(onExit).toHaveBeenCalledWith(meta.sessionId, 0);
  });

  test('closes session cleanly when given its id', async () => {
    const fakePty = createFakePty();
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(() => fakePty);
    const meta = service.startSession(process.cwd(), 80, 24);
    await service.closeSession(meta.sessionId);

    expect(fakePty.closed).toBe(true);
    expect(service.listSessions()).toEqual([]);
  });

  test('startSession uses the resolved repo root as PTY cwd', async () => {
    const fakePty = createFakePty();
    const factory = vi.fn((_options?: PtySessionOptions) => fakePty);
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const resolvedRoot = path.resolve(process.cwd());

    const service = new DesktopTerminalService(factory);
    service.startSession(resolvedRoot, 100, 30);

    expect(factory.mock.calls[0][0]).toMatchObject({ cwd: resolvedRoot });
  });

  test('starts multiple independent sessions side by side', async () => {
    const ptyA = createFakePty();
    const ptyB = createFakePty();
    const ptyC = createFakePty();
    const ptys = [ptyA, ptyB, ptyC];
    let i = 0;
    const factory = vi.fn((_options?: PtySessionOptions) => ptys[i++]!);
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(factory);
    const a = service.startSession(process.cwd(), 80, 24);
    const b = service.startSession(process.cwd(), 80, 24);
    const c = service.startSession(process.cwd(), 80, 24);

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(b.sessionId).not.toBe(c.sessionId);
    expect(service.listSessions().map((s) => s.sessionId)).toEqual([a.sessionId, b.sessionId, c.sessionId]);
    expect(ptyA.closed).toBe(false);
    expect(ptyB.closed).toBe(false);
    expect(ptyC.closed).toBe(false);
  });

  test('routes write/resize to the addressed session only', async () => {
    const ptyA = createFakePty();
    const ptyB = createFakePty();
    let i = 0;
    const factory = vi.fn((_options?: PtySessionOptions) => (i++ === 0 ? ptyA : ptyB));
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(factory);
    const a = service.startSession(process.cwd(), 80, 24);
    const b = service.startSession(process.cwd(), 80, 24);

    service.writeInput(a.sessionId, 'to-a\r');
    service.writeInput(b.sessionId, 'to-b\r');
    service.resize(b.sessionId, 100, 30);

    expect(ptyA.writes).toEqual(['to-a\r']);
    expect(ptyB.writes).toEqual(['to-b\r']);
    expect(ptyA.resizes).toEqual([]);
    expect(ptyB.resizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  test('closeSession(id) closes only the targeted PTY and leaves siblings running', async () => {
    const ptyA = createFakePty();
    const ptyB = createFakePty();
    let i = 0;
    const factory = vi.fn((_options?: PtySessionOptions) => (i++ === 0 ? ptyA : ptyB));
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(factory);
    const a = service.startSession(process.cwd(), 80, 24);
    const b = service.startSession(process.cwd(), 80, 24);

    await service.closeSession(a.sessionId);
    expect(ptyA.closed).toBe(true);
    expect(ptyB.closed).toBe(false);
    expect(service.listSessions().map((s) => s.sessionId)).toEqual([b.sessionId]);
    expect(service.getSession(a.sessionId)).toBeUndefined();
    expect(service.getSession(b.sessionId)?.sessionId).toBe(b.sessionId);
  });

  test('closeSession() with no id closes every session', async () => {
    const ptyA = createFakePty();
    const ptyB = createFakePty();
    let i = 0;
    const factory = vi.fn((_options?: PtySessionOptions) => (i++ === 0 ? ptyA : ptyB));
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(factory);
    service.startSession(process.cwd(), 80, 24);
    service.startSession(process.cwd(), 80, 24);
    await service.closeSession();

    expect(ptyA.closed).toBe(true);
    expect(ptyB.closed).toBe(true);
    expect(service.listSessions()).toEqual([]);
  });

  test('exit event drops the session from listSessions and getActiveSessionInfo', async () => {
    const ptyA = createFakePty();
    const ptyB = createFakePty();
    let i = 0;
    const factory = vi.fn((_options?: PtySessionOptions) => (i++ === 0 ? ptyA : ptyB));
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(factory);
    const a = service.startSession(process.cwd(), 80, 24);
    const b = service.startSession(process.cwd(), 80, 24);

    ptyB.closed = true;
    ptyB.emitExit(0);

    expect(service.listSessions().map((s) => s.sessionId)).toEqual([a.sessionId]);
    expect(service.getActiveSessionInfo()?.sessionId).toBe(a.sessionId);
  });

  test('getActiveSessionInfo returns the most recently started live session', async () => {
    const ptyA = createFakePty();
    const ptyB = createFakePty();
    let i = 0;
    const factory = vi.fn((_options?: PtySessionOptions) => (i++ === 0 ? ptyA : ptyB));
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');

    const service = new DesktopTerminalService(factory);
    service.startSession(process.cwd(), 80, 24);
    const b = service.startSession(process.cwd(), 80, 24);

    expect(service.getActiveSessionInfo()?.sessionId).toBe(b.sessionId);
  });
});
