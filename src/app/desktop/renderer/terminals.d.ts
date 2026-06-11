// Type declarations for the plain-JS multi-terminal tile controller.
//
// Unlike the other renderer modules, terminals.js has NO node/CommonJS export:
// it is a browser IIFE that registers `window.VibecodeTerminals` and bails out
// when `window` is undefined. Importing the module therefore only runs it for
// its side effect (registration); the public surface is reached through
// `window.VibecodeTerminals`. These declarations document that surface and let
// the side-effect import type-check.

/** Per-session metadata returned by the terminal start API. */
export interface TerminalSessionMetadataLike {
  sessionId: string;
  pid: number;
  cwd: string;
  shell: string;
  /** One-time agent protocol banner shown once on the xterm DISPLAY (never PTY). */
  banner?: string;
}

/** The preload terminal API the controller drives (renderer ⇄ backend PTY). */
export interface TerminalApiLike {
  start(repoPath: string, cols: number, rows: number): Promise<TerminalSessionMetadataLike>;
  /** PTY input path (renderer → shell stdin). The banner must never use this. */
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  close(sessionId?: string): Promise<void>;
  /** Backend → renderer display data (PTY output). */
  onData(cb: (sessionId: string, data: string) => void): void;
  onExit(cb: (sessionId: string, code: number | undefined) => void): void;
  onPreflight?(cb: (sessionId: string, result: unknown) => void): void;
}

/** Stable per-tile info object surfaced to callbacks and list()/getFocusedInfo(). */
export interface TerminalTileInfo {
  sessionId: string;
  pid: number;
  cwd: string;
  shell: string;
  name: string;
  status: string;
  preflight?: unknown;
}

export interface MultiTerminalControllerOptions {
  grid: unknown;
  api: TerminalApiLike;
  cols: number;
  rows: number;
  repoPath: string;
  onTileFocus?: (info: TerminalTileInfo, entry: unknown) => void;
  onCountChange?: (count: number) => void;
  onOpenComposer?: (info: TerminalTileInfo, tileEl: unknown) => void;
  onSessionExit?: (sessionId: string, code: number | undefined) => void;
  onPreflight?: (sessionId: string, result: unknown, info: TerminalTileInfo) => void;
  buildKeyHandler?: ((opts: unknown) => (event: unknown) => boolean) | null;
  writeClipboard?: ((text: string) => void) | null;
  readClipboard?: (() => string | Promise<string>) | null;
  /** xterm Terminal constructor (defaults to window.Terminal). */
  TerminalCtor?: new (options: unknown) => unknown;
  FitAddonCtor?: (new () => unknown) | null;
  CanvasAddonCtor?: (new () => unknown) | null;
  windowsPty?: unknown;
}

export interface MultiTerminalController {
  addTerminal(): Promise<TerminalTileInfo>;
  closeTerminal(sessionId: string): Promise<void>;
  focusTile(sessionId: string): void;
  unfocusAll(): void;
  getFocusedInfo(): TerminalTileInfo | null;
  getTileElement(sessionId: string): unknown;
  setStatus(sessionId: string, status: string): void;
  count(): number;
  list(): TerminalTileInfo[];
  resizeAll(): void;
}

export interface VibecodeTerminalsModule {
  createMultiTerminalController(options: MultiTerminalControllerOptions): MultiTerminalController;
}

declare global {
  interface Window {
    /** Registered by terminals.js when loaded in a browser/renderer context. */
    VibecodeTerminals?: VibecodeTerminalsModule;
  }
}
