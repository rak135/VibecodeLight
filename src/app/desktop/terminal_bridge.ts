import * as os from 'os';
import * as path from 'path';

import { createPtySession } from '../../adapters/pty/index.js';
import type { PtySession } from '../../adapters/pty/index.js';
import {
  runTerminalAgentPreflight,
  type TerminalAgentPreflightResult,
} from '../../core/agent_guidance/terminal_agent_preflight.js';
import {
  getTerminalAgentProtocolBanner,
  getTerminalPreflightSummary,
  isTerminalAgentBannerEnabled,
} from '../../core/agent_guidance/terminal_protocol.js';
import { prepareVibecodeCliShim, resolveAppCliPath } from '../../core/terminal/cli_shim.js';

export interface DesktopTerminalEvents {
  onData: (sessionId: string, data: string) => void;
  onExit: (sessionId: string, code: number | undefined) => void;
}

export interface DesktopTerminalMetadata {
  pid: number;
  cwd: string;
  shell: string;
  sessionId: string;
  /**
   * One-time agent protocol banner for this session (Phase 1B-4). The renderer
   * prints it to the xterm DISPLAY; it is never written into the PTY. Absent
   * when the banner is disabled (opt-out) or unavailable.
   */
  banner?: string;
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

export type TerminalEnvPreparer = (repoPath: string) => Record<string, string> | undefined;
export type DesktopTerminalPreflightRunner = (repoPath: string) => Promise<TerminalAgentPreflightResult> | TerminalAgentPreflightResult;
/**
 * Produces the one-time agent protocol banner for a new terminal in `repoPath`.
 * Return `undefined`/`null`/'' to emit no banner. Must never mutate state.
 */
export type DesktopTerminalBannerProvider = (repoPath: string) => string | null | undefined;

export interface DesktopTerminalServiceOptions {
  /**
   * Builds the env for a new PTY session. Default implementation writes the
   * repo-local vibecode CLI shim under <repo>/.vibecode/bin and returns an env
   * with that directory prepended to PATH, so that `vibecode` inside the
   * terminal resolves to this app's CLI before any global vibecode binary.
   * Pass `null` to disable shim/env preparation entirely.
   */
  prepareTerminalEnv?: TerminalEnvPreparer | null;
  /**
   * Runs after a PTY is created for a normal terminal. It checks/repairs only
   * supported Agent Guidance MCP config and never writes to terminal stdin.
   * Pass null to disable the integration in focused tests.
   */
  terminalPreflight?: DesktopTerminalPreflightRunner | null;
  /**
   * Builds the one-time agent protocol banner attached to a new session's
   * metadata (Phase 1B-4). The default returns the static protocol banner plus a
   * cheap, read-only preflight preface, honoring the `VIBECODE_AGENT_BANNER`
   * opt-out. Pass null to disable the banner entirely.
   */
  agentBanner?: DesktopTerminalBannerProvider | null;
}

/** Default banner provider: static protocol + cheap preflight, opt-out aware. */
function defaultBannerProvider(): DesktopTerminalBannerProvider {
  return (repoPath: string) => {
    try {
      if (!isTerminalAgentBannerEnabled(process.env)) return undefined;
      return getTerminalAgentProtocolBanner({ preflight: getTerminalPreflightSummary(repoPath) });
    } catch {
      return undefined;
    }
  };
}

function defaultTerminalEnvPreparer(): TerminalEnvPreparer | undefined {
  const appCliPath = resolveAppCliPath();
  if (!appCliPath) {
    return undefined;
  }
  return (repoPath: string) => {
    try {
      const { env } = prepareVibecodeCliShim({
        repoPath,
        appCliPath,
        baseEnv: process.env,
      });
      return env;
    } catch {
      return undefined;
    }
  };
}

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
  private readonly preflightHandlers: Array<(sessionId: string, result: TerminalAgentPreflightResult) => void> = [];

  private readonly prepareTerminalEnv: TerminalEnvPreparer | undefined;
  private readonly terminalPreflight: DesktopTerminalPreflightRunner | undefined;
  private readonly agentBanner: DesktopTerminalBannerProvider | undefined;

