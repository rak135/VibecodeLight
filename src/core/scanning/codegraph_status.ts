import fs from 'fs';
import path from 'path';

import { CodeGraphToolEntry, EXTERNAL_TOOLS_FILENAME } from './external_tools.js';

/**
 * Display-ready, derived view of optional CodeGraph detection for a run.
 *
 * Phase 1.5 surfaces the Phase 1 detect-only result in the GUI/run summary. It
 * is strictly informational: it reads the existing `scan/external_tools.json`
 * artifact and never executes CodeGraph (no init/index/sync/watch, no MCP, no
 * context enrichment). Derivation lives here (core) so the renderer and CLI both
 * read the same computed status instead of re-parsing the artifact.
 */

export type CodeGraphStatusState =
  | 'not-installed'
  | 'installed-not-initialized'
  | 'ready'
  | 'unknown';

export interface CodeGraphStatus {
  /** Machine-readable derived state. */
  state: CodeGraphStatusState;
  /** Short, neutral, display-ready label (e.g. "CodeGraph: ready"). */
  label: string;
  /** Detection mode recorded by the scan ("detect-only"), or null if no scan ran. */
  mode: string | null;
  /** Longer neutral explanation, safe to show as secondary text. */
  detail: string;
  /** Pass-through detection warnings (may be empty). Never rendered as errors. */
  warnings: string[];
  /** Informational note: CodeGraph is not used for context yet (no toggle). */
  usageNote: string;
}

/**
 * Informational note shown alongside the status. CodeGraph usage for context is
 * a future phase; there is intentionally no enabled toggle in Phase 1.5.
 */
export const CODEGRAPH_USAGE_NOTE = 'Use in context: not implemented yet (future phase).';

function normalizeWarnings(warnings: unknown): string[] {
  return Array.isArray(warnings)
    ? warnings.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function normalizeMode(mode: unknown): string | null {
  return typeof mode === 'string' && mode.length > 0 ? mode : null;
}

function unknownStatus(): CodeGraphStatus {
  return {
    state: 'unknown',
    label: 'CodeGraph: status unavailable until a scan runs',
    mode: null,
    detail: 'Run a scan or context build to record CodeGraph detection status.',
    warnings: [],
    usageNote: CODEGRAPH_USAGE_NOTE,
  };
}

/**
 * Map a detect-only `external_tools.json` codegraph entry to a display status.
 *
 * A missing entry, or an entry with non-boolean availability, yields `unknown`
 * (no scan recorded yet / unreadable) rather than implying CodeGraph is absent.
 * Missing CodeGraph (`available=false`) is reported as a neutral optional state,
 * never an error.
 */
export function summarizeCodeGraphStatus(
  entry: CodeGraphToolEntry | null | undefined,
): CodeGraphStatus {
  if (!entry || typeof entry.available !== 'boolean') {
    return unknownStatus();
  }

  const mode = normalizeMode(entry.mode);
  const warnings = normalizeWarnings(entry.warnings);

  if (!entry.available) {
    return {
      state: 'not-installed',
      label: 'CodeGraph: not installed (optional)',
      mode,
      detail:
        'CodeGraph is optional and was not found on PATH. VibecodeLight runs normally without it.',
      warnings,
      usageNote: CODEGRAPH_USAGE_NOTE,
    };
  }

  if (!entry.initialized) {
    return {
      state: 'installed-not-initialized',
      label: 'CodeGraph: installed, not initialized',
      mode,
      detail:
        'The codegraph command is available but this repository has no .codegraph/ index yet.',
      warnings,
      usageNote: CODEGRAPH_USAGE_NOTE,
    };
  }

  return {
    state: 'ready',
    label: 'CodeGraph: ready',
    mode,
    detail: 'CodeGraph is installed and this repository is initialized.',
    warnings,
    usageNote: CODEGRAPH_USAGE_NOTE,
  };
}

/**
 * Read the detect-only CodeGraph status from a run's scan directory.
 * Returns `unknown` (never throws) when the artifact is missing or unreadable.
 */
export function readCodeGraphStatusFromScanDir(scanDir: string): CodeGraphStatus {
  const artifactPath = path.join(scanDir, EXTERNAL_TOOLS_FILENAME);
  if (!fs.existsSync(artifactPath)) {
    return unknownStatus();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
      tools?: { codegraph?: CodeGraphToolEntry };
    };
    return summarizeCodeGraphStatus(parsed?.tools?.codegraph);
  } catch {
    return unknownStatus();
  }
}

/** Convenience: read the CodeGraph status for a run directory (`<runDir>/scan`). */
export function readRunCodeGraphStatus(runDir: string): CodeGraphStatus {
  return readCodeGraphStatusFromScanDir(path.join(runDir, 'scan'));
}
