// Tests for the per-terminal scroll rail controller logic.
//
// Protected invariant: scroll state computation and controller lifecycle are
// correct, per-session, and call the terminal scroll API rather than scrolling
// a random DOM wrapper.

import ScrollRail from '../../../src/app/desktop/renderer/scroll_rail.js';

// ---------------------------------------------------------------------------
// Minimal xterm buffer/terminal fakes
// ---------------------------------------------------------------------------

interface FakeBufferOptions {
  baseY?: number;
  viewportY?: number;
  length?: number;
  type?: 'normal' | 'alternate';
}

function fakeBuffer(opts: FakeBufferOptions = {}) {
  return {
    baseY: opts.baseY ?? 0,
    viewportY: opts.viewportY ?? 0,
    length: opts.length ?? 24,
    type: opts.type ?? 'normal',
  };
}

interface FakeTerminalOptions {
  rows?: number;
  buffer?: FakeBufferOptions;
  mouseTrackingMode?: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
}

function fakeTerminal(opts: FakeTerminalOptions = {}) {
  const rows = opts.rows ?? 24;
  const buf = fakeBuffer(opts.buffer);
  const scrollListeners: Array<(y: number) => void> = [];
  return {
    rows,
    buffer: { active: buf },
    // xterm exposes the app's terminal modes; mouseTrackingMode tells us whether
    // a TUI has enabled mouse reporting (e.g. OpenCode), which is informational
    // for the rail.
    modes: { mouseTrackingMode: opts.mouseTrackingMode ?? 'none' },
    onScroll: (cb: (y: number) => void) => {
      scrollListeners.push(cb);
      return { dispose: () => { const i = scrollListeners.indexOf(cb); if (i >= 0) scrollListeners.splice(i, 1); } };
    },
    scrollToBottom: vi.fn(),
    scrollLines: vi.fn(),
    scrollToLine: vi.fn(),
    _fireScroll: (y: number) => { buf.viewportY = y; scrollListeners.forEach((cb) => cb(y)); },
    _scrollListeners: scrollListeners,
  };
}

// ---------------------------------------------------------------------------
// computeScrollState
// ---------------------------------------------------------------------------

describe('computeScrollState', () => {
  test('terminal with no scrollback is at bottom', () => {
    const state = ScrollRail.computeScrollState(fakeBuffer({ baseY: 0, viewportY: 0, length: 24 }), 24);
    expect(state.isAtBottom).toBe(true);
    expect(state.thumbRatio).toBeCloseTo(1);
    expect(state.thumbPosition).toBeCloseTo(0);
  });

  test('terminal with scrollback at bottom reports isAtBottom true', () => {
    const state = ScrollRail.computeScrollState(fakeBuffer({ baseY: 100, viewportY: 100, length: 124 }), 24);
    expect(state.isAtBottom).toBe(true);
  });

  test('terminal scrolled up reports isAtBottom false', () => {
    const state = ScrollRail.computeScrollState(fakeBuffer({ baseY: 100, viewportY: 50, length: 124 }), 24);
    expect(state.isAtBottom).toBe(false);
  });

  test('thumbRatio is viewport/totalRows', () => {
    const state = ScrollRail.computeScrollState(fakeBuffer({ baseY: 100, viewportY: 0, length: 124 }), 24);
    expect(state.thumbRatio).toBeCloseTo(24 / 124);
  });

  test('thumbRatio is clamped to 1 when totalRows <= viewport', () => {
    const state = ScrollRail.computeScrollState(fakeBuffer({ baseY: 0, viewportY: 0, length: 10 }), 24);
    expect(state.thumbRatio).toBe(1);
  });

  test('thumbPosition reflects scroll offset', () => {
    // viewportY=50 out of baseY=100 => position = 50/100 = 0.5
    const state = ScrollRail.computeScrollState(fakeBuffer({ baseY: 100, viewportY: 50, length: 124 }), 24);
    expect(state.thumbPosition).toBeCloseTo(0.5);
  });

  test('thumbPosition is 0 at top of scrollback', () => {
    const state = ScrollRail.computeScrollState(fakeBuffer({ baseY: 100, viewportY: 0, length: 124 }), 24);
    expect(state.thumbPosition).toBeCloseTo(0);
  });

  test('thumbPosition is 1 at bottom', () => {
    const state = ScrollRail.computeScrollState(fakeBuffer({ baseY: 100, viewportY: 100, length: 124 }), 24);
    expect(state.thumbPosition).toBeCloseTo(1);
  });
});

