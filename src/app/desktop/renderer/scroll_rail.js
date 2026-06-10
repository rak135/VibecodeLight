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
  // Builds the default browser wheel sender. xterm.js v6 binds its wheel
  // handler to terminal.element (the .xterm root) when mouse-tracking is
  // enabled, and to the inner screen/viewport elements when the scrollable
  // element handles the wheel itself. To cover both paths reliably we dispatch
  // on the root element first, then try the screen and viewport children.
  //
  // We use MouseEvent (universally supported) and define deltaY / deltaMode as
  // non-writable properties — xterm.js only reads those fields, it never checks
  // instanceof WheelEvent.
  //
  // Returns a no-op-safe sender in non-browser/test environments; tests inject
  // their own `sendWheel` and assert on it instead.
  function makeDefaultWheelSender(terminal) {
    return function sendWheel(direction) {
      if (typeof window === 'undefined') return;
      var el = terminal && terminal.element;
      if (!el || typeof el.dispatchEvent !== 'function') return;
      var rect = (el.getBoundingClientRect && el.getBoundingClientRect())
        || { left: 0, top: 0, width: 0, height: 0 };
      var clientX = rect.left + rect.width / 2;
      var clientY = rect.top + rect.height / 2;

      var targets = [el];
      var screen = el.querySelector('.xterm-screen');
      if (screen && screen !== el) targets.push(screen);
      var viewport = el.querySelector('.xterm-viewport');
      if (viewport && viewport !== el && viewport !== screen) targets.push(viewport);

      for (var i = 0; i < targets.length; i++) {
        var ev = new window.MouseEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: clientX,
          clientY: clientY,
        });
        try {
          Object.defineProperty(ev, 'deltaY', {
            value: direction === 'up' ? -1 : 1,
            writable: false,
            configurable: true,
          });
          Object.defineProperty(ev, 'deltaMode', {
            value: 1,
            writable: false,
            configurable: true,
          });
        } catch (_e) {
          ev.deltaY = direction === 'up' ? -1 : 1;
          ev.deltaMode = 1;
        }
        try { targets[i].dispatchEvent(ev); } catch (_e) { /* ignore */ }
      }
    };
  }

  // -----------------------------------------------------------------------
  // TUI feedback helpers — least-invasive snapshot + repeat-until-stable
  // -----------------------------------------------------------------------

  // Build a coarse string snapshot of the currently visible terminal screen.
  // In TUI/alternate-buffer mode the buffer IS the screen, so we read the
  // first `terminal.rows` lines via the public translateBufferLineToString API.
  // If the API is unavailable or throws, we return null so the caller falls back
  // to a simple max-batch limit.
  function getVisibleTerminalSnapshot(terminal) {
    try {
      var buffer = terminal.buffer.active;
      var rows = terminal.rows;
      var lines = [];
      for (var i = 0; i < rows; i++) {
        lines.push(buffer.translateBufferLineToString(i, true));
      }
      return lines.join('\n');
    } catch (_e) {
      return null;
    }
  }

  // Send repeated wheel input in `direction` until the visible screen stops
  // changing or a safe limit is reached. This is best-effort, not exact.
  // Returns a handle with a `stop()` method so callers can cancel early.
  function repeatUntilStable(terminal, direction, sendWheel, options) {
    options = options || {};
    var maxBatches = options.maxBatches !== undefined ? options.maxBatches : 30;
    var stableThreshold = options.stableThreshold !== undefined ? options.stableThreshold : 3;
    var interval = options.interval !== undefined ? options.interval : 80;
    var batchSize = options.batchSize !== undefined ? options.batchSize : 1;
    var getSnapshot = options.getSnapshot || getVisibleTerminalSnapshot;

    var batches = 0;
    var stableCount = 0;
    var lastSnapshot = null;
    var timer = null;

    function stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    function tick() {
      if (batches >= maxBatches) {
        stop();
        return;
      }
      var snapshot = getSnapshot(terminal);
      if (snapshot !== null && snapshot === lastSnapshot && batches > 0) {
        stableCount++;
        if (stableCount >= stableThreshold) {
          stop();
          return;
        }
      } else {
        stableCount = 0;
      }
      lastSnapshot = snapshot;
      for (var i = 0; i < batchSize; i++) {
        sendWheel(direction);
      }
      batches++;
    }

    if (interval <= 0) {
      // Synchronous mode for tests: drain all batches immediately.
      while (stableCount < stableThreshold && batches < maxBatches) {
        tick();
      }
    } else {
      tick();
      if (stableCount < stableThreshold) {
        timer = setInterval(tick, interval);
      }
    }
    return { stop: stop };
  }

  // -----------------------------------------------------------------------
  // Controller — binds to one xterm terminal instance
  // -----------------------------------------------------------------------

  function createScrollRailController(terminal, options) {
    options = options || {};
    // Lines per wheel notch when driving real scrollback (scrollback mode).
    var WHEEL_STEP = options.wheelStep || 3;

    // TUI mode constants — these control the size of synthetic wheel batches.
    var TUI_WHEEL_NOTCHES = options.tuiWheelNotches !== undefined ? options.tuiWheelNotches : 1;
    var TUI_PAGE_NOTCHES = options.pageNotches !== undefined ? options.pageNotches : 8;
    // Best-effort jump limits: max batches, stable batches to stop, and interval.
    var TUI_JUMP_MAX_BATCHES = options.tuiJumpMaxBatches !== undefined ? options.tuiJumpMaxBatches : 30;
    var TUI_STABLE_BATCHES = options.tuiStableBatches !== undefined ? options.tuiStableBatches : 3;
    var TUI_REPEAT_INTERVAL_MS = options.tuiRepeatIntervalMs !== undefined ? options.tuiRepeatIntervalMs : 80;

    var sendWheel = options.sendWheel || makeDefaultWheelSender(terminal);
    var activeRepeater = null;

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
      if (isTui()) {
        for (var i = 0; i < TUI_WHEEL_NOTCHES; i++) sendWheel('up');
      } else {
        terminal.scrollLines(-WHEEL_STEP);
      }
    }

    function wheelLikeDown() {
      if (isTui()) {
        for (var i = 0; i < TUI_WHEEL_NOTCHES; i++) sendWheel('down');
      } else {
        terminal.scrollLines(WHEEL_STEP);
      }
    }

    function pageUp() {
      if (isTui()) {
        for (var i = 0; i < TUI_PAGE_NOTCHES; i++) sendWheel('up');
      } else {
        terminal.scrollLines(-terminal.rows);
      }
    }

    function pageDown() {
      if (isTui()) {
        for (var i = 0; i < TUI_PAGE_NOTCHES; i++) sendWheel('down');
      } else {
        terminal.scrollLines(terminal.rows);
      }
    }

    // Best-effort jump down (bottom control). In scrollback mode this is a real
    // scroll-to-bottom. In TUI mode we use repeatUntilStable with feedback so we
    // get much closer to the real bottom than a fixed burst.
    function jumpDown() {
      if (isTui()) {
        if (activeRepeater) activeRepeater.stop();
        activeRepeater = repeatUntilStable(terminal, 'down', sendWheel, {
          maxBatches: TUI_JUMP_MAX_BATCHES,
          stableThreshold: TUI_STABLE_BATCHES,
          interval: TUI_REPEAT_INTERVAL_MS,
          batchSize: TUI_WHEEL_NOTCHES,
        });
      } else {
        scrollToBottom();
      }
    }

    // Best-effort jump up (top control). Only meaningful in TUI mode.
    function jumpUp() {
      if (isTui()) {
        if (activeRepeater) activeRepeater.stop();
        activeRepeater = repeatUntilStable(terminal, 'up', sendWheel, {
          maxBatches: TUI_JUMP_MAX_BATCHES,
          stableThreshold: TUI_STABLE_BATCHES,
          interval: TUI_REPEAT_INTERVAL_MS,
          batchSize: TUI_WHEEL_NOTCHES,
        });
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
      if (activeRepeater) {
        activeRepeater.stop();
        activeRepeater = null;
      }
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
      jumpUp: jumpUp,
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
    // TUI drag: continuous wheel input mapped to pointer movement.
    var tuiDragInterval = null;
    var tuiDragRepeater = null;
    var TUI_DRAG_THRESHOLD = 10; // px per wheel notch

    function modeNow() {
      try { return controller.getState().mode; } catch (_e) { return 'scrollback'; }
    }

    function clearTuiDrag() {
      if (tuiDragInterval) {
        clearInterval(tuiDragInterval);
        tuiDragInterval = null;
      }
      if (tuiDragRepeater) {
        clearInterval(tuiDragRepeater);
        tuiDragRepeater = null;
      }
      dragging = false;
    }

    // Up button (TUI-only affordance): tap = best-effort jump up, hold = keep paging up.
    if (upBtn) {
      holdDisposers.push(addHoldRepeat(upBtn, function () {
        if (modeNow() === 'tui') {
          return { first: controller.jumpUp, repeat: controller.pageUp };
        }
        return { first: controller.pageUp, repeat: controller.pageUp };
      }));
    }

    // Bottom button: in TUI mode a tap does best-effort jump-down and holding
    // keeps paging down; in scrollback mode it is a single real scroll-to-bottom.
    holdDisposers.push(addHoldRepeat(jumpBtn, function () {
      if (modeNow() === 'tui') {
        return { first: controller.jumpDown, repeat: controller.pageDown };
      }
      return { first: controller.scrollToBottom, repeat: null };
    }));

    // Wheel over the rail strip forwards wheel-like input. The rail overlays the
    // terminal's right edge, so without this, wheel events here would be lost.
    // We listen on both rail and track so the event is never swallowed by the overlay.
    function onWheel(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY < 0) controller.wheelLikeUp();
      else if (e.deltaY > 0) controller.wheelLikeDown();
    }
    rail.addEventListener('wheel', onWheel, { passive: false });
    track.addEventListener('wheel', onWheel, { passive: false });

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

    // Thumb drag — scrollback mode uses absolute position; TUI mode uses
    // continuous wheel input proportional to vertical pointer movement.
    thumb.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      if (modeNow() === 'tui') {
        dragging = true;
        dragStartY = e.clientY;
        // Continuous wheel input while dragging.
        tuiDragInterval = setInterval(function () {
          // Notches are sent in the pointermove handler; this interval is just
          // a safety timer to clear the drag state if the browser stops firing
          // pointermove (e.g. the pointer leaves the window).
        }, 500);
        return;
      }
      dragging = true;
      dragStartY = e.clientY;
      dragStartThumbTop = parseFloat(thumb.style.top) || 0;
      document.body.style.userSelect = 'none';
      // Neutral cursor while dragging — no hand/grab affordance.
      document.body.style.cursor = 'default';
    });

    function onMouseMove(e) {
      if (!dragging) return;
      if (modeNow() === 'tui') {
        var deltaY = e.clientY - dragStartY;
        if (Math.abs(deltaY) >= TUI_DRAG_THRESHOLD) {
          var direction = deltaY < 0 ? 'up' : 'down';
          var notches = Math.floor(Math.abs(deltaY) / TUI_DRAG_THRESHOLD);
          for (var i = 0; i < notches; i++) {
            if (direction === 'up') controller.wheelLikeUp();
            else controller.wheelLikeDown();
          }
          dragStartY = e.clientY;
        }
        return;
      }
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
      clearTuiDrag();
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Clean up any TUI drag state when the window loses focus.
    window.addEventListener('blur', clearTuiDrag);

    return function unbind() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', clearTuiDrag);
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
