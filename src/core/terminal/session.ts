import path from 'path';
import { setTimeout } from 'timers';

import { createPtySession, PtyError, PtySession, PtySessionOptions, readUntil } from '../../adapters/pty/index.js';
import { OutputExcerpt, OutputExcerptOptions } from './transcript.js';

export interface TerminalSessionMetadata {
  pid: number;
  cwd: string;
  shell: string;
  startedAt: string;
}

export interface TerminalSessionOptions extends PtySessionOptions {
  excerpt?: OutputExcerptOptions;
}

export interface TerminalSession {
  pty: PtySession;
  metadata: TerminalSessionMetadata;
  excerpt: OutputExcerpt;
}

function newlineForPlatform(): string {
  return process.platform === 'win32' ? '\r' : '\n';
}

export function startTerminalSession(options: TerminalSessionOptions = {}): TerminalSession {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  try {
    const pty = createPtySession({
      ...options,
      cwd,
    });
    const excerpt = new OutputExcerpt(options.excerpt);
    pty.onData((data) => excerpt.append(data));
    pty.onExit(() => undefined);

    return {
      pty,
      metadata: {
        pid: pty.pid,
        cwd,
        shell: (pty as PtySession & { shell?: string }).shell ?? options.shell ?? 'unknown',
        startedAt: new Date().toISOString(),
      },
      excerpt,
    };
  } catch (error) {
    if (error instanceof PtyError) {
      throw error;
    }
    throw new PtyError('TERMINAL_START_FAILED', 'failed to start terminal session', error);
  }
}

export async function writeAndWait(
  session: TerminalSession,
  command: string,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  try {
    session.pty.write(`${command}${newlineForPlatform()}`);
  } catch (error) {
    if (error instanceof PtyError) {
      throw error;
    }
    throw new PtyError('TERMINAL_WRITE_FAILED', 'failed to write command to terminal session', error);
  }

  const expectedOccurrences = command.includes(marker) ? 2 : 1;
  return readUntil(session.pty, marker, timeoutMs, expectedOccurrences);
}

export async function closeSession(session: TerminalSession | undefined): Promise<void> {
  if (!session) {
    return;
  }

  if (!session.pty.isClosed) {
    try {
      session.pty.write(`exit${newlineForPlatform()}`);
    } catch {
      // Fall back to force-close below.
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  session.pty.close();
  await new Promise((resolve) => setTimeout(resolve, 750));
}
