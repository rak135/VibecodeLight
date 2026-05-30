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
  /**
   * Neutral, display-ready text for each entry of `warnings`, computed in core
   * so the renderer never has to parse warning codes. Same length and order as
   * `warnings`. Empty when there are no warnings.
   */
  displayWarnings: string[];
  /** Informational note describing whether CodeGraph was used for context. */
  usageNote: string;
  /** True only when a use-existing run successfully included CodeGraph context. */
  usedForContext: boolean;
  /** Human-readable usage reason for summary rows. */
  usageReason: string;
  /** Relative path to bounded CodeGraph context artifact when present. */
  contextArtifact?: string;
  /** True only when a CodeGraph-derived scan/codegraph_repo_atlas.md was generated. */
  repoAtlasGenerated: boolean;
  /** Human-readable Repo Atlas generation/skipped reason. */
  repoAtlasReason: string;
  /** Display-ready Repo Atlas summary line. */
  repoAtlasNote: string;
  /** Relative path to CodeGraph-derived Repo Atlas markdown when present. */
  repoAtlasArtifact?: string;
  /** Relative path to CodeGraph-derived Repo Atlas JSON when present. */
  repoAtlasJsonArtifact?: string;
}

/**
 * Informational note shown alongside the status. CodeGraph usage for context is
 * a future phase; there is intentionally no enabled toggle in Phase 1.5.
 */
export const CODEGRAPH_USAGE_NOTE = 'CodeGraph used: no — detect-only.';

/**
 * Map a raw CodeGraph warning string (typically `CODE: details`) to neutral,
 * user-facing text safe to show in the GUI summary. Unknown codes fall through
 * with the prefix stripped; bare strings are returned unchanged. Kept here in
 * core so the renderer stays thin and tests cover the wording in one place.
 *
 * Wording is intentionally neutral — CodeGraph is optional and warnings are
 * not failures (the build still succeeds with the existing index).
 */
export function formatCodeGraphWarning(warning: string): string {
  const trimmed = warning.trim();
  if (trimmed.length === 0) return trimmed;
  const colon = trimmed.indexOf(':');
  const code = colon > 0 ? trimmed.slice(0, colon).trim() : trimmed;
  switch (code) {
    case 'CODEGRAPH_INDEX_STALE':
      return 'Index may be stale. Existing index was used. Run Sync to update it.';
    case 'CODEGRAPH_OUTPUT_TRUNCATED':
      return 'CodeGraph output was truncated to stay within the configured size limit.';
    case 'CODEGRAPH_STATUS_FAILED':
      return 'CodeGraph status check failed; existing index was not used.';
    case 'CODEGRAPH_CONTEXT_FAILED':
      return 'CodeGraph context command failed; existing index was not used.';
    case 'CODEGRAPH_NOT_INSTALLED':
      return 'CodeGraph is not installed; existing index was not used.';
    case 'CODEGRAPH_NOT_INITIALIZED':
      return 'CodeGraph is not initialized for this repository; existing index was not used.';
    default:
      return colon > 0 ? trimmed.slice(colon + 1).trim() || trimmed : trimmed;
  }
}

function toDisplayWarnings(warnings: string[]): string[] {
  return warnings.map(formatCodeGraphWarning);
}

function normalizeWarnings(warnings: unknown): string[] {
  return Array.isArray(warnings)
    ? warnings.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function normalizeMode(mode: unknown): string | null {
  return typeof mode === 'string' && mode.length > 0 ? mode : null;
}

function defaultRepoAtlasFields(): Pick<CodeGraphStatus, 'repoAtlasGenerated' | 'repoAtlasReason' | 'repoAtlasNote'> {
  return {
    repoAtlasGenerated: false,
    repoAtlasReason: 'not generated — detect-only',
    repoAtlasNote: 'CodeGraph-derived Repo Atlas: not generated — detect-only.',
  };
}

function unknownStatus(): CodeGraphStatus {
  return {
    state: 'unknown',
    label: 'CodeGraph: status unavailable until a scan runs',
    mode: null,
    detail: 'Run a scan or context build to record CodeGraph detection status.',
    warnings: [],
    displayWarnings: [],
    usageNote: CODEGRAPH_USAGE_NOTE,
    usedForContext: false,
    usageReason: 'detect-only',
    ...defaultRepoAtlasFields(),
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
      displayWarnings: toDisplayWarnings(warnings),
      usageNote: CODEGRAPH_USAGE_NOTE,
      usedForContext: false,
      usageReason: 'detect-only',
      ...defaultRepoAtlasFields(),
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
      displayWarnings: toDisplayWarnings(warnings),
      usageNote: CODEGRAPH_USAGE_NOTE,
      usedForContext: false,
      usageReason: 'detect-only',
      ...defaultRepoAtlasFields(),
    };
  }

  return {
    state: 'ready',
    label: 'CodeGraph: ready',
    mode,
    detail: 'CodeGraph is installed and this repository is initialized.',
    warnings,
    displayWarnings: toDisplayWarnings(warnings),
    usageNote: CODEGRAPH_USAGE_NOTE,
    usedForContext: false,
    usageReason: 'detect-only',
    ...defaultRepoAtlasFields(),
  };
}