  constructor(
    private readonly ptyFactory: PtyFactory = createPtySession,
    options: DesktopTerminalServiceOptions = {},
  ) {
    if (options.prepareTerminalEnv === null) {
      this.prepareTerminalEnv = undefined;
    } else {
      this.prepareTerminalEnv = options.prepareTerminalEnv ?? defaultTerminalEnvPreparer();
    }
    if (options.terminalPreflight === null) {
      this.terminalPreflight = undefined;
    } else {
      this.terminalPreflight = options.terminalPreflight ?? ((repoPath: string) => runTerminalAgentPreflight({ repoRoot: repoPath }));
    }
    if (options.agentBanner === null) {
      this.agentBanner = undefined;
    } else {
      this.agentBanner = options.agentBanner ?? defaultBannerProvider();
    }
  }

  startSession(repoPath: string, cols: number, rows: number): DesktopTerminalMetadata {
    const cwd = path.resolve(repoPath);
    const env = this.prepareTerminalEnv?.(cwd);
    const pty = this.ptyFactory(env ? { cwd, cols, rows, env } : { cwd, cols, rows });

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

    this.runPreflight(sessionId, cwd);

    const metadata: DesktopTerminalMetadata = { pid: pty.pid, cwd, shell, sessionId };
    // Phase 1B-4: attach the one-time protocol banner for the renderer to DISPLAY
    // (never written to the PTY). Best-effort: a provider failure must not block
    // the terminal.
    try {
      const banner = this.agentBanner?.(cwd);
      if (typeof banner === 'string' && banner.length > 0) {
        metadata.banner = banner;
      }
    } catch {
      // Banner is advisory; never fail a terminal because guidance could not be built.
    }
    return metadata;
  }

  private runPreflight(sessionId: string, cwd: string): void {
    if (!this.terminalPreflight) return;
    void Promise.resolve()
      .then(() => this.terminalPreflight!(cwd))
      .then((result) => this.emitPreflightResult(sessionId, result))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.emitPreflightResult(sessionId, {
          ok: false,
          mode: 'check_only',
          repo_root: cwd,
          config_path: '',
          guidance_hash: '',
          checked_at: new Date().toISOString(),
          agents: [],
          warnings: [],
          errors: [message],
          no_pty_injection: true,
        });
      });
  }

  private emitPreflightResult(sessionId: string, result: TerminalAgentPreflightResult): void {
    for (const handler of this.preflightHandlers) handler(sessionId, result);
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

  onPreflightResult(handler: (sessionId: string, result: TerminalAgentPreflightResult) => void): void {
    this.preflightHandlers.push(handler);
  }
}

export interface DesktopIpcRegistrationOptions {
  service?: DesktopTerminalService;
  getWebContents: () => WebContentsLike | undefined;
  getRepoPath?: () => string;
}

/**
 * Windows PTY hint for xterm.js. node-pty uses the ConPTY backend on modern
 * Windows; xterm.js can use this to apply ConPTY-specific scrollback / reflow
 * heuristics during the initial fit and later resizes.
 * Returns undefined on non-Windows so callers leave the option unset.
 */
export interface WindowsPtyInfo {
  backend: 'conpty';
  buildNumber?: number;
}

export function resolveWindowsPtyInfo(
  platform: typeof process.platform = process.platform,
  release: string = os.release(),
): WindowsPtyInfo | undefined {
  if (platform !== 'win32') return undefined;
  const build = Number.parseInt(release.split('.')[2] ?? '', 10);
  return Number.isFinite(build)
    ? { backend: 'conpty', buildNumber: build }
    : { backend: 'conpty' };
}

export function registerDesktopTerminalIpcHandlers(
  ipcMain: IpcMainLike,
  options: DesktopIpcRegistrationOptions,
): DesktopTerminalService {
  const service = options.service ?? new DesktopTerminalService();

  service.onData((sessionId, data) => options.getWebContents()?.send('terminal:data', sessionId, data));
  service.onExit((sessionId, code) => options.getWebContents()?.send('terminal:exit', sessionId, code));
  service.onPreflightResult((sessionId, result) => options.getWebContents()?.send('terminal:preflight', sessionId, result));

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
  ipcMain.handle('terminal:getPtyInfo', () => ({
    platform: process.platform,
    windowsPty: resolveWindowsPtyInfo() ?? null,
  }));
  ipcMain.handle('workspace:info', () => ({
    repoPath: options.getRepoPath?.() ?? process.env.VIBECODE_REPO ?? process.cwd(),
  }));

  return service;
}
