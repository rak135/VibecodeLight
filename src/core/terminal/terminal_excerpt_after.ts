import fs from 'fs';
import path from 'path';

import { filterKnownPtyNoise, normalizeTerminalOutput } from './output_normalization.js';

export const EXCERPT_AFTER_MAX_LINES = 500;
export const EXCERPT_AFTER_MAX_CHARS = 100_000;
export const EXCERPT_AFTER_RELATIVE_PATH = 'terminal/terminal_excerpt_after.md';

/**
 * Produce a bounded clean excerpt suitable for writing to terminal_excerpt_after.md:
 * - ANSI stripped
 * - Known PTY noise filtered
 * - Unicode preserved
 * - Bounded by lines and chars
 */
export function buildCleanExcerpt(raw: string): string {
  const normalized = normalizeTerminalOutput(raw);
  const filtered = filterKnownPtyNoise(normalized);

  // Bound by chars first
  const charBounded =
    filtered.length > EXCERPT_AFTER_MAX_CHARS
      ? filtered.slice(-EXCERPT_AFTER_MAX_CHARS)
      : filtered;

  // Bound by lines
  const lines = charBounded.split('\n');
  const lineBounded =
    lines.length > EXCERPT_AFTER_MAX_LINES
      ? lines.slice(-EXCERPT_AFTER_MAX_LINES).join('\n')
      : charBounded;

  return lineBounded;
}

/**
 * Write terminal_excerpt_after.md to the run's terminal/ directory.
 * Returns the absolute path of the written file.
 */
export function writeTerminalExcerptAfter(runDir: string, rawExcerpt: string): string {
  const terminalDir = path.join(runDir, 'terminal');
  fs.mkdirSync(terminalDir, { recursive: true });

  const clean = buildCleanExcerpt(rawExcerpt);
  const filePath = path.join(terminalDir, 'terminal_excerpt_after.md');
  fs.writeFileSync(filePath, clean, 'utf8');
  return filePath;
}