function usageNote(mode: string | null, used: boolean, reason?: string): string {
  if (used) return 'CodeGraph used: yes — existing index.';
  if (mode === 'use-existing' && reason) return `CodeGraph used: no — skipped: ${reason}.`;
  return CODEGRAPH_USAGE_NOTE;
}

function repoAtlasNote(generated: boolean, reason: string): string {
  return generated ? 'CodeGraph-derived Repo Atlas: generated.' : `CodeGraph-derived Repo Atlas: not generated — ${reason}.`;
}

function applyUsage(status: CodeGraphStatus, usage: unknown): CodeGraphStatus {
  if (typeof usage !== 'object' || usage === null) return status;
  const record = usage as Record<string, unknown>;
  const mode = normalizeMode(record.mode) ?? status.mode;
  const used = record.used === true;
  const rawReason = typeof record.reason === 'string' ? record.reason : undefined;
  const artifact = typeof record.artifact === 'string' ? record.artifact : status.contextArtifact;
  const repoAtlasGenerated = record.codegraph_repo_atlas_generated === true || record.repo_atlas_generated === true;
  const repoAtlasRawReason = typeof record.codegraph_repo_atlas_reason === 'string'
    ? record.codegraph_repo_atlas_reason
    : (typeof record.repo_atlas_reason === 'string'
      ? record.repo_atlas_reason
      : (repoAtlasGenerated ? 'generated' : 'CODEGRAPH_NOT_USED'));
  const repoAtlasReason = repoAtlasGenerated ? repoAtlasRawReason : `not generated — ${repoAtlasRawReason}`;
  const repoAtlasArtifact = typeof record.codegraph_repo_atlas_artifact === 'string'
    ? record.codegraph_repo_atlas_artifact
    : (typeof record.repo_atlas_artifact === 'string' ? record.repo_atlas_artifact : status.repoAtlasArtifact);
  const repoAtlasJsonArtifact = typeof record.codegraph_repo_atlas_json_artifact === 'string'
    ? record.codegraph_repo_atlas_json_artifact
    : (typeof record.repo_atlas_json_artifact === 'string' ? record.repo_atlas_json_artifact : status.repoAtlasJsonArtifact);
  const usageReason = used ? 'existing index' : (mode === 'use-existing' && rawReason ? `skipped: ${rawReason}` : 'detect-only');
  const warnings = normalizeWarnings(record.warnings);
  const mergedWarnings = Array.from(new Set([...status.warnings, ...warnings]));
  return {
    ...status,
    mode,
    usedForContext: used,
    usageReason,
    usageNote: usageNote(mode, used, rawReason),
    warnings: mergedWarnings,
    displayWarnings: toDisplayWarnings(mergedWarnings),
    repoAtlasGenerated,
    repoAtlasReason,
    repoAtlasNote: repoAtlasNote(repoAtlasGenerated, repoAtlasRawReason),
    ...(artifact ? { contextArtifact: artifact } : {}),
    ...(repoAtlasArtifact ? { repoAtlasArtifact } : {}),
    ...(repoAtlasJsonArtifact ? { repoAtlasJsonArtifact } : {}),
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
    const base = summarizeCodeGraphStatus(parsed?.tools?.codegraph);
    const usagePath = path.join(scanDir, 'codegraph_usage.json');
    if (!fs.existsSync(usagePath)) return base;
    try {
      return applyUsage(base, JSON.parse(fs.readFileSync(usagePath, 'utf8')));
    } catch {
      return base;
    }
  } catch {
    return unknownStatus();
  }
}

/** Convenience: read the CodeGraph status for a run directory (`<runDir>/scan`). */
export function readRunCodeGraphStatus(runDir: string): CodeGraphStatus {
  return readCodeGraphStatusFromScanDir(path.join(runDir, 'scan'));
}
