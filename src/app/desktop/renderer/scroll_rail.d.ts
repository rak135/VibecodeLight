// Type declarations for the plain-JS renderer scroll rail module.

export interface ScrollState {
  /** True when the active buffer is the alternate (full-screen TUI) screen. */
  isAlt: boolean;
  isAtBottom: boolean;
  thumbRatio: number;
  thumbPosition: number;
  totalRows: number;
  viewportRows: number;
  baseY: number;
  viewportY: number;
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
  onScroll(cb: (y: number) => void): { dispose(): void };
  scrollToBottom(): void;
  scrollLines(n: number): void;
  scrollToLine?(n: number): void;
}

export interface ScrollRailController {
  getState(): ScrollState;
  scrollToBottom(): void;
  scrollLines(n: number): void;
  pageUp(): void;
  pageDown(): void;
  scrollToRatio(ratio: number): void;
  onStateChange(cb: (state: ScrollState) => void): () => void;
  dispose(): void;
}

export interface ScrollRailModule {
  computeScrollState(buffer: BufferLike, viewportRows: number): ScrollState;
  createScrollRailController(terminal: TerminalLike): ScrollRailController;
}

declare const ScrollRail: ScrollRailModule;
export default ScrollRail;
