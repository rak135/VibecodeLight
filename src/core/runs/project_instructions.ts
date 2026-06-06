import fs from 'fs';
import path from 'path';

import { getWorkspacePaths } from '../workspace/paths.js';
import { resolveRunDir } from './run_resolver.js';

/**
 * Shared core helper for the MCP-3 `vibecode_project_instructions` tool.
 *
 * Hard rules:
 *   - reads only a strict allowlist of repo-relative files;
 *   - never accepts an arbitrary path arg;
 *   - never reads source files;
 *   - prefers a per-run scan artifact when the latest run has one;
 *   - bounded excerpts per file;
 *   - never reads anything outside the repo root or run dir.
 *
 * The two sources are:
 *   1. `scan/repo_instructions.json` from the latest/current run when present.
 *      Its expected shape is `{ files: Array<{ path: string; content: string }> }`.
 *   2. Direct read of allowlisted files under the repo root.
 */

/** Repo-relative instruction files allowlisted for direct fallback reads. */
export const PROJECT_INSTRUCTION_FILES: readonly string[] = Object.freeze([
  'AGENTS.md',
  'CONTRIBUTING.md',
  'README.md',
  'docs/codegraph.md',
]);

/** Repo-relative architecture/doc files allowlisted only when `include_docs=true`. */
export const PROJECT_DOC_FILES: readonly string[] = Object.freeze([
  'docs/ARCHITECTURE.md',
  'docs/ARCHITECTURE_DECISIONS.md',
  'docs/IMPLEMENTATION_MAP.md',
  'docs/codegraph.md',
]);

/** Maximum bytes of any single excerpt returned. */
export const MAX_INSTRUCTION_EXCERPT_BYTES = 2_000;

export interface ProjectInstructionEntry {
  path: string;
  excerpt: string;
  bytes: number;
  truncated: boolean;
}

export type ProjectInstructionsSource = 'scan_artifact' | 'repo_allowlist' | 'none';

export interface ProjectInstructionsResult {
  source: ProjectInstructionsSource;
  /** Allowlisted instruction files found (AGENTS.md / CONTRIBUTING.md / …). */
  instructions: ProjectInstructionEntry[];
  /** Optional doc excerpts, only populated when `include_docs=true`. */
  docs: ProjectInstructionEntry[];
  /** Non-fatal warnings; never raw error bodies. */
  warnings: string[];
  /** Optional run id that backed `source === 'scan_artifact'`. */
  run_id?: string;
}

function readBoundedFile(absolutePath: string): { content: string; bytes: number; truncated: boolean } | null {
  try {
    const buf = fs.readFileSync(absolutePath);
    const bytes = buf.length;
    if (bytes <= MAX_INSTRUCTION_EXCERPT_BYTES) {
      return { content: buf.toString('utf8'), bytes, truncated: false };
    }
    return {
      content: buf.subarray(0, MAX_INSTRUCTION_EXCERPT_BYTES).toString('utf8'),
      bytes,
      truncated: true,
    };
  } catch {
    return null;
  }
}

function readScanInstructions(repoRoot: string): { runId: string; entries: ProjectInstructionEntry[] } | null {
  try {
    const { runDir, runId } = resolveRunDir(repoRoot, 'latest');
    const candidate = path.join(runDir, 'scan', 'repo_instructions.json');
    if (!fs.existsSync(candidate)) return null;
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { files?: Array<{ path?: unknown; content?: unknown }> };
    if (!Array.isArray(parsed.files)) return null;
    const entries: ProjectInstructionEntry[] = [];
    for (const file of parsed.files) {
      if (typeof file?.path !== 'string' || typeof file?.content !== 'string') continue;
      const raw = file.content;
      const buf = Buffer.from(raw, 'utf8');
      const bytes = buf.length;
      const truncated = bytes > MAX_INSTRUCTION_EXCERPT_BYTES;
      const excerpt = truncated ? buf.subarray(0, MAX_INSTRUCTION_EXCERPT_BYTES).toString('utf8') : raw;
      entries.push({ path: file.path, excerpt, bytes, truncated });
    }
    return { runId, entries };
  } catch {
    return null;
  }
}

function readAllowlistedFiles(repoRoot: string, allowlist: readonly string[]): ProjectInstructionEntry[] {
  const out: ProjectInstructionEntry[] = [];
  for (const rel of allowlist) {
    const abs = path.join(repoRoot, rel);
    // Belt-and-braces: never read outside the repo root.
    const resolvedAbs = path.resolve(abs);
    const resolvedRoot = path.resolve(repoRoot);
    const inside = resolvedAbs === resolvedRoot || resolvedAbs.startsWith(resolvedRoot + path.sep);
    if (!inside) continue;
    if (!fs.existsSync(resolvedAbs)) continue;
    const read = readBoundedFile(resolvedAbs);
    if (!read) continue;
    out.push({ path: rel, excerpt: read.content, bytes: read.bytes, truncated: read.truncated });
  }
  return out;
}

export interface BuildProjectInstructionsOptions {
  include_docs?: boolean;
}

/** Build the structured project_instructions payload, prioritising scan artifact. */
export function buildProjectInstructions(repoRoot: string, options: BuildProjectInstructionsOptions = {}): ProjectInstructionsResult {
  const warnings: string[] = [];
  // Sanity check: repoRoot must be a directory.
  try {
    const stat = fs.statSync(repoRoot);
    if (!stat.isDirectory()) {
      warnings.push(`repo_root is not a directory: ${repoRoot}`);
      return { source: 'none', instructions: [], docs: [], warnings };
    }
  } catch {
    warnings.push(`repo_root does not exist: ${repoRoot}`);
    return { source: 'none', instructions: [], docs: [], warnings };
  }

  const paths = getWorkspacePaths(repoRoot);
  if (fs.existsSync(paths.runs)) {
    const scan = readScanInstructions(repoRoot);
    if (scan && scan.entries.length > 0) {
      return {
        source: 'scan_artifact',
        instructions: scan.entries,
        docs: [],
        warnings,
        run_id: scan.runId,
      };
    }
  }

  const instructions = readAllowlistedFiles(repoRoot, PROJECT_INSTRUCTION_FILES);
  const docs = options.include_docs ? readAllowlistedFiles(repoRoot, PROJECT_DOC_FILES) : [];
  return {
    source: instructions.length === 0 && docs.length === 0 ? 'none' : 'repo_allowlist',
    instructions,
    docs,
    warnings,
  };
}
