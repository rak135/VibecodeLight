// Per-terminal scroll rail — controller logic and DOM builder.
//
// The controller binds to a single xterm.Terminal instance and exposes scroll
// state + actions. The DOM builder creates the visual rail element. Each
// terminal tile gets its own controller + rail — no shared state.
//
// Two scroll worlds, two strategies:
//
//   scrollback mode (normal buffer): the rail mirrors xterm's real scrollback.
//     It reads ybase/ydisp from the buffer and drives the viewport through the
//     xterm scroll API (scrollLines / scrollToBottom). The thumb shows the exact
//     position.
//
//   tui mode (alternate buffer): a full-screen TUI (vim, htop, Bubble-Tea apps
//     such as OpenCode) redraws the same viewport every frame and keeps NO xterm
//     scrollback, so the xterm scroll API does nothing useful. These apps scroll
//     their OWN content in response to mouse-wheel input: xterm encodes the wheel
//     as a mouse escape sequence (mouse-tracking apps) or as arrow keys (plain
//     pagers) and sends it to the PTY. The rail reproduces that input by
//     dispatching a synthetic `wheel` event on the xterm root element — exactly
//     the node and event xterm's own wheel handler listens on — so the app
//     scrolls just as if the user had used a real wheel. The rail CANNOT know the
//     app's internal scroll position, so it shows an indeterminate state instead
//     of a fake exact thumb, and jump-to-bottom / drag-to-position are disabled.
(function () {
  // -----------------------------------------------------------------------
  // Pure scroll state computation (testable without DOM or xterm)
  // -----------------------------------------------------------------------

  function computeScrollState(buffer, viewportRows) {
    var totalRows = buffer.length;
    var baseY = buffer.baseY;
    var viewportY = buffer.viewportY;
    // xterm.js keeps NO scrollback for the alternate screen buffer, so when it
    // is active we are in TUI mode: position is unknowable and actions must be
    // forwarded as wheel input rather than driven through the scroll API.
    var isAlt = buffer.type === 'alternate';
    var mode = isAlt ? 'tui' : 'scrollback';

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
      mode: mode,
      // In TUI mode the app owns its scroll position; the rail must not pretend
      // to know it. Callers render an indeterminate rail when this is true.
      indeterminate: isAlt,
      isAtBottom: isAtBottom,
      thumbRatio: thumbRatio,
      thumbPosition: thumbPosition,
      totalRows: totalRows,
      viewportRows: viewportRows,
      baseY: baseY,
      viewportY: viewportY,
      // Whether the running app has enabled mouse reporting. Filled in by the
      // controller (read from xterm's public modes API); informational only.
      mouseTracking: false,
      hasNewOutput: false,
    };
  }

  // -----------------------------------------------------------------------
  // Wheel forwarding — reproduce real mouse-wheel input for TUI mode
  // -----------------------------------------------------------------------
  //
  // Builds the default browser wheel sender. It dispatches a synthetic `wheel`
  // event on `terminal.element` (the `.xterm` root), which is the exact element
  // xterm binds its wheel handler to. xterm then does whatever a real wheel
  // would: forward a mouse escape to mouse-tracking apps, or send arrow keys to
  // plain alt-screen pagers. xterm does not gate on `event.isTrusted`, so the
  // synthetic event is honoured.
  //
  // Returns a no-op-safe sender in non-browser/test environments; tests inject
  // their own `sendWheel` and assert on it instead.
  function makeDefaultWheelSender(terminal) {
    return function sendWheel(direction) {
      if (typeof window === 'undefined' || typeof window.WheelEvent !== 'function') return;
      var el = terminal && terminal.element;
      if (!el || typeof el.dispatchEvent !== 'function') return;
      var rect = (el.getBoundingClientRect && el.getBoundingClientRect())
        || { left: 0, top: 0, width: 0, height: 0 };
      var ev = new window.WheelEvent('wheel', {
        // One line per notch (DOM_DELTA_LINE === 1). xterm forwards per notch,
        // so each call scrolls the app by one wheel step.
        deltaY: direction === 'up' ? -1 : 1,
        deltaMode: 1,
        // Aim at the centre of the terminal so mouse-tracking apps map the wheel
        // event to a cell inside their viewport.
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(ev);
    };
  }

  // -----------------------------------------------------------------------
  // Controller — binds to one xterm terminal instance
  // -----------------------------------------------------------------------

  function createScrollRailController(terminal, options) {
    options = options || {};
    // Lines per wheel notch when driving real scrollback (scrollback mode).
    var WHEEL_STEP = options.wheelStep || 3;
    // Wheel notches synthesised per page action in TUI mode. TUIs typically
    // scroll a fixed amount per notch regardless of delta magnitude, so a page
    // is several discrete notches rather than one large delta. Sized so a single
    // track click / step-button tap moves a meaningful chunk, not a tiny nudge.
    var PAGE_NOTCHES = options.pageNotches || 8;
    // Strong best-effort downward burst for the bottom control in TUI mode. A
    // full-screen app owns its scroll position, so a true jump-to-bottom is
    // impossible; instead we forward a large run of wheel-down notches, which
    // moves substantially in practice (e.g. to the end of an OpenCode list).
    // This is honest best-effort, NOT a guaranteed jump. Configurable.
    var TUI_JUMP_NOTCHES = options.tuiJumpNotches || 24;
    var sendWheel = options.sendWheel || makeDefaultWheelSender(terminal);

    var listeners = [];
    var disposed = false;
    // Sticky "new output arrived while scrolled up" flag. xterm fires onScroll
    // when the buffer grows (ybase increases) even if the viewport stays put,
    // which is how we detect output below the fold without yanking the view.
    var hasNewOutput = false;
    var lastLength = terminal.buffer.active.length;

    function isTui() {
      try {
        return terminal.buffer.active.type === 'alternate';
      } catch (_e) {
        return false;
      }
    }

    function readMouseTracking() {
      try {
        var m = terminal.modes;
        return !!(m && m.mouseTrackingMode && m.mouseTrackingMode !== 'none');
      } catch (_e) {
        return false;
      }
    }

    // Recompute the flag from the latest buffer state. Growth while parked
    // above the bottom raises the flag; reaching the bottom clears it; TUI mode
    // never raises it (no scrollback there).
    function refreshNewOutput(state) {
      if (state.mode === 'tui') {
        hasNewOutput = false;
      } else {
        if (state.totalRows > lastLength && !state.isAtBottom) hasNewOutput = true;
        if (state.isAtBottom) hasNewOutput = false;
      }
      lastLength = state.totalRows;
      state.hasNewOutput = hasNewOutput;
      return state;
    }

    function decorate(state) {
      state.mouseTracking = readMouseTracking();
      return state;
    }

    function getState() {
      var state = computeScrollState(terminal.buffer.active, terminal.rows);
      state.hasNewOutput = hasNewOutput;
      return decorate(state);
    }

    // -- Actions. Each routes by mode: scrollback drives the real xterm
    //    scrollback; tui forwards wheel-like input (and never claims a position).

    function scrollToBottom() {
      if (isTui()) return; // bottom is unknowable in a TUI; jump is disabled
      hasNewOutput = false;
      terminal.scrollToBottom();
    }

    function scrollLines(n) {
      // Raw passthrough used by scrollback-mode interactions.
      terminal.scrollLines(n);
    }

    function wheelLikeUp() {
      if (isTui()) sendWheel('up');
      else terminal.scrollLines(-WHEEL_STEP);
    }

    function wheelLikeDown() {
      if (isTui()) sendWheel('down');
      else terminal.scrollLines(WHEEL_STEP);
    }

    function pageUp() {
      if (isTui()) {
        for (var i = 0; i < PAGE_NOTCHES; i++) sendWheel('up');
      } else {
        terminal.scrollLines(-terminal.rows);
      }
    }

    function pageDown() {
      if (isTui()) {
        for (var i = 0; i < PAGE_NOTCHES; i++) sendWheel('down');
      } else {
        terminal.scrollLines(terminal.rows);
      }
    }

    // Strong downward action for the bottom control. In scrollback mode this is a
    // real scroll-to-bottom. In TUI mode the bottom is unknowable, so we forward
    // a strong burst of wheel-down notches (best-effort, not a guaranteed jump).
    function jumpDown() {
      if (isTui()) {
        for (var i = 0; i < TUI_JUMP_NOTCHES; i++) sendWheel('down');
      } else {
        scrollToBottom();
      }
    }

    function scrollToRatio(ratio) {
      if (isTui()) return; // exact position is unknowable in a TUI; drag disabled
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
      var state = decorate(refreshNewOutput(computeScrollState(terminal.buffer.active, terminal.rows)));
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
      wheelLikeUp: wheelLikeUp,
      wheelLikeDown: wheelLikeDown,
      pageUp: pageUp,
      pageDown: pageDown,
      jumpDown: jumpDown,
      scrollToRatio: scrollToRatio,
      onStateChange: onStateChange,
      dispose: dispose,
    };
  }

  // -----------------------------------------------------------------------
  // Rail DOM update (pure: operates on the passed element handles, so it is
  // testable without a real DOM)
  // -----------------------------------------------------------------------

  function updateScrollRailDom(elements, state) {
    var rail = elements.rail;
    var track = elements.track;
    var thumb = elements.thumb;
    var jumpBtn = elements.jumpBtn;
    var upBtn = elements.upBtn;

    if (state.mode === 'tui') {
      // Full-screen TUI / alternate screen: keep the rail VISIBLE and
      // INTERACTIVE (up/down + wheel forwarding). The thumb stays as the SAME
      // visual component, switched to an indeterminate variant — it is never
      // positioned to a fake exact spot, because the app owns its scroll
      // position and we cannot know it.
      rail.classList.remove('scroll-rail-active');
      rail.classList.add('scroll-rail-tui');
      rail.setAttribute('title', 'Full-screen app: scroll up/down (position is app-controlled)');
      thumb.style.display = '';
      thumb.style.top = '';
      thumb.style.height = '';
      thumb.classList.add('scroll-rail-thumb-indeterminate');
      if (upBtn) upBtn.style.display = 'flex';
      jumpBtn.style.display = 'flex';
      jumpBtn.classList.remove('scroll-rail-jump-new');
      jumpBtn.setAttribute('title', 'Scroll down');
      return;
    }

    // Scrollback mode.
    rail.classList.remove('scroll-rail-tui');
    rail.removeAttribute('title');
    thumb.classList.remove('scroll-rail-thumb-indeterminate');
    if (upBtn) upBtn.style.display = 'none'; // up button is a TUI-only affordance
    thumb.style.display = '';
    jumpBtn.setAttribute('title', 'Jump to bottom');

    // Hide the rail entirely when there's no scrollback.
    var hasScrollback = state.thumbRatio < 1;
    rail.classList.toggle('scroll-rail-active', hasScrollback);

    if (!hasScrollback) {
      thumb.style.height = '100%';
      thumb.style.top = '0';
      jumpBtn.style.display = 'none';
      jumpBtn.classList.remove('scroll-rail-jump-new');
      return;
    }

    // Thumb size and position (exact).
    var thumbPct = Math.max(state.thumbRatio * 100, 6); // min height so it stays grabbable
    var maxTop = 100 - thumbPct;
    var topPct = state.thumbPosition * maxTop;

    thumb.style.height = thumbPct + '%';
    thumb.style.top = topPct + '%';

    // Jump-to-bottom visibility + "new output below" emphasis.
    jumpBtn.style.display = state.isAtBottom ? 'none' : 'flex';
    jumpBtn.classList.toggle('scroll-rail-jump-new', !state.isAtBottom && !!state.hasNewOutput);
  }

  var publicApi = {
    computeScrollState: computeScrollState,
    createScrollRailController: createScrollRailController,
    updateScrollRailDom: updateScrollRailDom,
  };

  if (typeof window === 'undefined') {
    // Node/test environment — export pure logic only (no DOM builders).
    if (typeof module !== 'undefined') {
      module.exports = publicApi;
    }
    return;
  }

  // -----------------------------------------------------------------------
  // DOM builder — creates the visual rail element for a terminal tile
  // -----------------------------------------------------------------------

  var CHEVRON_DOWN = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none">'
    + '<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';
  var CHEVRON_UP = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none">'
    + '<path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';

  function createScrollRailElement() {
    var rail = document.createElement('div');
    rail.className = 'scroll-rail';
    rail.setAttribute('aria-hidden', 'true');

    // Up button — shown only in TUI mode (scroll the app up).
    var upBtn = document.createElement('button');
    upBtn.className = 'scroll-rail-step scroll-rail-up';
    upBtn.type = 'button';
    upBtn.title = 'Scroll up';
    upBtn.style.display = 'none';
    upBtn.tabIndex = -1; // never steal focus from the terminal
    upBtn.innerHTML = CHEVRON_UP;

    var track = document.createElement('div');
    track.className = 'scroll-rail-track';

    var thumb = document.createElement('div');
    thumb.className = 'scroll-rail-thumb';

    // Bottom button — jump-to-bottom in scrollback mode, scroll-down in TUI mode.
    var jumpBtn = document.createElement('button');
    jumpBtn.className = 'scroll-rail-jump';
    jumpBtn.type = 'button';
    jumpBtn.title = 'Jump to bottom';
    jumpBtn.tabIndex = -1; // never steal focus from the terminal
    jumpBtn.innerHTML = CHEVRON_DOWN;

    track.appendChild(thumb);
    rail.appendChild(upBtn);
    rail.appendChild(track);
    rail.appendChild(jumpBtn);

    return { rail: rail, upBtn: upBtn, track: track, thumb: thumb, jumpBtn: jumpBtn };
  }

  // Press-and-hold repeater: fires an action on pointerdown, then (after a short
  // delay) repeats it at a steady interval while the pointer is held down. This
  // turns "click the down arrow over and over" into "hold to scroll". The action
  // set is read live via getActions() so the same button serves both modes, and
  // pointerdown is preventDefault-ed so the rail never steals terminal focus.
  function addHoldRepeat(el, getActions, opts) {
    opts = opts || {};
    var delay = opts.delay || 350;
    var interval = opts.interval || 110;
    var holdTimer = null;
    var repeatTimer = null;

    function stop() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
    }

    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return; // primary button only
      e.stopPropagation();
      e.preventDefault(); // suppress focus + native button click
      var actions = getActions();
      if (!actions || !actions.first) return;
      actions.first();
      var repeat = actions.repeat;
      if (!repeat) return;
      stop();
      holdTimer = setTimeout(function () {
        repeatTimer = setInterval(repeat, interval);
      }, delay);
    }

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointerleave', stop);
    el.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);

    return function dispose() {
      stop();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', stop);
      el.removeEventListener('pointerleave', stop);
      el.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
    };
  }

  // Wire mouse interactions on a rail to a controller. Handlers read the live
  // mode from the controller so the same rail serves both scrollback and TUI.
  function bindScrollRailEvents(elements, controller) {
    var rail = elements.rail;
    var track = elements.track;
    var thumb = elements.thumb;
    var jumpBtn = elements.jumpBtn;
    var upBtn = elements.upBtn;
    var dragging = false;
    var dragStartY = 0;
    var dragStartThumbTop = 0;
    var holdDisposers = [];

    function modeNow() {
      try { return controller.getState().mode; } catch (_e) { return 'scrollback'; }
    }

    // Up button (TUI-only affordance): tap = one page up, hold = keep paging up.
    if (upBtn) {
      holdDisposers.push(addHoldRepeat(upBtn, function () {
        return { first: controller.pageUp, repeat: controller.pageUp };
      }));
    }

    // Bottom button: in TUI mode a tap does a strong jump-down burst and holding
    // keeps paging down; in scrollback mode it is a single real scroll-to-bottom.
    holdDisposers.push(addHoldRepeat(jumpBtn, function () {
      if (modeNow() === 'tui') {
        return { first: controller.jumpDown, repeat: controller.pageDown };
      }
      return { first: controller.scrollToBottom, repeat: null };
    }));

    // Wheel over the rail strip forwards wheel-like input. The rail overlays the
    // terminal's right edge, so without this, wheel events here would be lost.
    rail.addEventListener('wheel', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY < 0) controller.wheelLikeUp();
      else if (e.deltaY > 0) controller.wheelLikeDown();
    }, { passive: false });

    // Track click — page towards the click. In scrollback mode it pages past the
    // thumb like a native gutter; in TUI mode (no thumb) it pages by half.
    track.addEventListener('mousedown', function (e) {
      if (e.target === thumb || thumb.contains(e.target)) return; // thumb drag handled separately
      e.stopPropagation();
      e.preventDefault();
      if (modeNow() === 'tui') {
        var trackRect = track.getBoundingClientRect();
        if (e.clientY < trackRect.top + trackRect.height / 2) controller.pageUp();
        else controller.pageDown();
        return;
      }
      var thumbRect = thumb.getBoundingClientRect();
      if (e.clientY < thumbRect.top) controller.pageUp();
      else controller.pageDown();
    });

    // Thumb drag — scrollback mode only (the thumb is hidden in TUI mode, and
    // scrollToRatio is a no-op there).
    thumb.addEventListener('mousedown', function (e) {
      if (modeNow() === 'tui') return;
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      dragStartY = e.clientY;
      dragStartThumbTop = parseFloat(thumb.style.top) || 0;
      document.body.style.userSelect = 'none';
      // Neutral cursor while dragging — no hand/grab affordance.
      document.body.style.cursor = 'default';
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
      holdDisposers.forEach(function (d) { d(); });
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
