import fs from 'fs';
import path from 'path';

export interface TerminalContextOptions {
  runDir: string;
}

/**
 * Returns terminal context content if terminal_context.json exists in the run directory,
 * null otherwise.
 */
export function getTerminalContext(opts: TerminalContextOptions): string | null {
  const terminalContextPath = path.join(opts.runDir, 'terminal_context.json');
  if (!fs.existsSync(terminalContextPath)) {
    return null;
  }

  try {
    return fs.readFileSync(terminalContextPath, 'utf8');
  } catch {
    return null;
  }
}
