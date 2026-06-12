import fs from 'fs';
import path from 'path';

import {
  SCAN_ARTIFACT_ALLOWLIST,
  listAllowedScanArtifacts,
  readScanArtifactJson,
  type ScanArtifactKey,
} from './scan_artifacts.js';

/**
 * Phase 1B-2: compact, bounded orientation summary built from existing
 * deterministic scan artifacts. Read-only — it never runs the scanner and never
 * reads source files; it only projects allowlisted scan artifacts (via
 * `scan_artifacts.ts`) into small, count-bearing section views.
 *
 * The summary is the cheap first look; for the full content of any one section
 * an agent follows up with `scan_artifact_read` (continuation reads).
 */

/** Logical summary sections an agent can request. */
export const SCAN_SUMMARY_SECTIONS = [
  'files',
  'commands',
  'tests',
  'symbols',
  'imports',
  'entrypoints',
  'instructions',
  'tooling',
  'git',
] as const;

export type ScanSummarySectionName = (typeof SCAN_SUMMARY_SECTIONS)[number];

/** Each logical section is backed by exactly one allowlisted scan artifact. */
const SECTION_ARTIFACT: Readonly<Record<ScanSummarySectionName, ScanArtifactKey>> = Object.freeze({
  files: 'file_inventory',
  commands: 'commands',
  tests: 'tests',
  symbols: 'symbols',
  imports: 'imports',
  entrypoints: 'entrypoints',
  instructions: 'repo_instructions',
  tooling: 'tooling',
  git: 'git_status',
});

/** Default section set when the caller does not specify one (all sections). */
export const DEFAULT_SCAN_SUMMARY_SECTIONS: readonly ScanSummarySectionName[] = SCAN_SUMMARY_SECTIONS;

/** Default cap on per-section item lists. */
export const DEFAULT_SCAN_SUMMARY_MAX_ITEMS = 50;

/** Hard maximum per-section item cap. Enforced in core, mirrored in adapters. */
export const SCAN_SUMMARY_MAX_ITEMS = 100;

export function isScanSummarySection(value: unknown): value is ScanSummarySectionName {
  return typeof value === 'string' && (SCAN_SUMMARY_SECTIONS as readonly string[]).includes(value);
}

export interface ScanSummarySection {
  available: boolean;
  /** The allowlisted scan-artifact key this section derives from. */
  artifact: ScanArtifactKey;
  /** Logical total item count in the underlying artifact. */
  total: number;
  /** Number of items returned in `items` (<= max_items and <= total). */
  returned: number;
  /** Whether `items` was truncated relative to `total`. */
  truncated: boolean;
  /** Bounded sample of items (never includes source-file contents). */
  items: unknown[];
  /** Optional compact summary object (used by `tooling`/`git`). */
  summary?: Record<string, unknown>;
}

export interface ScanSummaryResult {
  scan_dir: string;
  /** Whether `<run>/scan` exists as a directory. */
  scan_dir_available: boolean;
  /** Whether at least one allowlisted scan artifact is present on disk. */
  scan_available: boolean;
  sections_requested: ScanSummarySectionName[];
  sections: Record<string, ScanSummarySection>;
  /** Allowlisted scan-artifact keys present on disk for this run. */
  available_artifacts: string[];
  /** Allowlisted scan-artifact keys absent for this run. */
  missing_artifacts: string[];
  max_items: number;
  warnings: string[];
  recommended_next_tools: string[];
  recommended_cli_commands: string[];
}

export type ScanSummaryError =
  | { code: 'INVALID_SECTION'; message: string; allowed: string[] }
  | { code: 'INVALID_MAX_ITEMS'; message: string };

export interface GetScanSummaryOptions {
  sections?: string[];
  maxItems?: number;
}

