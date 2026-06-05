import fs from 'fs';
import path from 'path';

import { LlmAdapterError } from '../../adapters/llm/errors.js';
import { getWorkspacePaths } from '../workspace/paths.js';
import type { RunManifest } from '../models/index.js';

/**
 * Resolve a run-id selector to a concrete `{ runId, runDir }` pair.
 *
 * Accepted selectors:
 *   - `'latest'` — read `.vibecode/current/run_manifest.json` and use the
 *     `run_id` stored in it.
 *   - any other non-empty string — treat as a run id; `runDir` is
 *     `<repo>/.vibecode/runs/<runId>`.
 *
 * Path safety:
 *   - explicit run ids that contain path separators (`/`, `\`) or that
 *     consist of a `..` traversal segment are rejected with `RUN_NOT_FOUND`;
 *   - empty/whitespace-only ids are rejected with `RUN_NOT_FOUND`;
 *   - the resolver never reads any file outside `<repo>/.vibecode/`.
 *
 * Errors are thrown as `LlmAdapterError` so the existing CLI/IPC call sites
 * that already wrap this function in a `try`/`catch` keep working without
 * change. The future MCP server will catch the same error type and translate
 * it into an MCP tool error envelope.
 */
export function resolveRunDir(
  repoRoot: string,
  runSelector: string,
): { runId: string; runDir: string } {
  const paths = getWorkspacePaths(repoRoot);

  if (runSelector === 'latest') {
    const currentManifestPath = path.join(paths.current, 'run_manifest.json');
    if (!fs.existsSync(currentManifestPath)) {
      throw new LlmAdapterError('no latest run found; run context-build first', {
        code: 'RUN_NOT_FOUND',
        path: currentManifestPath,
        details: ['Expected .vibecode/current/run_manifest.json to identify the latest run.'],
      });
    }

    let manifest: Partial<RunManifest>;
    try {
      manifest = JSON.parse(fs.readFileSync(currentManifestPath, 'utf8')) as Partial<RunManifest>;
    } catch (err) {
      throw new LlmAdapterError('latest run manifest is not valid JSON', {
        code: 'RUN_MANIFEST_INVALID',
        path: currentManifestPath,
        details: [err instanceof Error ? err.message : String(err)],
      });
    }
    if (!manifest.run_id) {
      throw new LlmAdapterError('latest run manifest does not contain run_id', {
        code: 'RUN_MANIFEST_INVALID',
        path: currentManifestPath,
        details: [],
      });
    }
    // The persisted run_id is trusted but still routed through the safety
    // check below so a corrupted .vibecode/current cannot escape the runs dir.
    return assertSafeRunId(manifest.run_id, paths.runs);
  }

  return assertSafeRunId(runSelector, paths.runs);
}

function assertSafeRunId(runId: string, runsDir: string): { runId: string; runDir: string } {
  const trimmed = typeof runId === 'string' ? runId.trim() : '';
  if (trimmed.length === 0) {
    throw new LlmAdapterError('run id is required', {
      code: 'RUN_NOT_FOUND',
      path: runsDir,
      details: ['An empty run id is not a valid selector.'],
    });
  }

  if (containsPathSeparator(trimmed) || isTraversalSegment(trimmed)) {
    throw new LlmAdapterError(`invalid run id: ${runId}`, {
      code: 'RUN_NOT_FOUND',
      path: path.join(runsDir, trimmed),
      details: ['Run id must not contain path separators or traversal segments.'],
    });
  }

  // Belt-and-braces: the resolved path must stay inside the runs directory.
  const runDir = path.join(runsDir, trimmed);
  const resolvedRunsDir = path.resolve(runsDir);
  const resolvedRunDir = path.resolve(runDir);
  const rel = path.relative(resolvedRunsDir, resolvedRunDir);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    throw new LlmAdapterError(`invalid run id: ${runId}`, {
      code: 'RUN_NOT_FOUND',
      path: runDir,
      details: ['Resolved run directory escaped the .vibecode/runs root.'],
    });
  }

  return { runId: trimmed, runDir };
}

function containsPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function isTraversalSegment(value: string): boolean {
  return value === '.' || value === '..';
}
