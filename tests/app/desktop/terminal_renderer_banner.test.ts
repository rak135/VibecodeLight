// Renderer-level proof that the desktop terminal tile controller DISPLAYS the
// one-time agent protocol banner (Phase 1B-4) exactly once.
//
// Protected invariant: src/app/desktop/renderer/terminals.js must write
// `session.banner` to its xterm instance exactly once — when the tile is created
// — with CRLF-normalized line endings, and must NEVER duplicate it on later
// terminal data events nor route it through the PTY input path (api.write).
// If the renderer stopped consuming `session.banner`, wrote it twice, or piped it
// into the shell, this test fails.
//
// This COMPLEMENTS (does not duplicate) terminal_banner.test.ts, which pins the
// SERVICE side (start metadata carries the banner; the PTY stays clean). Here we
// drive the REAL renderer controller with a fake xterm + fake preload API and
// assert the DISPLAY behavior end to end.
//
// terminals.js is a browser IIFE (`window.VibecodeTerminals = ...`). The default
// vitest environment is node and jsdom is not a dependency, so we install a
// minimal fake window/document before importing it. This exercises the real
// controller logic (tile creation, banner write decision, data dispatch wiring)
// with lightweight DOM stubs rather than adding a jsdom dependency.

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal DOM stubs — just enough surface for the tile controller
// ---------------------------------------------------------------------------

interface FakeEl {
  className: string;
  textContent: string;
  innerHTML: string;
  parentNode: FakeEl | null;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, on?: boolean): boolean;
    contains(c: string): boolean;
  };
  appendChild(child: FakeEl): FakeEl;
  removeChild(child: FakeEl): void;
  addEventListener(type: string, cb: (...args: unknown[]) => void): void;
  querySelector(sel: string): FakeEl;
  _q: Map<string, FakeEl>;
}

function makeFakeEl(): FakeEl {
  const classes = new Set<string>();
  const el: FakeEl = {
    className: '',
    textContent: '',
    innerHTML: '',
    parentNode: null,
    classList: {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : on;
        if (next) classes.add(c); else classes.delete(c);
        return next;
      },
      contains: (c) => classes.has(c),
    },
    appendChild(child) { child.parentNode = el; return child; },
    removeChild(child) { if (child.parentNode === el) child.parentNode = null; },
    addEventListener() {},
    // The controller queries innerHTML-built children by class. We ignore the
    // markup and hand back a stable synthetic element per selector — enough for
    // the controller to attach handlers / set status text.
    querySelector(sel) {
      let found = el._q.get(sel);
      if (!found) { found = makeFakeEl(); el._q.set(sel, found); }
      return found;
    },
    _q: new Map(),
  };
  return el;
}

// ---------------------------------------------------------------------------
// Fake xterm terminal — records every write() the renderer makes
// ---------------------------------------------------------------------------

interface FakeTerminal {
  rows: number;
  cols: number;
  writes: string[];
  onDataCb: ((data: string) => void) | null;
  loadAddon(): void;
  open(): void;
  focus(): void;
  refresh(): void;
  dispose(): void;
  write(text: string, cb?: () => void): void;
  onData(cb: (data: string) => void): void;
  attachCustomKeyEventHandler(): void;
}

function makeTerminalCtor(instances: FakeTerminal[]): new (opts: { rows?: number; cols?: number }) => FakeTerminal {
  return class {
    rows: number;
    cols: number;
    writes: string[] = [];
    onDataCb: ((data: string) => void) | null = null;
    constructor(opts: { rows?: number; cols?: number }) {
      this.rows = opts.rows ?? 24;
      this.cols = opts.cols ?? 80;
      instances.push(this as unknown as FakeTerminal);
    }
    loadAddon() {}
    open() {}
    focus() {}
    refresh() {}
    dispose() {}
    write(text: string, cb?: () => void) {
      this.writes.push(text);
      // dispatchData passes a post-write callback (forces a viewport refresh);
      // honor it so the real code path runs to completion.
      if (typeof cb === 'function') cb();
    }
    onData(cb: (data: string) => void) {
      this.onDataCb = cb;
    }
    attachCustomKeyEventHandler() {}
  } as unknown as new (opts: { rows?: number; cols?: number }) => FakeTerminal;
}

// ---------------------------------------------------------------------------
// Controller harness
// ---------------------------------------------------------------------------

const BANNER_BODY = [
  'Vibecode agent protocol — do this first in a new terminal:',
  '1. Orient: vibecode session bootstrap --register --agent-mode <read_only|build> --json',
  '2. Pick tools by profile: vibecode tools profile --json',
].join('\n');

const BANNER_MARKER = 'Vibecode agent protocol';

type Controller = {
  addTerminal(): Promise<{ sessionId: string }>;
};

interface Harness {
  controller: Controller;
  terminals: FakeTerminal[];
  apiStart: ReturnType<typeof vi.fn>;
  apiWrite: ReturnType<typeof vi.fn>;
  /** Simulate a backend PTY data event (renderer-inbound, display only). */
  emitBackendData(sessionId: string, data: string): void;
}

let createController: (options: Record<string, unknown>) => Controller;