// ---------------------------------------------------------------------------
// createScrollRailController
// ---------------------------------------------------------------------------

describe('createScrollRailController', () => {
  test('getState returns current scroll state', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 50, viewportY: 50, length: 74 } });
    const ctrl = ScrollRail.createScrollRailController(term);
    const state = ctrl.getState();
    expect(state.isAtBottom).toBe(true);
    expect(state.totalRows).toBe(74);
    ctrl.dispose();
  });

  test('scrollToBottom calls terminal.scrollToBottom', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 50, viewportY: 20, length: 74 } });
    const ctrl = ScrollRail.createScrollRailController(term);
    ctrl.scrollToBottom();
    expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
    ctrl.dispose();
  });

  test('scrollLines calls terminal.scrollLines', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 50, viewportY: 25, length: 74 } });
    const ctrl = ScrollRail.createScrollRailController(term);
    ctrl.scrollLines(5);
    expect(term.scrollLines).toHaveBeenCalledWith(5);
    ctrl.dispose();
  });

  test('scrollToRatio calls terminal.scrollLines to move to the correct position', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 100, viewportY: 50, length: 124 } });
    const ctrl = ScrollRail.createScrollRailController(term);
    ctrl.scrollToRatio(0.75);
    // target line = 0.75 * 100 = 75, current viewportY = 50, delta = 25
    expect(term.scrollLines).toHaveBeenCalledWith(25);
    ctrl.dispose();
  });

  test('onStateChange fires when terminal scrolls', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 100, viewportY: 100, length: 124 } });
    const ctrl = ScrollRail.createScrollRailController(term);
    const listener = vi.fn();
    ctrl.onStateChange(listener);
    term._fireScroll(50);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].isAtBottom).toBe(false);
    ctrl.dispose();
  });

  test('dispose unsubscribes from terminal scroll events', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 100, viewportY: 100, length: 124 } });
    const ctrl = ScrollRail.createScrollRailController(term);
    const listener = vi.fn();
    ctrl.onStateChange(listener);
    ctrl.dispose();
    term._fireScroll(50);
    expect(listener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-session isolation
// ---------------------------------------------------------------------------

describe('per-session isolation', () => {
  test('two controllers on different terminals have independent state', () => {
    const termA = fakeTerminal({ rows: 24, buffer: { baseY: 100, viewportY: 100, length: 124 } });
    const termB = fakeTerminal({ rows: 24, buffer: { baseY: 50, viewportY: 0, length: 74 } });
    const ctrlA = ScrollRail.createScrollRailController(termA);
    const ctrlB = ScrollRail.createScrollRailController(termB);

    expect(ctrlA.getState().isAtBottom).toBe(true);
    expect(ctrlB.getState().isAtBottom).toBe(false);

    ctrlA.scrollToBottom();
    expect(termA.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(termB.scrollToBottom).not.toHaveBeenCalled();

    ctrlA.dispose();
    ctrlB.dispose();
  });

  test('scrolling terminal A does not fire stateChange on terminal B', () => {
    const termA = fakeTerminal({ rows: 24, buffer: { baseY: 100, viewportY: 100, length: 124 } });
    const termB = fakeTerminal({ rows: 24, buffer: { baseY: 50, viewportY: 50, length: 74 } });
    const ctrlA = ScrollRail.createScrollRailController(termA);
    const ctrlB = ScrollRail.createScrollRailController(termB);

    const listenerA = vi.fn();
    const listenerB = vi.fn();
    ctrlA.onStateChange(listenerA);
    ctrlB.onStateChange(listenerB);

    termA._fireScroll(50);
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();

    ctrlA.dispose();
    ctrlB.dispose();
  });
});

// ---------------------------------------------------------------------------
// Alternate-screen (full-screen TUI) detection
// ---------------------------------------------------------------------------
// Protected invariant: the rail must KNOW when the active buffer is the
// alternate screen, because xterm.js keeps no scrollback there. Callers use
// this to degrade gracefully (visible-but-disabled) instead of pretending to
// scroll a buffer that has no history.

describe('alternate-screen detection', () => {
  test('normal buffer reports isAlt false', () => {
    const state = ScrollRail.computeScrollState(fakeBuffer({ baseY: 50, viewportY: 0, length: 74 }), 24);
    expect(state.isAlt).toBe(false);
  });

  test('alternate buffer reports isAlt true', () => {
    const state = ScrollRail.computeScrollState(
      fakeBuffer({ baseY: 0, viewportY: 0, length: 24, type: 'alternate' }),
      24,
    );
    expect(state.isAlt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scroll mode (scrollback vs TUI/alternate-screen)
// ---------------------------------------------------------------------------
// Protected invariant: the rail must distinguish normal scrollback mode from
// full-screen TUI / alternate-screen mode, because the two are driven through
// completely different mechanisms (xterm scrollback APIs vs forwarded wheel
// input) and the TUI mode cannot know the app's exact scroll position. This is
// tested at the state layer, independent of any DOM styling.

describe('scroll mode', () => {
  test('normal buffer is scrollback mode with a determinate position', () => {
    const state = ScrollRail.computeScrollState(fakeBuffer({ baseY: 50, viewportY: 0, length: 74 }), 24);
    expect(state.mode).toBe('scrollback');
    expect(state.indeterminate).toBe(false);
  });

  test('alternate buffer is tui mode with an indeterminate position', () => {
    const state = ScrollRail.computeScrollState(
      fakeBuffer({ baseY: 0, viewportY: 0, length: 24, type: 'alternate' }),
      24,
    );
    expect(state.mode).toBe('tui');
    expect(state.indeterminate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mouse-tracking detection
// ---------------------------------------------------------------------------
// Protected invariant: the controller surfaces whether the running app has
// enabled mouse reporting. This is read from xterm's public modes API, not
// inferred, and must default to false when the buffer is a plain shell.

describe('mouse-tracking detection', () => {
  test('reflects an enabled mouseTrackingMode', () => {
    const term = fakeTerminal({ buffer: { type: 'alternate' }, mouseTrackingMode: 'any' });
    const ctrl = ScrollRail.createScrollRailController(term, { sendWheel: vi.fn() });
    expect(ctrl.getState().mouseTracking).toBe(true);
    ctrl.dispose();
  });

  test('is false for a plain shell with no mouse tracking', () => {
    const term = fakeTerminal();
    const ctrl = ScrollRail.createScrollRailController(term, { sendWheel: vi.fn() });
    expect(ctrl.getState().mouseTracking).toBe(false);
    ctrl.dispose();
  });
});

// ---------------------------------------------------------------------------
// Action routing: scrollback mode
// ---------------------------------------------------------------------------
// Protected invariant: in normal scrollback mode every rail action drives the
// real xterm scrollback through xterm's scroll API — never through forwarded
// wheel input.

describe('scrollback action routing', () => {
  function term() {
    return fakeTerminal({ rows: 24, buffer: { baseY: 100, viewportY: 50, length: 124 } });
  }

  test('wheelLikeDown scrolls the real buffer and does not forward wheel input', () => {
    const t = term();
    const sendWheel = vi.fn();
    const ctrl = ScrollRail.createScrollRailController(t, { sendWheel });
    ctrl.wheelLikeDown();
    expect(t.scrollLines).toHaveBeenCalledTimes(1);
    expect(t.scrollLines.mock.calls[0][0]).toBeGreaterThan(0);
    expect(sendWheel).not.toHaveBeenCalled();
    ctrl.dispose();
  });

  test('wheelLikeUp scrolls the real buffer upward', () => {
    const t = term();
    const ctrl = ScrollRail.createScrollRailController(t, { sendWheel: vi.fn() });
    ctrl.wheelLikeUp();
    expect(t.scrollLines).toHaveBeenCalledTimes(1);
    expect(t.scrollLines.mock.calls[0][0]).toBeLessThan(0);
    ctrl.dispose();
  });

  test('scrollToBottom calls the real terminal scroll-to-bottom', () => {
    const t = term();
    const ctrl = ScrollRail.createScrollRailController(t, { sendWheel: vi.fn() });
    ctrl.scrollToBottom();
    expect(t.scrollToBottom).toHaveBeenCalledTimes(1);
    ctrl.dispose();
  });
});

// ---------------------------------------------------------------------------
// Action routing: TUI / alternate-screen mode
// ---------------------------------------------------------------------------
// Protected invariant: in alternate-screen mode there is no xterm scrollback to
// drive, so scroll actions must forward wheel-like input through the terminal
// (the same path real mouse-wheel scrolling uses), and the rail must NOT pretend
// to know the app's exact scroll position.

describe('tui action routing', () => {
  function tuiTerm() {
    return fakeTerminal({ rows: 24, buffer: { baseY: 0, viewportY: 0, length: 24, type: 'alternate' }, mouseTrackingMode: 'any' });
  }

  test('getState reports tui mode and an indeterminate position', () => {
    const ctrl = ScrollRail.createScrollRailController(tuiTerm(), { sendWheel: vi.fn() });
    const s = ctrl.getState();
    expect(s.mode).toBe('tui');
    expect(s.indeterminate).toBe(true);
    ctrl.dispose();
  });

  test('wheelLikeDown forwards a downward wheel notch, never the scrollback API', () => {
    const t = tuiTerm();
    const sendWheel = vi.fn();
    const ctrl = ScrollRail.createScrollRailController(t, { sendWheel });
    ctrl.wheelLikeDown();
    expect(sendWheel).toHaveBeenCalledWith('down');
    expect(t.scrollLines).not.toHaveBeenCalled();
    ctrl.dispose();
  });

  test('wheelLikeUp forwards an upward wheel notch', () => {
    const t = tuiTerm();
    const sendWheel = vi.fn();
    const ctrl = ScrollRail.createScrollRailController(t, { sendWheel });
    ctrl.wheelLikeUp();
    expect(sendWheel).toHaveBeenCalledWith('up');
    expect(t.scrollLines).not.toHaveBeenCalled();
    ctrl.dispose();
  });

  test('pageDown forwards several downward wheel notches, never the scrollback API', () => {
    const t = tuiTerm();
    const sendWheel = vi.fn();
    const ctrl = ScrollRail.createScrollRailController(t, { sendWheel });
    ctrl.pageDown();
    expect(sendWheel.mock.calls.length).toBeGreaterThan(1);
    expect(sendWheel.mock.calls.every((c: unknown[]) => c[0] === 'down')).toBe(true);
    expect(t.scrollLines).not.toHaveBeenCalled();
    ctrl.dispose();
  });

  test('scrollToBottom is a no-op in TUI mode (the bottom is unknowable)', () => {
    const t = tuiTerm();
    const ctrl = ScrollRail.createScrollRailController(t, { sendWheel: vi.fn() });
    ctrl.scrollToBottom();
    expect(t.scrollToBottom).not.toHaveBeenCalled();
    ctrl.dispose();
  });

  test('scrollToRatio is a no-op in TUI mode (the exact position is unknowable)', () => {
    const t = tuiTerm();
    const ctrl = ScrollRail.createScrollRailController(t, { sendWheel: vi.fn() });
    ctrl.scrollToRatio(0.5);
    expect(t.scrollLines).not.toHaveBeenCalled();
    ctrl.dispose();
  });
});

// ---------------------------------------------------------------------------
// Rail DOM styling (mode-driven, no real DOM required)
// ---------------------------------------------------------------------------
// Protected invariant: the rail renders a single control set; in scrollback mode
// it shows a determinate thumb; in TUI mode it stays visible and interactive but
// never paints a fake exact-position thumb. updateScrollRailDom operates on the
// passed element handles, so we can exercise it with lightweight stubs.

interface FakeStyle { [k: string]: string }
function fakeEl() {
  const classes = new Set<string>();
  const attrs: Record<string, string> = {};
  return {
    style: {} as FakeStyle,
    title: '',
    classList: {
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
      toggle: (c: string, on?: boolean) => {
        const next = on === undefined ? !classes.has(c) : on;
        if (next) classes.add(c); else classes.delete(c);
        return next;
      },
      contains: (c: string) => classes.has(c),
    },
    setAttribute: (k: string, v: string) => { attrs[k] = v; },
    removeAttribute: (k: string) => { delete attrs[k]; },
    _classes: classes,
    _attrs: attrs,
  };
}
function fakeRailElements() {
  return { rail: fakeEl(), upBtn: fakeEl(), track: fakeEl(), thumb: fakeEl(), jumpBtn: fakeEl() };
}

describe('updateScrollRailDom styling', () => {
  test('scrollback mode shows one active rail with a determinate thumb', () => {
    const els = fakeRailElements();
    ScrollRail.updateScrollRailDom(els, {
      mode: 'scrollback', indeterminate: false,
      thumbRatio: 0.3, thumbPosition: 0.5, isAtBottom: false, hasNewOutput: false,
    });
    expect(els.rail._classes.has('scroll-rail-active')).toBe(true);
    expect(els.rail._classes.has('scroll-rail-tui')).toBe(false);
    // exact position encoded onto the single thumb
    expect(els.thumb.style.top).toBeTruthy();
    expect(els.thumb.style.height).toBeTruthy();
    // up button is a TUI-only affordance
    expect(els.upBtn.style.display).toBe('none');
  });

  test('TUI mode keeps the rail visible and interactive (not hidden)', () => {
    const els = fakeRailElements();
    ScrollRail.updateScrollRailDom(els, {
      mode: 'tui', indeterminate: true,
      thumbRatio: 1, thumbPosition: 0, isAtBottom: true, hasNewOutput: false,
    });
    expect(els.rail._classes.has('scroll-rail-tui')).toBe(true);
    expect(els.upBtn.style.display).not.toBe('none');
    expect(els.jumpBtn.style.display).not.toBe('none');
  });

  test('TUI mode does not claim an exact scroll position (no positioned thumb)', () => {
    const els = fakeRailElements();
    ScrollRail.updateScrollRailDom(els, {
      mode: 'tui', indeterminate: true,
      thumbRatio: 0.3, thumbPosition: 0.5, isAtBottom: false, hasNewOutput: false,
    });
    expect(els.thumb.style.display).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Single-scrollbar invariant (native xterm scrollbar suppression)
// ---------------------------------------------------------------------------
// Protected invariant: the custom rail must be the ONLY visible right-side
// scroll control. xterm's native viewport scrollbar (xterm.css gives the
// viewport `overflow-y: scroll`) must be suppressed in CSS, scoped to terminal
// tiles, or the duplicate-scrollbar bug returns. Functional, not cosmetic.

describe('single-scrollbar invariant', () => {
  test('styles.css suppresses the native xterm viewport scrollbar inside terminal tiles', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(
      resolve(process.cwd(), 'src/app/desktop/renderer/styles.css'),
      'utf8',
    );
    expect(css).toMatch(/\.xterm-viewport::-webkit-scrollbar/);
    expect(css).toMatch(/scrollbar-width:\s*none/);
  });
});

// ---------------------------------------------------------------------------
// "New output below" indicator
// ---------------------------------------------------------------------------
// Protected invariant: when output arrives while the user is scrolled up, the
// terminal must NOT yank to the bottom, but the rail must signal that there is
// new content below. Returning to the bottom clears the signal.

describe('new output below indicator', () => {
  test('defaults to no new output', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 100, viewportY: 0, length: 124 } });
    const ctrl = ScrollRail.createScrollRailController(term);
    expect(ctrl.getState().hasNewOutput).toBe(false);
    ctrl.dispose();
  });

  test('buffer growth while scrolled up sets hasNewOutput', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 100, viewportY: 0, length: 124 } });
    const ctrl = ScrollRail.createScrollRailController(term);
    // More output streams in, but the viewport stays parked at the top.
    term.buffer.active.length = 140;
    term.buffer.active.baseY = 116;
    term._fireScroll(0);
    expect(ctrl.getState().hasNewOutput).toBe(true);
    ctrl.dispose();
  });

  test('returning to the bottom clears hasNewOutput', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 100, viewportY: 0, length: 124 } });
    const ctrl = ScrollRail.createScrollRailController(term);
    term.buffer.active.length = 140;
    term.buffer.active.baseY = 116;
    term._fireScroll(0);
    expect(ctrl.getState().hasNewOutput).toBe(true);
    term.buffer.active.viewportY = 116;
    term._fireScroll(116);
    expect(ctrl.getState().hasNewOutput).toBe(false);
    ctrl.dispose();
  });

  test('alternate screen never reports new output', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 0, viewportY: 0, length: 24, type: 'alternate' } });
    const ctrl = ScrollRail.createScrollRailController(term);
    term.buffer.active.length = 80;
    term._fireScroll(0);
    expect(ctrl.getState().hasNewOutput).toBe(false);
    ctrl.dispose();
  });
});

// ---------------------------------------------------------------------------
// Page scrolling
// ---------------------------------------------------------------------------
// Protected invariant: page up/down move the real terminal viewport by a
// screenful via the xterm scroll API, not by scrolling a DOM wrapper.

describe('page scrolling', () => {
  test('pageUp scrolls the terminal up by one viewport', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 100, viewportY: 50, length: 124 } });
    const ctrl = ScrollRail.createScrollRailController(term);
    ctrl.pageUp();
    expect(term.scrollLines).toHaveBeenCalledWith(-24);
    ctrl.dispose();
  });

  test('pageDown scrolls the terminal down by one viewport', () => {
    const term = fakeTerminal({ rows: 24, buffer: { baseY: 100, viewportY: 50, length: 124 } });
    const ctrl = ScrollRail.createScrollRailController(term);
    ctrl.pageDown();
    expect(term.scrollLines).toHaveBeenCalledWith(24);
    ctrl.dispose();
  });
});