interface SectionProjection {
  total: number;
  items: unknown[];
  summary?: Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/** file_inventory.json is a JSON array of per-file entries. Sample paths only. */
function summarizeFiles(value: unknown, max: number): SectionProjection {
  const arr = asArray(value);
  const items = arr.slice(0, max).map((entry) => {
    const rec = asRecord(entry);
    return typeof rec.path === 'string' ? rec.path : String(rec.path ?? '');
  });
  return { total: arr.length, items };
}

/** commands.json: { commands: { <category>: [{command, source}] } }. Flatten. */
function summarizeCommands(value: unknown, max: number): SectionProjection {
  const commands = asRecord(asRecord(value).commands);
  const flat: Array<{ category: string; command: string; source: string }> = [];
  for (const [category, list] of Object.entries(commands)) {
    for (const entry of asArray(list)) {
      const rec = asRecord(entry);
      flat.push({
        category,
        command: typeof rec.command === 'string' ? rec.command : '',
        source: typeof rec.source === 'string' ? rec.source : '',
      });
    }
  }
  return { total: flat.length, items: flat.slice(0, max) };
}

/** tests.json: { tests: [{path, test_framework_guess, test_names, likely_targets}], test_configs }. */
function summarizeTests(value: unknown, max: number): SectionProjection {
  const root = asRecord(value);
  const tests = asArray(root.tests);
  const items = tests.slice(0, max).map((entry) => {
    const rec = asRecord(entry);
    return {
      path: typeof rec.path === 'string' ? rec.path : '',
      framework: typeof rec.test_framework_guess === 'string' ? rec.test_framework_guess : 'unknown',
      test_count: asArray(rec.test_names).length,
      target_count: asArray(rec.likely_targets).length,
    };
  });
  return { total: tests.length, items, summary: { test_configs: asArray(root.test_configs).length } };
}

/** symbols.json: { symbols: [{path, name, kind, signature, line}] }. */
function summarizeSymbols(value: unknown, max: number): SectionProjection {
  const symbols = asArray(asRecord(value).symbols);
  const items = symbols.slice(0, max).map((entry) => pick(asRecord(entry), ['name', 'kind', 'path', 'line']));
  return { total: symbols.length, items };
}

/** imports.json: { imports: [{from_path, import_target, kind, line, language_guess}] }. */
function summarizeImports(value: unknown, max: number): SectionProjection {
  const imports = asArray(asRecord(value).imports);
  const items = imports
    .slice(0, max)
    .map((entry) => pick(asRecord(entry), ['from_path', 'import_target', 'kind', 'language_guess']));
  return { total: imports.length, items };
}

/** entrypoints.json: { entrypoints: [{path?, name?, type}] }. */
function summarizeEntrypoints(value: unknown, max: number): SectionProjection {
  const entrypoints = asArray(asRecord(value).entrypoints);
  const items = entrypoints.slice(0, max).map((entry) => pick(asRecord(entry), ['path', 'name', 'type']));
  return { total: entrypoints.length, items };
}

/** repo_instructions.json: { repo_instructions: [{path, content, headings, bytes, source_type}] }. NEVER include content. */
function summarizeInstructions(value: unknown, max: number): SectionProjection {
  const entries = asArray(asRecord(value).repo_instructions);
  const items = entries.slice(0, max).map((entry) => {
    const rec = asRecord(entry);
    return {
      path: typeof rec.path === 'string' ? rec.path : '',
      source_type: typeof rec.source_type === 'string' ? rec.source_type : 'unknown',
      bytes: typeof rec.bytes === 'number' ? rec.bytes : null,
      heading_count: asArray(rec.headings).length,
    };
  });
  return { total: entries.length, items };
}

/** tooling.json: { formatters, linters, typecheckers, test_frameworks, configs }. */
function summarizeTooling(value: unknown, max: number): SectionProjection {
  const root = asRecord(value);
  const configs = asArray(root.configs);
  return {
    total: configs.length,
    items: configs.slice(0, max),
    summary: {
      formatters: asArray(root.formatters),
      linters: asArray(root.linters),
      typecheckers: asArray(root.typecheckers),
      test_frameworks: asArray(root.test_frameworks),
      config_count: configs.length,
    },
  };
}

/** git_status.json: { git_available, branch, head_commit, dirty, modified, untracked, staged }. */
function summarizeGit(value: unknown, max: number): SectionProjection {
  const root = asRecord(value);
  const modified = asArray(root.modified);
  const untracked = asArray(root.untracked);
  const staged = asArray(root.staged);
  const sample = [...staged, ...modified, ...untracked].map((p) => String(p));
  return {
    total: sample.length,
    items: sample.slice(0, max),
    summary: {
      git_available: Boolean(root.git_available),
      branch: typeof root.branch === 'string' ? root.branch : null,
      head_commit: typeof root.head_commit === 'string' ? root.head_commit : null,
      dirty: typeof root.dirty === 'boolean' ? root.dirty : null,
      modified: modified.length,
      untracked: untracked.length,
      staged: staged.length,
    },
  };
}

const SECTION_SUMMARIZERS: Readonly<
  Record<ScanSummarySectionName, (value: unknown, max: number) => SectionProjection>
> = Object.freeze({
  files: summarizeFiles,
  commands: summarizeCommands,
  tests: summarizeTests,
  symbols: summarizeSymbols,
  imports: summarizeImports,
  entrypoints: summarizeEntrypoints,
  instructions: summarizeInstructions,
  tooling: summarizeTooling,
  git: summarizeGit,
});

function recommendations(scanAvailable: boolean): { tools: string[]; commands: string[] } {
  if (!scanAvailable) {
    return {
      tools: ['vibecode_session_start'],
      commands: ['vibecode scan "<task>"   # run a deterministic scan to produce scan artifacts'],
    };
  }
  return {
    tools: ['vibecode_artifact_read', 'vibecode_run_status', 'vibecode_codegraph_explore'],
    commands: ['vibecode scan artifact-read --run <current|latest|run_id> --artifact <key> --json'],
  };
}

/**
 * Build a bounded scan summary for an already-resolved run directory. The caller
 * (MCP/CLI adapter) is responsible for resolving the run selector and adding the
 * run id/ref to the returned DTO; this function only reads scan artifacts.
 *
 * Returns a structured error for an unknown section or an out-of-range max_items.
 * A missing scan directory or a missing individual artifact is NOT an error: the
 * summary returns ok with `scan_available`/`section.available` flags and warnings.
 */
export function getScanSummary(
  runDir: string,
  options: GetScanSummaryOptions = {},
): { ok: true; value: ScanSummaryResult } | { ok: false; error: ScanSummaryError } {
  const maxItems = options.maxItems ?? DEFAULT_SCAN_SUMMARY_MAX_ITEMS;
  if (!Number.isInteger(maxItems) || maxItems <= 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_MAX_ITEMS',
        message: `invalid max_items: expected a positive integer, got ${JSON.stringify(options.maxItems)}`,
      },
    };
  }
  if (maxItems > SCAN_SUMMARY_MAX_ITEMS) {
    return {
      ok: false,
      error: {
        code: 'INVALID_MAX_ITEMS',
        message: `invalid max_items: value ${maxItems} exceeds maximum ${SCAN_SUMMARY_MAX_ITEMS}`,
      },
    };
  }

  let requested: ScanSummarySectionName[];
  if (options.sections === undefined) {
    requested = [...DEFAULT_SCAN_SUMMARY_SECTIONS];
  } else {
    const unknownSections = options.sections.filter((s) => !isScanSummarySection(s));
    if (unknownSections.length > 0) {
      return {
        ok: false,
        error: {
          code: 'INVALID_SECTION',
          message: `unknown scan summary section(s): ${unknownSections.map((s) => JSON.stringify(s)).join(', ')}`,
          allowed: [...SCAN_SUMMARY_SECTIONS],
        },
      };
    }
    // Dedupe while preserving the caller's order.
    const seen = new Set<string>();
    requested = [];
    for (const section of options.sections) {
      if (!seen.has(section)) {
        seen.add(section);
        requested.push(section as ScanSummarySectionName);
      }
    }
  }

  const scanDir = path.join(runDir, 'scan');
  let scanDirAvailable = false;
  try {
    scanDirAvailable = fs.existsSync(scanDir) && fs.statSync(scanDir).isDirectory();
  } catch {
    scanDirAvailable = false;
  }

  const inventory = listAllowedScanArtifacts(runDir);
  const availableArtifacts = inventory.filter((a) => a.available).map((a) => a.key);
  const missingArtifacts = inventory.filter((a) => !a.available).map((a) => a.key);
  const scanAvailable = availableArtifacts.length > 0;

  const warnings: string[] = [];
  if (!scanDirAvailable) {
    warnings.push(
      'scan directory is not available for this run; run a Vibecode scan first (vibecode scan "<task>")',
    );
  }

  const sections: Record<string, ScanSummarySection> = {};
  for (const name of requested) {
    const artifactKey = SECTION_ARTIFACT[name];
    const json = readScanArtifactJson(runDir, artifactKey);
    if (!json.available || json.value === null) {
      sections[name] = {
        available: false,
        artifact: artifactKey,
        total: 0,
        returned: 0,
        truncated: false,
        items: [],
      };
      if (json.error) {
        warnings.push(`scan artifact for section "${name}" could not be parsed: ${json.error}`);
      } else if (scanDirAvailable) {
        warnings.push(
          `scan artifact for section "${name}" (${SCAN_ARTIFACT_ALLOWLIST[artifactKey]}) is missing for this run`,
        );
      }
      continue;
    }
    const projected = SECTION_SUMMARIZERS[name](json.value, maxItems);
    const returned = projected.items.length;
    sections[name] = {
      available: true,
      artifact: artifactKey,
      total: projected.total,
      returned,
      truncated: projected.total > returned,
      items: projected.items,
      ...(projected.summary ? { summary: projected.summary } : {}),
    };
  }

  const rec = recommendations(scanAvailable);

  return {
    ok: true,
    value: {
      scan_dir: scanDir,
      scan_dir_available: scanDirAvailable,
      scan_available: scanAvailable,
      sections_requested: requested,
      sections,
      available_artifacts: availableArtifacts,
      missing_artifacts: missingArtifacts,
      max_items: maxItems,
      warnings,
      recommended_next_tools: rec.tools,
      recommended_cli_commands: rec.commands,
    },
  };
}
