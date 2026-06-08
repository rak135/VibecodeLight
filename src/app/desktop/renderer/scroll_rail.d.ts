// Type declarations for the plain-JS renderer scroll rail module.

export type ScrollMode = 'scrollback' | 'tui';

export interface ScrollState {
  /** True when the active buffer is the alternate (full-screen TUI) screen. */
  isAlt: boolean;
  /**
   * 'scrollback' for the normal buffer (driven through xterm scroll APIs);
   * 'tui' for the alternate buffer (driven through forwarded wheel input).
   */
  mode: ScrollMode;
  /** True in TUI mode: the app owns its scroll position, so it is unknowable. */
  indeterminate: boolean;
  isAtBottom: boolean;
  thumbRatio: number;
  thumbPosition: number;
  totalRows: number;
  viewportRows: number;
  baseY: number;
  viewportY: number;
  /** True when the running app has enabled mouse reporting (informational). */
  mouseTracking: boolean;
  /** True when output arrived below the fold while scrolled up. */
  hasNewOutput: boolean;
}

export interface BufferLike {
  baseY: number;
  viewportY: number;
  length: number;
  type?: 'normal' | 'alternate';
}

export interface TerminalLike {
  rows: number;
  buffer: { active: BufferLike };
  /** xterm root element; synthetic wheel events are dispatched here in TUI mode. */
  element?: { dispatchEvent(ev: unknown): boolean; getBoundingClientRect?(): { left: number; top: number; width: number; height: number } };
  /** xterm public modes; mouseTrackingMode reveals whether the app reports mouse. */
  modes?: { mouseTrackingMode?: string };
  onScroll(cb: (y: number) => void): { dispose(): void };
  scrollToBottom(): void;
  scrollLines(n: number): void;
  scrollToLine?(n: number): void;
}

/** Direction of a forwarded wheel notch. */
export type WheelDirection = 'up' | 'down';

export interface ScrollRailControllerOptions {
  /** Lines per wheel notch when driving real scrollback. Defaults to 3. */
  wheelStep?: number;
  /** Wheel notches synthesised per page action in TUI mode. Defaults to 3. */
  pageNotches?: number;
  /**
   * Override the wheel sender (used in tests). In the browser this defaults to
   * dispatching a synthetic `wheel` event on the xterm root element.
   */
  sendWheel?: (direction: WheelDirection) => void;
}

export interface ScrollRailController {
  getState(): ScrollState;
  /** Scroll the real buffer to the bottom (no-op in TUI mode). */
  scrollToBottom(): void;
  scrollLines(n: number): void;
  /** One wheel notch up: real scrollback in scrollback mode, forwarded in TUI mode. */
  wheelLikeUp(): void;
  /** One wheel notch down: real scrollback in scrollback mode, forwarded in TUI mode. */
  wheelLikeDown(): void;
  pageUp(): void;
  pageDown(): void;
  /** Jump to an absolute position (no-op in TUI mode — position is unknowable). */
  scrollToRatio(ratio: number): void;
  onStateChange(cb: (state: ScrollState) => void): () => void;
  dispose(): void;
}

export interface ScrollRailElements {
  rail: unknown;
  upBtn: unknown;
  track: unknown;
  thumb: unknown;
  jumpBtn: unknown;
}

export interface ScrollRailModule {
  computeScrollState(buffer: BufferLike, viewportRows: number): ScrollState;
  createScrollRailController(terminal: TerminalLike, options?: ScrollRailControllerOptions): ScrollRailController;
  updateScrollRailDom(elements: ScrollRailElements, state: Partial<ScrollState> & { mode: ScrollMode }): void;
}

declare const ScrollRail: ScrollRailModule;
export default ScrollRail;
