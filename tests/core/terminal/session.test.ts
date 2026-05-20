describe('terminal session core', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test('startTerminalSession returns metadata with cwd shell pid and startedAt', async () => {
    const fakePtySession = {
      pid: 4321,
      isClosed: false,
      shell: 'pwsh',
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    vi.doMock('../../../src/adapters/pty/index.js', () => ({
      createPtySession: vi.fn(() => fakePtySession),
      readUntil: vi.fn(),
    }));

    const { startTerminalSession } = await import('../../../src/core/terminal/session.js');
    const cwd = process.cwd();
    const terminal = startTerminalSession({ cwd, shell: 'pwsh' });

    expect(terminal.metadata.cwd).toBe(cwd);
    expect(terminal.metadata.shell).toBe('pwsh');
    expect(terminal.metadata.pid).toBe(4321);
    expect(terminal.metadata.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('terminal start failure becomes structured PtyError', async () => {
    vi.doMock('../../../src/adapters/pty/index.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/pty/pty_types.js')>(
        '../../../src/adapters/pty/pty_types.js',
      );
      return {
        PtyError: actual.PtyError,
        createPtySession: vi.fn(() => {
          throw new actual.PtyError('TERMINAL_START_FAILED', 'could not start terminal');
        }),
        readUntil: vi.fn(),
      };
    });

    const { startTerminalSession } = await import('../../../src/core/terminal/session.js');
    const { PtyError } = await import('../../../src/adapters/pty/pty_types.js');

    expect(() => startTerminalSession({ cwd: process.cwd(), shell: 'missing-shell' })).toThrow(PtyError);
    try {
      startTerminalSession({ cwd: process.cwd(), shell: 'missing-shell' });
    } catch (error) {
      expect(error).toBeInstanceOf(PtyError);
      expect((error as InstanceType<typeof PtyError>).code).toBe('TERMINAL_START_FAILED');
    }
  });

  test('timeout in writeAndWait becomes TERMINAL_TIMEOUT PtyError', async () => {
    vi.doMock('../../../src/adapters/pty/index.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/pty/pty_types.js')>(
        '../../../src/adapters/pty/pty_types.js',
      );
      return {
        PtyError: actual.PtyError,
        createPtySession: vi.fn(),
        readUntil: vi.fn(async () => {
          throw new actual.PtyError('TERMINAL_TIMEOUT', 'marker not found');
        }),
      };
    });

    const { writeAndWait } = await import('../../../src/core/terminal/session.js');
    const { PtyError } = await import('../../../src/adapters/pty/pty_types.js');
    const { OutputExcerpt } = await import('../../../src/core/terminal/transcript.js');
    const terminal = {
      pty: {
        pid: 99,
        isClosed: false,
        write: vi.fn(),
        resize: vi.fn(),
        close: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn(),
      },
      metadata: { pid: 99, cwd: process.cwd(), shell: 'pwsh', startedAt: new Date().toISOString() },
      excerpt: new OutputExcerpt(),
    };

    await expect(writeAndWait(terminal, 'Write-Output never', 'NEVER', 5)).rejects.toBeInstanceOf(PtyError);
    await expect(writeAndWait(terminal, 'Write-Output never', 'NEVER', 5)).rejects.toMatchObject({
      code: 'TERMINAL_TIMEOUT',
    });
  });
});