function buildHarness(session: Record<string, unknown>): Harness {
  const terminals: FakeTerminal[] = [];
  const grid = makeFakeEl();
  let backendData: ((sessionId: string, data: string) => void) | null = null;

  const apiStart = vi.fn(async () => session);
  const apiWrite = vi.fn();
  const api = {
    start: apiStart,
    write: apiWrite,
    resize: vi.fn(),
    close: vi.fn(async () => {}),
    onData: (cb: (sessionId: string, data: string) => void) => { backendData = cb; },
    onExit: () => {},
  };

  const controller = createController({
    grid,
    api,
    cols: 80,
    rows: 24,
    repoPath: '/repo',
    TerminalCtor: makeTerminalCtor(terminals),
  }) as Controller;

  return {
    controller,
    terminals,
    apiStart,
    apiWrite,
    emitBackendData: (sessionId, data) => {
      if (!backendData) throw new Error('api.onData was never wired by the controller');
      backendData(sessionId, data);
    },
  };
}

beforeAll(async () => {
  // terminals.js bails out unless a window exists; install minimal globals first.
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
  (globalThis as unknown as { document: { createElement: () => FakeEl; addEventListener: () => void } }).document = {
    createElement: () => makeFakeEl(),
    // The controller registers a document-level mousedown listener (unfocus on
    // outside click); the banner tests never dispatch it, so a no-op suffices.
    addEventListener: () => {},
  };
  await import('../../../src/app/desktop/renderer/terminals.js');
  const reg = (globalThis as unknown as { window: { VibecodeTerminals?: { createMultiTerminalController: (o: Record<string, unknown>) => Controller } } }).window;
  if (!reg.VibecodeTerminals) throw new Error('terminals.js did not register window.VibecodeTerminals');
  createController = reg.VibecodeTerminals.createMultiTerminalController;
});

afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { document?: unknown }).document;
});

describe('renderer displays the agent protocol banner once', () => {
  test('writes session.banner to xterm exactly once, CRLF-normalized, never to the PTY', async () => {
    const session = { sessionId: 'sess-1', pid: 4242, cwd: '/repo', shell: 'pwsh', banner: BANNER_BODY };
    const h = buildHarness(session);

    await h.controller.addTerminal();

    expect(h.apiStart).toHaveBeenCalledTimes(1);
    expect(h.terminals).toHaveLength(1);
    const term = h.terminals[0]!;

    // Exactly one write carries the banner.
    const bannerWrites = term.writes.filter((w) => w.includes(BANNER_MARKER));
    expect(bannerWrites).toHaveLength(1);

    // CRLF normalization: the core banner ships with \n; the renderer converts to
    // \r\n for xterm. The banner-bearing write must contain the CRLF-joined body
    // and must not contain a bare LF.
    const written = bannerWrites[0]!;
    expect(written).toContain('in a new terminal:\r\n1. Orient');
    expect(written).toMatch(/\r\n/);
    expect(written).not.toMatch(/[^\r]\n/);

    // The display must equal the CRLF-normalized metadata banner (the renderer
    // consumes session.banner — it does not invent its own text).
    expect(written).toContain(BANNER_BODY.replace(/\r?\n/g, '\r\n'));

    // DISPLAY-only: the banner must never be sent through the PTY input path.
    expect(h.apiWrite).not.toHaveBeenCalled();
  });

  test('later terminal data events do not duplicate the banner and write normally', async () => {
    const session = { sessionId: 'sess-2', pid: 4243, cwd: '/repo', shell: 'pwsh', banner: BANNER_BODY };
    const h = buildHarness(session);

    await h.controller.addTerminal();
    const term = h.terminals[0]!;
    const writesAfterCreate = term.writes.length;

    // Backend streams ordinary PTY output after the tile is up.
    h.emitBackendData('sess-2', 'drwxr-xr-x  ordinary listing\r\n');
    h.emitBackendData('sess-2', '$ echo done\r\n');

    // Ordinary data is written to the display...
    expect(term.writes).toContain('drwxr-xr-x  ordinary listing\r\n');
    expect(term.writes).toContain('$ echo done\r\n');
    expect(term.writes.length).toBe(writesAfterCreate + 2);

    // ...and the banner is still present exactly once (no re-emit on data).
    expect(term.writes.filter((w) => w.includes(BANNER_MARKER))).toHaveLength(1);

    // Inbound display data never round-trips into the PTY.
    expect(h.apiWrite).not.toHaveBeenCalled();
  });

  test('no banner write when start metadata omits a banner', async () => {
    const session = { sessionId: 'sess-3', pid: 4244, cwd: '/repo', shell: 'pwsh' };
    const h = buildHarness(session);

    await h.controller.addTerminal();
    const term = h.terminals[0]!;

    // Nothing is written on creation when there is no banner...
    expect(term.writes.filter((w) => w.includes(BANNER_MARKER))).toHaveLength(0);
    expect(term.writes).toHaveLength(0);

    // ...but ordinary terminal output still displays normally.
    h.emitBackendData('sess-3', 'plain output');
    expect(term.writes).toContain('plain output');
    expect(h.apiWrite).not.toHaveBeenCalled();
  });
});
