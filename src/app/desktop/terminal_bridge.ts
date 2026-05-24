import * as path from 'path';

import { createPtySession } from '../../adapters/pty/index.js';
import type { PtySession } from '../../adapters/pty/index.js';

export interface DesktopTerminalEvents {
  onData: (sessionId: string, data: string) => void;
  onExit: (sessionId: string, code: number | undefined) => void;
}

export interface DesktopTerminalMetadata {
  pid: number;
  cwd: string;
  shell: string;
  sessionId: string;
}

export interface DesktopActiveSession {
  sessionId: string;
  pid: number;
  cwd: string;
  shell: string;
}

interface SessionEntry {
  info: DesktopActiveSession;
  pty: PtySession;
}

type PtyFactory = typeof createPtySession;

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
}

let sessionCounter = 0;
function makeSessionId(pid: number): string {
  sessionCounter += 1;
  return `desktop-${pid}-${Date.now().toString(36)}-${sessionCounter.toString(36)}`;
}

export class DesktopTerminalService {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly order: string[] = [];
  private readonly dataHandlers: Array<(sessionId: string, data: string) => void> = [];
  private readonly exitHandlers: Array<(sessionId: string, code: number | undefined) => void> = [];

  constructor(private readonly ptyFactory: PtyFactory = createPtySession) {}

  startSession(repoPath: string, cols: number, rows: number): DesktopTerminalMetadata {
    const cwd = path.resolve(repoPath);
    const pty = this.ptyFactory({ cwd, cols, rows });

    const shell = (pty as PtySession & { shell?: string }).shell ?? 'unknown';
    const sessionId = makeSessionId(pty.pid);
    const info: DesktopActiveSession = { sessionId, pid: pty.pid, cwd, shell };

    this.sessions.set(sessionId, { info, pty });
    this.order.push(sessionId);

    pty.onData((data) => {
      for (const handler of this.dataHandlers) handler(sessionId, data);
    });
    pty.onExit((code) => {
      this.sessions.delete(sessionId);
      const idx = this.order.indexOf(sessionId);
      if (idx >= 0) this.order.splice(idx, 1);
      for (const handler of this.exitHandlers) handler(sessionId, code);
    });

    return { pid: pty.pid, cwd, shell, sessionId };
  }

  getSession(sessionId: string): DesktopActiveSession | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.pty.isClosed) return undefined;
    return entry.info;
  }

  getActiveSessionInfo(): DesktopActiveSession | undefined {
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const id = this.order[i]!;
      const entry = this.sessions.get(id);
      if (entry && !entry.pty.isClosed) return entry.info;
    }
    return undefined;
  }

  listSessions(): DesktopActiveSession[] {
    const result: DesktopActiveSession[] = [];
    for (const id of this.order) {
      const entry = this.sessions.get(id);
      if (entry && !entry.pty.isClosed) result.push(entry.info);
    }
    return result;
  }

  writeInput(sessionId: string, data: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.pty.isClosed) return;
    entry.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.pty.isClosed) return;
    entry.pty.resize(cols, rows);
  }

  async closeSession(sessionId?: string): Promise<void> {
    if (sessionId === undefined) {
      const ids = [...this.order];
      for (const id of ids) {
        await this.closeSession(id);
      }
      return;
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (!entry.pty.isClosed) {
      entry.pty.close();
    }
    this.sessions.delete(sessionId);
    const idx = this.order.indexOf(sessionId);
    if (idx >= 0) this.order.splice(idx, 1);
  }

  onData(handler: (sessionId: string, data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (sessionId: string, code: number | undefined) => void): void {
    this.exitHandlers.push(handler);
  }
}

export interface DesktopIpcRegistrationOptions {
  service?: DesktopTerminalService;
  getWebContents: () => WebContentsLike | undefined;
  getRepoPath?: () => string;
}

export function registerDesktopTerminalIpcHandlers(
  ipcMain: IpcMainLike,
  options: DesktopIpcRegistrationOptions,
): DesktopTerminalService {
  const service = options.service ?? new DesktopTerminalService();

  service.onData((sessionId, data) => options.getWebContents()?.send('terminal:data', sessionId, data));
  service.onExit((sessionId, code) => options.getWebContents()?.send('terminal:exit', sessionId, code));

  ipcMain.handle('terminal:start', (_event, repoPath, cols, rows) => service.startSession(
    String(repoPath),
    Number(cols),
    Number(rows),
  ));
  ipcMain.on('terminal:input', (_event, sessionId, data) => service.writeInput(String(sessionId), String(data)));
  ipcMain.on('terminal:resize', (_event, sessionId, cols, rows) => service.resize(String(sessionId), Number(cols), Number(rows)));
  ipcMain.handle('terminal:close', async (_event, sessionId) => {
    if (sessionId === undefined || sessionId === null) {
      await service.closeSession();
      return;
    }
    await service.closeSession(String(sessionId));
  });
  ipcMain.handle('terminal:list', () => service.listSessions());
  ipcMain.handle('workspace:info', () => ({
    repoPath: options.getRepoPath?.() ?? process.env.VIBECODE_REPO ?? process.cwd(),
  }));

  return service;
}
