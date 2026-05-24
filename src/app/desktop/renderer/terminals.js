// Multi-terminal tile controller for the desktop renderer.
//
// Each tile owns its own xterm.Terminal instance and is bound to a single
// backend PTY session (sessionId). The controller exposes a thin API the
// page script wires up: create tiles, dispatch incoming PTY data by
// sessionId, focus + status updates, and a single shared composer overlay
// that records which tile opened it (originSessionId) so the composer can
// route its final_prompt.md back to that specific terminal.
(function () {
  if (typeof window === 'undefined') return;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function buildTileElement(name) {
    const tile = document.createElement('div');
    tile.className = 'tile overlay-off';
    tile.innerHTML = ''
      + '<div class="tile-head">'
      +   '<div class="tile-session">'
      +     '<span class="tile-name"><span class="at">~/</span><span class="tile-name-text">' + escapeHtml(name) + '</span></span>'
      +     '<span class="status idle tile-status" title="Status"><span class="dot"></span><span class="tile-status-text">idle</span></span>'
      +   '</div>'
      +   '<div class="tile-actions">'
      +     '<button class="btn-prompt tile-open-composer" type="button" title="Compose prompt">'
      +       '<span class="glyph">›_</span>Prompt'
      +     '</button>'
      +     '<button class="icon-btn tile-close" type="button" title="Close terminal">'
      +       '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
      +     '</button>'
      +   '</div>'
      + '</div>'
      + '<div class="term tile-term"></div>';
    return tile;
  }

  function buildPlaceholderElement() {
    const placeholder = document.createElement('div');
    placeholder.className = 'tile placeholder-tile';
    placeholder.innerHTML = ''
      + '<div class="tile-head">'
      +   '<div class="tile-session"><span class="tile-name"><span class="at">~/</span><span>none</span></span></div>'
      + '</div>'
      + '<div class="term placeholder-body">'
      +   '<button class="btn primary placeholder-start" type="button">Start terminal</button>'
      + '</div>';
    return placeholder;
  }

  function createMultiTerminalController(options) {
    const grid = options.grid;
    const api = options.api;
    const cols = options.cols;
    const rows = options.rows;
    const repoPath = options.repoPath;
    const onTileFocus = options.onTileFocus || function () {};
    const onCountChange = options.onCountChange || function () {};
    const onOpenComposer = options.onOpenComposer || function () {};
    const onSessionExit = options.onSessionExit || function () {};
    const buildKeyHandler = options.buildKeyHandler || null;
    const writeClipboard = options.writeClipboard || null;
    const TerminalCtor = options.TerminalCtor || window.Terminal;

    const tiles = new Map(); // sessionId -> { tile, term, name, statusEl, statusTextEl, nameEl, info }
    let nextLocalIndex = 0;
    let focusedSessionId = null;
    let placeholderEl = null;

    function ensurePlaceholder() {
      if (tiles.size > 0) {
        if (placeholderEl && placeholderEl.parentNode) {
          placeholderEl.parentNode.removeChild(placeholderEl);
        }
        placeholderEl = null;
        return;
      }
      if (placeholderEl) return;
      placeholderEl = buildPlaceholderElement();
      const startBtn = placeholderEl.querySelector('.placeholder-start');
      if (startBtn) startBtn.addEventListener('click', () => { void addTerminal(); });
      grid.appendChild(placeholderEl);
    }

    function nextName() {
      nextLocalIndex += 1;
      return nextLocalIndex === 1 ? 'main' : 'term-' + nextLocalIndex;
    }

    function focusTile(sessionId) {
      focusedSessionId = sessionId;
      for (const [id, entry] of tiles) {
        entry.tile.classList.toggle('focus', id === sessionId);
      }
      const entry = tiles.get(sessionId);
      if (entry) {
        try { entry.term.focus(); } catch (_e) { /* xterm may not be attached yet */ }
        onTileFocus(entry.info, entry);
      }
    }

    function setTileStatus(sessionId, status) {
      const entry = tiles.get(sessionId);
      if (!entry) return;
      entry.info.status = status;
      entry.statusEl.className = 'status tile-status ' + status;
      entry.statusTextEl.textContent = status;
    }

    function dispatchData(sessionId, data) {
      const entry = tiles.get(sessionId);
      if (!entry) return;
      entry.term.write(data);
    }

    function dispatchExit(sessionId, code) {
      const entry = tiles.get(sessionId);
      if (!entry) return;
      setTileStatus(sessionId, 'exited');
      // Keep the dead tile visible briefly so the user sees the final output,
      // then drop it from the grid.
      removeTile(sessionId);
      onSessionExit(sessionId, code);
      onCountChange(tiles.size);
      ensurePlaceholder();
    }

    function removeTile(sessionId) {
      const entry = tiles.get(sessionId);
      if (!entry) return;
      if (entry.tile.parentNode) entry.tile.parentNode.removeChild(entry.tile);
      try { entry.term.dispose(); } catch (_e) { /* best-effort */ }
      tiles.delete(sessionId);
      if (focusedSessionId === sessionId) {
        focusedSessionId = null;
        const next = tiles.keys().next();
        if (!next.done) focusTile(next.value);
      }
    }

    async function closeTerminal(sessionId) {
      if (!sessionId || !tiles.has(sessionId)) return;
      try {
        await api.close(sessionId);
      } catch (_e) {
        // Exit handler will reconcile state regardless.
      }
      // If the backend exit event has not fired yet, drop the tile locally now
      // so the UI does not pretend the dead session is still there.
      if (tiles.has(sessionId)) {
        removeTile(sessionId);
        onSessionExit(sessionId, undefined);
        onCountChange(tiles.size);
        ensurePlaceholder();
      }
    }

    async function addTerminal() {
      if (placeholderEl && placeholderEl.parentNode) {
        placeholderEl.parentNode.removeChild(placeholderEl);
        placeholderEl = null;
      }
      const name = nextName();
      const tileEl = buildTileElement(name);
      const termHost = tileEl.querySelector('.tile-term');
      const statusEl = tileEl.querySelector('.tile-status');
      const statusTextEl = tileEl.querySelector('.tile-status-text');
      const nameEl = tileEl.querySelector('.tile-name-text');
      const closeBtn = tileEl.querySelector('.tile-close');
      const openComposerBtn = tileEl.querySelector('.tile-open-composer');
      grid.appendChild(tileEl);

      const term = new TerminalCtor({
        cols,
        rows,
        cursorBlink: true,
        convertEol: true,
        fontFamily: 'Cascadia Code, Consolas, ui-monospace, monospace',
        fontSize: 12.5,
        theme: { background: '#0c0c0e', foreground: '#d8d8de' },
      });
      term.open(termHost);

      if (buildKeyHandler && writeClipboard) {
        try {
          term.attachCustomKeyEventHandler(buildKeyHandler({ terminal: term, writeClipboard }));
        } catch (_e) {
          // Custom key handling is best-effort; do not block tile creation.
        }
      }

      let session;
      try {
        session = await api.start(repoPath, cols, rows);
      } catch (error) {
        if (tileEl.parentNode) tileEl.parentNode.removeChild(tileEl);
        try { term.dispose(); } catch (_e) { /* ignore */ }
        ensurePlaceholder();
        throw error;
      }

      const info = {
        sessionId: session.sessionId,
        pid: session.pid,
        cwd: session.cwd,
        shell: session.shell,
        name,
        status: 'running',
      };
      tiles.set(session.sessionId, {
        tile: tileEl,
        term,
        name,
        statusEl,
        statusTextEl,
        nameEl,
        info,
      });

      term.onData((data) => api.write(session.sessionId, data));
      tileEl.addEventListener('mousedown', () => focusTile(session.sessionId));
      closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void closeTerminal(session.sessionId);
      });
      openComposerBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        focusTile(session.sessionId);
        onOpenComposer(info, tileEl);
      });

      setTileStatus(session.sessionId, 'running');
      focusTile(session.sessionId);
      onCountChange(tiles.size);
      return info;
    }

    function getFocusedInfo() {
      if (focusedSessionId == null) return null;
      const entry = tiles.get(focusedSessionId);
      return entry ? entry.info : null;
    }

    function getTileElement(sessionId) {
      const entry = tiles.get(sessionId);
      return entry ? entry.tile : null;
    }

    function setStatus(sessionId, status) {
      setTileStatus(sessionId, status);
    }

    function count() {
      return tiles.size;
    }

    function list() {
      const out = [];
      for (const entry of tiles.values()) out.push(entry.info);
      return out;
    }

    function resizeAll() {
      for (const entry of tiles.values()) {
        try { api.resize(entry.info.sessionId, cols, rows); } catch (_e) { /* best-effort */ }
      }
    }

    // Wire up backend events once; controller dispatches by sessionId.
    api.onData((sessionId, data) => dispatchData(sessionId, data));
    api.onExit((sessionId, code) => dispatchExit(sessionId, code));

    ensurePlaceholder();

    return {
      addTerminal,
      closeTerminal,
      focusTile,
      getFocusedInfo,
      getTileElement,
      setStatus,
      count,
      list,
      resizeAll,
    };
  }

  window.VibecodeTerminals = { createMultiTerminalController };
})();
