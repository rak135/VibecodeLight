// Type declarations for the plain-JS renderer terminal-copy helper. The input
// event shape is intentionally permissive: at runtime it is a DOM
// KeyboardEvent, but the pure decision only reads a few fields so tests can pass
// lightweight stand-ins.

export type TerminalCopyActionType = 'copy' | 'passthrough' | 'noop';

export interface TerminalCopyAction {
  type: TerminalCopyActionType;
}

export interface TerminalKeyEventLike {
  type?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  key?: string;
  preventDefault?: () => void;
}

export interface TerminalSelectionLike {
  hasSelection(): boolean;
  getSelection(): string;
}

export interface TerminalKeyHandlerOptions {
  terminal: TerminalSelectionLike;
  writeClipboard(text: string): void;
}

export interface TerminalKeysModule {
  decideTerminalCopyAction(event: TerminalKeyEventLike, hasSelection: boolean): TerminalCopyAction;
  createTerminalKeyHandler(opts: TerminalKeyHandlerOptions): (event: TerminalKeyEventLike) => boolean;
}

declare const TerminalKeys: TerminalKeysModule;
export default TerminalKeys;
