// Per-terminal scroll rail — controller logic and DOM builder.
//
// The controller binds to a single xterm.Terminal instance and exposes
// scroll state + actions. The DOM builder creates the visual rail element.
// Each terminal tile gets its own controller + rail — no shared state.
//
// Alternate-screen / fullscreen TUI limitation: xterm.js exposes the
// alternate buffer's baseY as 0, so the rail thumb fills the track and
// the jump-to-bottom button hides. This is correct graceful degradation —
// alternate-screen apps manage their own viewport and scrollback is not
// meaningful.
(function () {
  if (typeof window === 'undefined') {
    // Node/test environment — export pure logic only.
    if (typeof module !== 'undefined') {
      module.exports = { computeScrollState, createScrollRailController };
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Pure scroll state computation (testable without DOM or xterm)
  // -----------------------------------------------------------------------

  function computeScrollState(buffer, viewportRows) {
    var totalRows = buffer.length;
    var baseY = buffer.baseY;
    var viewportY = buffer.viewportY;
    // xterm.js keeps NO scrollback for the alternate screen buffer: a
    // full-screen TUI (vim, htop, Bubble-Tea apps such as OpenCode) redraws
    // the same viewport every frame, so there is no history to scroll. We
    // surface this so the rail can degrade visibly instead of pretending.
    var isAlt = buffer.type === 'alternate';

    var isAtBottom = viewportY >= baseY;
    var thumbRatio = totalRows <= viewportRows ? 1 : viewportRows / totalRows;
    var thumbPosition = baseY <= 0 ? 0 : viewportY / baseY;

    // Clamp
    if (thumbRatio > 1) thumbRatio = 1;
    if (thumbRatio < 0) thumbRatio = 0;
    if (thumbPosition > 1) thumbPosition = 1;
    if (thumbPosition < 0) thumbPosition = 0;

    return {
      isAlt: isAlt,
      isAtBottom: isAtBottom,
      thumbRatio: thumbRatio,
      thumbPosition: thumbPosition,
      totalRows: totalRows,
      viewportRows: viewportRows,
      baseY: baseY,
      viewportY: viewportY,
      hasNewOutput: false,
    };
  }

  // -----------------------------------------------------------------------
  // Controller — binds to one xterm terminal instance
  // -----------------------------------------------------------------------

  function createScrollRailController(terminal) {
    var listeners = [];
    var disposed = false;
    // Sticky "new output arrived while scrolled up" flag. xterm fires onScroll
    // when the buffer grows (ybase increases) even if the viewport stays put,
    // which is how we detect output below the fold without yanking the view.
    var hasNewOutput = false;
    var lastLength = terminal.buffer.active.length;

    // Recompute the flag from the latest buffer state. Growth while parked
    // above the bottom raises the flag; reaching the bottom clears it; the
    // alternate screen never raises it (no scrollback there).
    function refreshNewOutput(state) {
      if (state.isAlt) {
        hasNewOutput = false;
      } else {
        if (state.totalRows > lastLength && !state.isAtBottom) hasNewOutput = true;
        if (state.isAtBottom) hasNewOutput = false;
      }
      lastLength = state.totalRows;
      state.hasNewOutput = hasNewOutput;
      return state;
    }

    function getState() {
      var state = computeScrollState(terminal.buffer.active, terminal.rows);
      state.hasNewOutput = hasNewOutput;
      return state;
    }

    function scrollToBottom() {
      hasNewOutput = false;
      terminal.scrollToBottom();
    }

    function scrollLines(n) {
      terminal.scrollLines(n);
    }

    function pageUp() {
      terminal.scrollLines(-terminal.rows);
    }

    function pageDown() {
      terminal.scrollLines(terminal.rows);
    }

    function scrollToRatio(ratio) {
      var baseY = terminal.buffer.active.baseY;
      var currentY = terminal.buffer.active.viewportY;
      var targetY = Math.round(ratio * baseY);
      var delta = targetY - currentY;
      if (delta !== 0) terminal.scrollLines(delta);
    }

    function onStateChange(cb) {
      listeners.push(cb);
      return function unsubscribe() {
        var i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    }

    function notifyListeners() {
      if (disposed) return;
      var state = refreshNewOutput(computeScrollState(terminal.buffer.active, terminal.rows));
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](state); } catch (_e) { /* best-effort */ }
      }
    }

    var scrollDisposable = terminal.onScroll(function () {
      notifyListeners();
    });

    function dispose() {
      disposed = true;
      listeners.length = 0;
      if (scrollDisposable && scrollDisposable.dispose) {
        scrollDisposable.dispose();
      }
    }

    return {
      getState: getState,
      scrollToBottom: scrollToBottom,
      scrollLines: scrollLines,
      pageUp: pageUp,
      pageDown: pageDown,
      scrollToRatio: scrollToRatio,
      onStateChange: onStateChange,
      dispose: dispose,
    };
  }

  // -----------------------------------------------------------------------
  // DOM builder — creates the visual rail element for a terminal tile
  // -----------------------------------------------------------------------

  function createScrollRailElement() {
    var rail = document.createElement('div');
    rail.className = 'scroll-rail';
    rail.setAttribute('aria-hidden', 'true');

    var track = document.createElement('div');
    track.className = 'scroll-rail-track';

    var thumb = document.createElement('div');
    thumb.className = 'scroll-rail-thumb';

    var jumpBtn = document.createElement('button');
    jumpBtn.className = 'scroll-rail-jump';
    jumpBtn.type = 'button';
    jumpBtn.title = 'Jump to bottom';
    jumpBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none">'
      + '<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg>';

    track.appendChild(thumb);
    rail.appendChild(track);
    rail.appendChild(jumpBtn);

    return { rail: rail, track: track, thumb: thumb, jumpBtn: jumpBtn };
  }

  function updateScrollRailDom(elements, state) {
    var thumb = elements.thumb;
    var jumpBtn = elements.jumpBtn;
    var rail = elements.rail;

    // Alternate-screen / full-screen TUI: scrollback is not available. Show a
    // dimmed, non-interactive marker (CSS) instead of vanishing, so the user
    // can see the limitation rather than wondering if the rail is broken.
    if (state.isAlt) {
      rail.classList.remove('scroll-rail-active');
      rail.classList.add('scroll-rail-alt');
      rail.title = 'Scrollback is unavailable while a full-screen (alt-screen) program is running';
      thumb.style.height = '100%';
      thumb.style.top = '0';
      jumpBtn.style.display = 'none';
      jumpBtn.classList.remove('scroll-rail-jump-new');
      return;
    }
    rail.classList.remove('scroll-rail-alt');
    rail.removeAttribute('title');

    // Hide rail entirely when there's no scrollback
    var hasScrollback = state.thumbRatio < 1;
    rail.classList.toggle('scroll-rail-active', hasScrollback);

    if (!hasScrollback) {
      thumb.style.height = '100%';
      thumb.style.top = '0';
      jumpBtn.style.display = 'none';
      jumpBtn.classList.remove('scroll-rail-jump-new');
      return;
    }

    // Thumb size and position
    var thumbPct = Math.max(state.thumbRatio * 100, 6); // min height so it stays grabbable
    var maxTop = 100 - thumbPct;
    var topPct = state.thumbPosition * maxTop;

    thumb.style.height = thumbPct + '%';
    thumb.style.top = topPct + '%';

    // Jump-to-bottom visibility + "new output below" emphasis.
    jumpBtn.style.display = state.isAtBottom ? 'none' : 'flex';
    jumpBtn.classList.toggle('scroll-rail-jump-new', !state.isAtBottom && !!state.hasNewOutput);
  }

  // Wire mouse interactions on a rail to a controller
  function bindScrollRailEvents(elements, controller) {
    var track = elements.track;
    var thumb = elements.thumb;
    var jumpBtn = elements.jumpBtn;
    var dragging = false;
    var dragStartY = 0;
    var dragStartThumbTop = 0;

    jumpBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      controller.scrollToBottom();
    });

    // Track click — page towards the click, like a native scrollbar gutter:
    // clicking above the thumb pages up, below it pages down.
    track.addEventListener('mousedown', function (e) {
      if (e.target === thumb || thumb.contains(e.target)) return; // thumb drag handled separately
      e.stopPropagation();
      e.preventDefault();
      var thumbRect = thumb.getBoundingClientRect();
      if (e.clientY < thumbRect.top) controller.pageUp();
      else controller.pageDown();
    });

    // Thumb drag
    thumb.addEventListener('mousedown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      dragStartY = e.clientY;
      dragStartThumbTop = parseFloat(thumb.style.top) || 0;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';
    });

    function onMouseMove(e) {
      if (!dragging) return;
      var trackRect = track.getBoundingClientRect();
      var trackHeight = trackRect.height;
      if (trackHeight <= 0) return;
      var thumbHeightPct = parseFloat(thumb.style.height) || 5;
      var maxTop = 100 - thumbHeightPct;
      var deltaY = e.clientY - dragStartY;
      var deltaPct = (deltaY / trackHeight) * 100;
      var newTop = Math.max(0, Math.min(maxTop, dragStartThumbTop + deltaPct));
      var ratio = maxTop > 0 ? newTop / maxTop : 0;
      controller.scrollToRatio(ratio);
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return function unbind() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }

  // -----------------------------------------------------------------------
  // High-level: attach a scroll rail to a terminal tile
  // -----------------------------------------------------------------------

  function attachScrollRail(termContainer, controller) {
    var elements = createScrollRailElement();
    termContainer.appendChild(elements.rail);

    var unbindEvents = bindScrollRailEvents(elements, controller);

    // Initial render
    updateScrollRailDom(elements, controller.getState());

    // Live updates
    var unsubscribe = controller.onStateChange(function (state) {
      updateScrollRailDom(elements, state);
    });

    return {
      element: elements.rail,
      dispose: function () {
        unsubscribe();
        unbindEvents();
        if (elements.rail.parentNode) {
          elements.rail.parentNode.removeChild(elements.rail);
        }
      },
    };
  }

  window.VibecodeScrollRail = {
    computeScrollState: computeScrollState,
    createScrollRailController: createScrollRailController,
    createScrollRailElement: createScrollRailElement,
    updateScrollRailDom: updateScrollRailDom,
    bindScrollRailEvents: bindScrollRailEvents,
    attachScrollRail: attachScrollRail,
  };
})();
