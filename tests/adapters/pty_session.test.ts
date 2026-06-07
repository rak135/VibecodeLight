describe('PTY session adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test('createPtySession returns object with write resize close onData onExit', async () => {
    const fakePty = {
      pid: 1234,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    const spawn = vi.fn(() => fakePty);

    const { createPtySession, setNodePtyLoaderForTesting } = await import('../../src/adapters/pty/pty_session.js');
    setNodePtyLoaderForTesting(() => ({ spawn }));
    const session = createPtySession({ shell: 'pwsh', cwd: process.cwd(), cols: 100, rows: 30 });

    expect(session.pid).toBe(1234);
    expect(typeof session.write).toBe('function');
    expect(typeof session.resize).toBe('function');
    expect(typeof session.close).toBe('function');
    expect(typeof session.onData).toBe('function');
    expect(typeof session.onExit).toBe('function');
    expect(spawn).toHaveBeenCalledWith('pwsh', [], expect.objectContaining({ cols: 100, rows: 30 }));
  });

  test('PtyError has correct code property', async () => {
    const { PtyError } = await import('../../src/adapters/pty/pty_types.js');

    const error = new PtyError('TERMINAL_TIMEOUT', 'timed out');

    expect(error.code).toBe('TERMINAL_TIMEOUT');
    expect(error.message).toBe('timed out');
    expect(error.name).toBe('PtyError');
  });

  test('PTY_NOT_AVAILABLE code is thrown when node-pty is unavailable', async () => {
    const { createPtySession, PtyError, setNodePtyLoaderForTesting } = await import('../../src/adapters/pty/pty_session.js');
    setNodePtyLoaderForTesting(() => {
      throw new Error('Cannot find module node-pty');
    });

    expect(() => createPtySession({ shell: 'pwsh' })).toThrow(PtyError);
    expect(() => createPtySession({ shell: 'pwsh' })).toThrow(/node-pty/);
    try {
      createPtySession({ shell: 'pwsh' });
    } catch (error) {
      expect(error).toBeInstanceOf(PtyError);
      expect((error as InstanceType<typeof PtyError>).code).toBe('PTY_NOT_AVAILABLE');
    }
  });

  test('shell detection returns pwsh or powershell.exe on Windows', async () => {
    const { detectDefaultShell } = await import('../../src/adapters/pty/pty_session.js');

    expect(detectDefaultShell('win32', (command: string) => command === 'pwsh')).toBe('pwsh');
    expect(detectDefaultShell('win32', (command: string) => command === 'powershell.exe')).toBe('powershell.exe');
  });

  test('shell detection on posix prefers valid SHELL env, falls back through /bin/bash, /usr/bin/bash, /bin/sh, /usr/bin/sh', async () => {
    const { detectDefaultShell } = await import('../../src/adapters/pty/pty_session.js');

    // When SHELL env points to a valid binary, prefer it.
    expect(detectDefaultShell('linux', (cmd) => cmd === '/bin/zsh', { SHELL: '/bin/zsh' })).toBe('/bin/zsh');

    // When SHELL env is set but binary is not executable, fall back.
    expect(detectDefaultShell('linux', (cmd) => cmd === '/bin/bash', { SHELL: '/bin/notfound' })).toBe('/bin/bash');
    expect(detectDefaultShell('linux', (cmd) => cmd === '/usr/bin/bash', { SHELL: '/bin/notfound' })).toBe('/usr/bin/bash');
  });

  test('shell detection falls back through ordered candidates on linux', async () => {
    const { detectDefaultShell } = await import('../../src/adapters/pty/pty_session.js');

    // /bin/bash first
    const binBashExists = (cmd: string) => cmd === '/bin/bash';
    expect(detectDefaultShell('linux', binBashExists)).toBe('/bin/bash');

    // /usr/bin/bash next
    const usrBashExists = (cmd: string) => cmd === '/usr/bin/bash';
    expect(detectDefaultShell('linux', usrBashExists)).toBe('/usr/bin/bash');

    // /bin/sh next
    const binShExists = (cmd: string) => cmd === '/bin/sh';
    expect(detectDefaultShell('linux', binShExists)).toBe('/bin/sh');

    // /usr/bin/sh last
    const usrShExists = (cmd: string) => cmd === '/usr/bin/sh';
    expect(detectDefaultShell('linux', usrShExists)).toBe('/usr/bin/sh');
  });

  test('shell detection throws SHELL_NOT_FOUND when no candidate works', async () => {
    const { detectDefaultShell, PtyError } = await import('../../src/adapters/pty/pty_session.js');

    const nothingExists = (_cmd: string) => false;
    expect(() => detectDefaultShell('linux', nothingExists)).toThrow(PtyError);
    try {
      detectDefaultShell('linux', nothingExists);
    } catch (error) {
      expect(error).toBeInstanceOf(PtyError);
      expect((error as InstanceType<typeof PtyError>).code).toBe('SHELL_NOT_FOUND');
    }
  });

  test('darwin follows the same fallback logic as linux', async () => {
    const { detectDefaultShell } = await import('../../src/adapters/pty/pty_session.js');

    expect(detectDefaultShell('darwin', (cmd) => cmd === '/bin/zsh', { SHELL: '/bin/zsh' })).toBe('/bin/zsh');
    expect(detectDefaultShell('darwin', (cmd) => cmd === '/bin/bash', { SHELL: '/bin/notfound' })).toBe('/bin/bash');
  });
});
