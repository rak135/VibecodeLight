// Type declarations for the plain-JS renderer scroll rail module.

export interface ScrollState {
  isAtBottom: boolean;
  thumbRatio: number;
  thumbPosition: number;
  totalRows: number;
  viewportRows: number;
  baseY: number;
  viewportY: number;
}

export interface BufferLike {
  baseY: number;
  viewportY: number;
  length: number;
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
