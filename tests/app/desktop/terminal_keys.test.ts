import TerminalKeys from '../../../src/app/desktop/renderer/terminal_keys.js';

// The terminal copy logic lives in a plain renderer module so it can be unit
// tested without xterm or a DOM. `decideTerminalCopyAction` is the pure key
// decision; `createTerminalKeyHandler` builds the xterm
// `attachCustomKeyEventHandler` callback whose boolean return controls whether
// the keystroke reaches the PTY (true) or is swallowed (false).

interface KeyEventLike {
  type?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  key?: string;
  preventDefault?: () => void;
}

function keyEvent(overrides: KeyEventLike = {}): KeyEventLike {
  return {
    type: 'keydown',
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    key: '',
    preventDefault: () => {},
    ...overrides,
  };
}

function makeTerminal(selection: string): { hasSelection(): boolean; getSelection(): string } {
  return {
    hasSelection: () => selection.length > 0,
    getSelection: () => selection,
  };
}

describe('decideTerminalCopyAction', () => {
  test('Ctrl+C with a selection chooses copy', () => {
    const action = TerminalKeys.decideTerminalCopyAction(keyEvent({ ctrlKey: true, key: 'c' }), true);
    expect(action.type).toBe('copy');
  });

  test('Ctrl+C without a selection passes through so the terminal sends interrupt', () => {
    const action = TerminalKeys.decideTerminalCopyAction(keyEvent({ ctrlKey: true, key: 'c' }), false);
    expect(action.type).toBe('passthrough');
  });

  test('Ctrl+Shift+C with a selection chooses copy', () => {
    const action = TerminalKeys.decideTerminalCopyAction(
      keyEvent({ ctrlKey: true, shiftKey: true, key: 'C' }),
      true,
    );
    expect(action.type).toBe('copy');
  });

  test('Ctrl+Shift+C without a selection is a no-op (no confusing side effect)', () => {
    const action = TerminalKeys.decideTerminalCopyAction(
      keyEvent({ ctrlKey: true, shiftKey: true, key: 'C' }),
      false,
    );
    expect(action.type).toBe('noop');
  });

  test('a plain c keystroke passes through', () => {
    const action = TerminalKeys.decideTerminalCopyAction(keyEvent({ key: 'c' }), true);
    expect(action.type).toBe('passthrough');
  });

  test('Ctrl with another key passes through', () => {
    const action = TerminalKeys.decideTerminalCopyAction(keyEvent({ ctrlKey: true, key: 'd' }), true);
    expect(action.type).toBe('passthrough');
  });

  test('only acts on keydown, not keyup', () => {
    const action = TerminalKeys.decideTerminalCopyAction(
      keyEvent({ type: 'keyup', ctrlKey: true, key: 'c' }),
      true,
    );
    expect(action.type).toBe('passthrough');
  });
});

describe('createTerminalKeyHandler', () => {
  test('Ctrl+C with a selection copies the selected text to the clipboard', () => {
    const writeClipboard = vi.fn();
    const handler = TerminalKeys.createTerminalKeyHandler({
      terminal: makeTerminal('echo hello-terminal-copy'),
      writeClipboard,
    });
    handler(keyEvent({ ctrlKey: true, key: 'c' }));
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    expect(writeClipboard).toHaveBeenCalledWith('echo hello-terminal-copy');
  });

  test('Ctrl+C with a selection does not send ^C to the PTY (handler returns false)', () => {
    const handler = TerminalKeys.createTerminalKeyHandler({
      terminal: makeTerminal('echo hello'),
      writeClipboard: vi.fn(),
    });
    expect(handler(keyEvent({ ctrlKey: true, key: 'c' }))).toBe(false);
  });

  test('Ctrl+C without a selection sends interrupt (returns true) and copies nothing', () => {
    const writeClipboard = vi.fn();
    const handler = TerminalKeys.createTerminalKeyHandler({
      terminal: makeTerminal(''),
      writeClipboard,
    });
    expect(handler(keyEvent({ ctrlKey: true, key: 'c' }))).toBe(true);
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  test('Ctrl+Shift+C with a selection copies the selected text', () => {
    const writeClipboard = vi.fn();
    const handler = TerminalKeys.createTerminalKeyHandler({
      terminal: makeTerminal('selected text'),
      writeClipboard,
    });
    handler(keyEvent({ ctrlKey: true, shiftKey: true, key: 'C' }));
    expect(writeClipboard).toHaveBeenCalledWith('selected text');
  });

  test('Ctrl+Shift+C with a selection does not send ^C (returns false)', () => {
    const handler = TerminalKeys.createTerminalKeyHandler({
      terminal: makeTerminal('selected text'),
      writeClipboard: vi.fn(),
    });
    expect(handler(keyEvent({ ctrlKey: true, shiftKey: true, key: 'C' }))).toBe(false);
  });

  test('an empty selection is never copied as fake content', () => {
    const writeClipboard = vi.fn();
    // hasSelection lies true but the selection text is empty.
    const terminal = { hasSelection: () => true, getSelection: () => '' };
    const handler = TerminalKeys.createTerminalKeyHandler({ terminal, writeClipboard });
    handler(keyEvent({ ctrlKey: true, key: 'c' }));
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  test('a clipboard write error is swallowed and does not crash the renderer', () => {
    const writeClipboard = vi.fn(() => {
      throw new Error('clipboard unavailable');
    });
    const handler = TerminalKeys.createTerminalKeyHandler({
      terminal: makeTerminal('boom'),
      writeClipboard,
    });
    expect(() => handler(keyEvent({ ctrlKey: true, key: 'c' }))).not.toThrow();
  });

  test('the copy path prevents the browser default so a native copy cannot clobber the clipboard', () => {
    const preventDefault = vi.fn();
    const handler = TerminalKeys.createTerminalKeyHandler({
      terminal: makeTerminal('text'),
      writeClipboard: vi.fn(),
    });
    handler(keyEvent({ ctrlKey: true, key: 'c', preventDefault }));
    expect(preventDefault).toHaveBeenCalled();
  });
});
