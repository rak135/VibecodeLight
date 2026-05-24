/*
 * Selection-aware copy for the embedded xterm terminal (renderer-side, plain JS).
 *
 * The default xterm behavior forwards Ctrl+C straight to the PTY as ^C, so the
 * user can never copy selected output. This module decides, per keystroke,
 * whether Ctrl+C / Ctrl+Shift+C should copy the current terminal selection or
 * fall through to the normal interrupt. It owns no terminal/PTY logic: the
 * actual clipboard write is injected (the renderer wires it to the existing
 * Electron clipboard preload path) and the selection is read from the live
 * xterm instance via its public hasSelection()/getSelection() API.
 *
 * It is loadable directly in the browser via a <script src> tag (CSP 'self') and
 * is also importable in Node tests (CommonJS export) so the pure key decision
 * and the handler can be unit tested without xterm or a DOM.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VibecodeTerminalKeys = api;
  }
})(
  typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this,
  function () {
    'use strict';

    // Pure, DOM-free decision for what a Ctrl+C / Ctrl+Shift+C / Ctrl+V /
    // Ctrl+Shift+V keystroke should do given whether the terminal currently has
    // a selection:
    //   'copy'        copy the selection; do NOT forward ^C to the PTY
    //   'paste'       paste the clipboard into the terminal; do NOT forward ^V
    //   'passthrough' let the terminal handle the key normally (Ctrl+C => ^C)
    //   'noop'        swallow the key with no side effect
    function decideTerminalCopyAction(event, hasSelection) {
      var e = event || {};
      // The xterm custom handler also fires for keyup; only act on keydown so a
      // single press never copies/pastes twice.
      if (e.type && e.type !== 'keydown') {
        return { type: 'passthrough' };
      }
      var key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
      // Paste: Ctrl+V and Ctrl+Shift+V. Left alone, xterm turns Ctrl+V into the
      // ^V (0x16) control byte and calls preventDefault on the keydown, which
      // also suppresses the browser's native paste event — so nothing ever
      // reaches the PTY. We intercept and paste the clipboard explicitly.
      if (key === 'v' && e.ctrlKey) {
        return { type: 'paste' };
      }
      if (key !== 'c' || !e.ctrlKey) {
        return { type: 'passthrough' };
      }
      if (e.shiftKey) {
        // Ctrl+Shift+C is an explicit copy shortcut: copy when there is text,
        // otherwise do nothing (it must never emit ^C or other side effects).
        return hasSelection ? { type: 'copy' } : { type: 'noop' };
      }
      // Plain Ctrl+C copies only when text is selected; with no selection it
      // must keep working as the interrupt for the running process/agent.
      return hasSelection ? { type: 'copy' } : { type: 'passthrough' };
    }

    // Build the callback for xterm's `attachCustomKeyEventHandler`. Returning
    // false stops xterm from emitting the keystroke (so the renderer's onData
    // bridge never forwards ^C to the PTY); returning true lets the terminal
    // process the key normally.
    function createTerminalKeyHandler(opts) {
      var terminal = opts.terminal;
      var writeClipboard = opts.writeClipboard;
      var readClipboard = opts.readClipboard;
      return function handleKey(event) {
        var action = decideTerminalCopyAction(event, Boolean(terminal.hasSelection()));
        if (action.type === 'paste') {
          // Block xterm's default so it cannot emit ^V or swallow the native
          // paste event before we run our own clipboard read.
          if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
          }
          if (typeof readClipboard === 'function' && typeof terminal.paste === 'function') {
            // terminal.paste() routes through xterm's onData, so the pasted text
            // is forwarded to the PTY by the same bridge as normal typing and it
            // honours bracketed-paste mode. The reader may be sync (tests) or a
            // Promise (the real Electron clipboard bridge); support both and
            // never let a clipboard failure crash the renderer or send ^V.
            try {
              var pending = readClipboard();
              if (pending && typeof pending.then === 'function') {
                pending.then(function (text) {
                  if (text) {
                    try { terminal.paste(String(text)); } catch (_error) { /* best-effort */ }
                  }
                }).catch(function () { /* clipboard unavailable; ignore */ });
              } else if (pending) {
                terminal.paste(String(pending));
              }
            } catch (_error) {
              // A synchronous clipboard failure must never fall through to ^V.
            }
          }
          return false;
        }
        if (action.type === 'copy') {
          // Prevent the browser's native copy so it cannot overwrite the
          // clipboard with the (empty) DOM selection after we write the
          // terminal text ourselves.
          if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
          }
          var selection = terminal.getSelection();
          if (selection) {
            try {
              writeClipboard(selection);
            } catch (_error) {
              // A clipboard failure must never crash the renderer or fall
              // through to sending ^C; swallow it and leave the selection alone.
            }
          }
          return false;
        }
        if (action.type === 'noop') {
          return false;
        }
        return true;
      };
    }

    return {
      decideTerminalCopyAction: decideTerminalCopyAction,
      createTerminalKeyHandler: createTerminalKeyHandler,
    };
  },
);
