import path from 'path';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'timers';

import { createPtySession } from '../../adapters/pty/index.js';
import { DesktopTerminalService } from './terminal_bridge.js';

const DEFAULT_MARKER = 'VIBECODE_ELECTRON_PTY_OK';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface DesktopSmokeOptions {
  repo?: string;
  marker?: string;
  timeoutMs?: number;
  ptyFactory?: typeof createPtySession;
}

export interface DesktopSmokeResult {
  ok: boolean;
  marker_seen: boolean;
  marker: string;
  cwd: string;
  pid?: number;
  shell?: string;
  excerpt: string;
  error?: { code: string; message: string };
}

function newline(): string {
  return process.platform === 'win32' ? '\r' : '\n';
}

export async function runDesktopSmoke(options: DesktopSmokeOptions = {}): Promise<DesktopSmokeResult> {
  const repo = path.resolve(options.repo ?? process.cwd());
  const marker = options.marker ?? DEFAULT_MARKER;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const factory = options.ptyFactory ?? createPtySession;
  const service = new DesktopTerminalService(factory);

  let buffer = '';
  let pid: number | undefined;
  let shell: string | undefined;
  let cwd = repo;

  service.onData((data) => {
    buffer += data;
  });

  try {
    const metadata = service.startSession(repo, 120, 30);
    pid = metadata.pid;
    shell = metadata.shell;
    cwd = metadata.cwd;

    const seen = await new Promise<boolean>((resolve) => {
      const interval = setInterval(() => {
        if (buffer.includes(marker)) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve(true);
        }
      }, 50);
      const timer = setTimeout(() => {
        clearInterval(interval);
        resolve(false);
      }, timeoutMs);

      service.writeInput(`Write-Output "${marker}"${newline()}`);
    });

    return {
      ok: seen,
      marker_seen: seen,
      marker,
      cwd,
      pid,
      shell,
      excerpt: buffer,
      error: seen
        ? undefined
        : {
            code: 'DESKTOP_SMOKE_MARKER_NOT_SEEN',
            message: `marker '${marker}' not seen within ${timeoutMs}ms`,
          },
    };
  } catch (error) {
    return {
      ok: false,
      marker_seen: false,
      marker,
      cwd,
      pid,
      shell,
      excerpt: buffer,
      error: {
        code: 'DESKTOP_SMOKE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    await service.closeSession();
  }
}
