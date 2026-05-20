export interface PtySession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  readonly pid: number;
  readonly isClosed: boolean;
  onData(handler: (data: string) => void): void;
  onExit(handler: (code: number | undefined) => void): void;
}

export interface PtySessionOptions {
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export type PtyErrorCode =
  | 'PTY_NOT_AVAILABLE'
  | 'SHELL_NOT_FOUND'
  | 'TERMINAL_START_FAILED'
  | 'TERMINAL_TIMEOUT'
  | 'TERMINAL_WRITE_FAILED';

export class PtyError extends Error {
  constructor(
    public readonly code: PtyErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PtyError';
  }
}
