import * as path from 'path';

import { createPtySession } from '../../adapters/pty/index.js';
import type { PtySession } from '../../adapters/pty/index.js';
import { buildCleanExcerpt } from '../../core/terminal/terminal_excerpt_after.js';

export interface DesktopTerminalEvents {
  onData: (data: string) => void;
  onExit: (code: number | undefined) => void;
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
  private session: PtySession | undefined;
  private active: DesktopActiveSession | undefined;
  private transcript = '';
  private readonly dataHandlers: Array<(data: string) => void> = [];
  private readonly exitHandlers: Array<(code: number | undefined) => void> = [];

  constructor(private readonly ptyFactory: PtyFactory = createPtySession) {}

  startSession(repoPath: string, cols: number, rows: number): DesktopTerminalMetadata {
    if (this.session && !this.session.isClosed) {
      this.session.close();
    }

    this.transcript = '';

    const cwd = path.resolve(repoPath);
    const pty = this.ptyFactory({ cwd, cols, rows });
    this.session = pty;

    const shell = (pty as PtySession & { shell?: string }).shell ?? 'unknown';
    const sessionId = makeSessionId(pty.pid);
    this.active = { sessionId, pid: pty.pid, cwd, shell };

    pty.onData((data) => {
      this.transcript += data;
      this.transcript = this.transcript.slice(-200_000);
      for (const handler of this.dataHandlers) handler(data);
    });
    pty.onExit((code) => {
      this.active = undefined;
      for (const handler of this.exitHandlers) handler(code);
    });

    return { pid: pty.pid, cwd, shell, sessionId };
  }

  getActiveSessionInfo(): DesktopActiveSession | undefined {
    if (!this.session || this.session.isClosed) {
      return undefined;
    }
    return this.active;
  }

  getActiveCleanExcerpt(): string | undefined {
    if (!this.session || this.session.isClosed || !this.active) {
      return undefined;
    }
    if (this.transcript.length === 0) {
      return undefined;
    }
    return buildCleanExcerpt(this.transcript);
  }

  writeInput(data: string): void {
    this.session?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.session?.resize(cols, rows);
  }

  async closeSession(): Promise<void> {
    if (!this.session) {
      return;
    }

    if (!this.session.isClosed) {
      this.session.close();
    }
    this.session = undefined;
    this.active = undefined;
    this.transcript = '';
  }

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (code: number | undefined) => void): void {
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

  service.onData((data) => options.getWebContents()?.send('terminal:data', data));
  service.onExit((code) => options.getWebContents()?.send('terminal:exit', code));

  ipcMain.handle('terminal:start', (_event, repoPath, cols, rows) => service.startSession(
    String(repoPath),
    Number(cols),
    Number(rows),
  ));
  ipcMain.on('terminal:input', (_event, data) => service.writeInput(String(data)));
  ipcMain.on('terminal:resize', (_event, cols, rows) => service.resize(Number(cols), Number(rows)));
  ipcMain.handle('terminal:close', async () => service.closeSession());
  ipcMain.handle('workspace:info', () => ({
    repoPath: options.getRepoPath?.() ?? process.env.VIBECODE_REPO ?? process.cwd(),
  }));

  return service;
}
