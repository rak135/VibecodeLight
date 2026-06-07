import { spawnSync } from 'child_process';
import { clearTimeout, setTimeout } from 'timers';

import { PtyError, PtySession, PtySessionOptions } from './pty_types.js';
export { PtyError } from './pty_types.js';

interface Disposable {
  dispose(): void;
}

interface NodePtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (data: string) => void): Disposable;
  onExit(handler: (event: { exitCode?: number; signal?: number }) => void): Disposable;
}

interface NodePtyModule {
  spawn(
    shell: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): NodePtyProcess;
}

export interface ResolvedPtySession extends PtySession {
  readonly shell: string;
}

function defaultLoadNodePty(): NodePtyModule {
  try {
    return require('node-pty') as NodePtyModule;
  } catch (error) {
    throw new PtyError('PTY_NOT_AVAILABLE', 'node-pty is not installed or could not be loaded', error);
  }
}

let nodePtyLoader: () => NodePtyModule = defaultLoadNodePty;

export function setNodePtyLoaderForTesting(loader: (() => NodePtyModule) | undefined): void {
  nodePtyLoader = loader ?? defaultLoadNodePty;
}

function loadNodePty(): NodePtyModule {
  try {
    return nodePtyLoader();
  } catch (error) {
    if (error instanceof PtyError) {
      throw error;
    }
    throw new PtyError('PTY_NOT_AVAILABLE', 'node-pty is not installed or could not be loaded', error);
  }
}

function commandPath(command: string, platform: typeof process.platform = process.platform): string | undefined {
  const probe = platform === 'win32'
    ? spawnSync('where', [command], { encoding: 'utf8' })
    : spawnSync('which', [command], { encoding: 'utf8' });
  if (probe.status !== 0 || !probe.stdout) {
    return undefined;
  }
  return probe.stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

export function commandExists(command: string, platform: typeof process.platform = process.platform): boolean {
  if (commandPath(command, platform)) {
    return true;
  }

  const versionProbe = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return versionProbe.status === 0;
}

function shellForSpawn(shell: string): string {
  if (process.platform !== 'win32') {
    return shell;
  }
  if (shell.toLowerCase() === 'pwsh' || shell.toLowerCase() === 'powershell.exe') {
    return commandPath(shell) ?? shell;
  }
  return shell;
}

const POSIX_SHELL_CANDIDATES: readonly string[] = [
  '/bin/bash',
  '/usr/bin/bash',
  '/bin/sh',
  '/usr/bin/sh',
];

export function detectDefaultShell(
  platform: typeof process.platform = process.platform,
  exists: (command: string) => boolean = (command) => commandExists(command, platform),
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === 'win32') {
    if (exists('pwsh')) {
      return 'pwsh';
    }
    if (exists('powershell.exe')) {
      return 'powershell.exe';
    }
    throw new PtyError('SHELL_NOT_FOUND', 'PowerShell shell not found; tried pwsh then powershell.exe');
  }

  const shellEnv = env.SHELL?.trim();
  if (shellEnv && exists(shellEnv)) {
    return shellEnv;
  }

  const attempted: string[] = shellEnv ? [shellEnv] : [];
  for (const candidate of POSIX_SHELL_CANDIDATES) {
    attempted.push(candidate);
    if (exists(candidate)) {
      return candidate;
    }
  }

  const tried = attempted.length > 0 ? ` tried ${attempted.join(', ')}` : '';
  throw new PtyError('SHELL_NOT_FOUND', `no shell found;${tried}`);
}

class NodePtySession implements ResolvedPtySession {
  private closed = false;
  private readonly disposables: Disposable[] = [];

  constructor(
    private readonly pty: NodePtyProcess,
    public readonly shell: string,
  ) {}

  get pid(): number {
    return this.pty.pid;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  write(data: string): void {
    try {
      this.pty.write(data);
    } catch (error) {
      throw new PtyError('TERMINAL_WRITE_FAILED', 'failed to write to terminal PTY', error);
    }
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty.resize(cols, rows);
    } catch (error) {
      throw new PtyError('TERMINAL_WRITE_FAILED', 'failed to resize terminal PTY', error);
    }
  }

  close(): void {
    this.closed = true;
    for (const disposable of this.disposables.splice(0)) {
      try {
        disposable.dispose();
      } catch {
        // Best-effort cleanup only.
      }
    }
    try {
      this.pty.kill();
    } catch {
      // Best-effort close only.
    }
  }

  onData(handler: (data: string) => void): void {
    this.disposables.push(this.pty.onData(handler));
  }

  onExit(handler: (code: number | undefined) => void): void {
    const disposable = this.pty.onExit((event) => {
      this.closed = true;
      handler(event.exitCode);
    });
    this.disposables.push(disposable);
  }
}

export function createPtySession(options: PtySessionOptions = {}): ResolvedPtySession {
  const nodePty = loadNodePty();
  const shell = options.shell ?? detectDefaultShell();
  const spawnShell = options.shell ? shell : shellForSpawn(shell);
  const env = { ...processEnv(), ...(options.env ?? {}) };

  try {
    const pty = nodePty.spawn(spawnShell, [], {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd ?? process.cwd(),
      env,
    });
    return new NodePtySession(pty, shell);
  } catch (error) {
    throw new PtyError('TERMINAL_START_FAILED', `failed to start terminal shell: ${shell}`, error);
  }
}

function occurrenceCount(text: string, marker: string): number {
  if (marker.length === 0) {
    return 0;
  }
  let count = 0;
  let index = text.indexOf(marker);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(marker, index + marker.length);
  }
  return count;
}

export function readUntil(
  session: PtySession,
  marker: string,
  timeoutMs: number,
  expectedOccurrences = 1,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const maxBufferChars = 200_000;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      finish(() => {
        reject(new PtyError('TERMINAL_TIMEOUT', `terminal output did not contain marker within ${timeoutMs}ms: ${marker}`));
      });
    }, timeoutMs);

    session.onData((data) => {
      if (settled) {
        return;
      }
      buffer += data;
      if (buffer.length > maxBufferChars) {
        buffer = buffer.slice(-maxBufferChars);
      }
      if (occurrenceCount(buffer, marker) >= expectedOccurrences) {
        finish(() => resolve(buffer));
      }
    });

    session.onExit((code) => {
      if (settled) {
        return;
      }
      finish(() => {
        reject(new PtyError('TERMINAL_START_FAILED', `terminal exited before marker was seen; exit code: ${code ?? 'unknown'}`));
      });
    });
  });
}
