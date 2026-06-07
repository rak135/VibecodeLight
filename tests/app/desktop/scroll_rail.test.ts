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
}

function fakeTerminal(opts: FakeTerminalOptions = {}) {
  const rows = opts.rows ?? 24;
  const buf = fakeBuffer(opts.buffer);
  const scrollListeners: Array<(y: number) => void> = [];
  return {
    rows,
    buffer: { active: buf },
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
