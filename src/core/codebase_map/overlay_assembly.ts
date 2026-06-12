/**
 * Overlay data assembly: gathers read-only operational data from existing
 * services and produces a SceneOverlayInput for the scene builder.
 *
 * This module never mutates repo state, coordination state, or .vibecode
 * artifacts. It reads from:
 *   - workspace git changed files (live git status)
 *   - current/latest run flash_output_meta.json (run context)
 *   - coordination overview (agent claims, conflicts)
 *
 * Missing data sources produce empty overlays, not crashes.
 */

import fs from 'fs';
import path from 'path';

import type { SceneOverlayInput } from './scene.js';
import type { GitChangedFile } from '../workspace/git_changed_files.js';
import type {
  CoordinationOverviewClaimItem,
  CoordinationOverviewConflictItem,
} from '../coordination/overview.js';

export interface OverlayAssemblyInput {
  /** Pre-fetched git changed files (from getGitChangedFiles). */
  gitChangedFiles?: GitChangedFile[];
  /** Current run directory for reading flash_output_meta. */
  currentRunDir?: string;
  /** Current run ID. */
  currentRunId?: string;
  /** Pre-fetched coordination claims (from getCoordinationOverview). */
  coordinationClaims?: CoordinationOverviewClaimItem[];
  /** Pre-fetched coordination conflicts (from getCoordinationOverview). */
  coordinationConflicts?: CoordinationOverviewConflictItem[];
  /** Set of stale agent IDs for marking stale claims. */
  staleAgentIds?: Set<string>;
}

export interface OverlayAssemblyResult extends SceneOverlayInput {
  warnings: string[];
}

function readJson(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((e): e is string => typeof e === 'string')
    : [];
}

/**
 * Assemble overlay data from pre-fetched sources and on-disk artifacts.
 * Returns a SceneOverlayInput suitable for passing to buildCodebaseGraphScene.
 * All data is read-only and bounded.
 */
export function assembleOverlayData(
  _repoRoot: string,
  input: OverlayAssemblyInput = {},
): OverlayAssemblyResult {
  const warnings: string[] = [];
  const overlay: OverlayAssemblyResult = { warnings };

  // --- Git overlay ---
  if (input.gitChangedFiles !== undefined) {
    const changed_files = input.gitChangedFiles.map((f) => f.path);
    overlay.git = {
      changed_files,
      dirty: changed_files.length > 0,
    };
  }

  // --- Current run overlay ---
  if (input.currentRunDir) {
    const metaPath = path.join(input.currentRunDir, 'flash', 'flash_output_meta.json');
    const meta = readJson(metaPath);

    if (meta) {
      overlay.current_run = {
        run_id: input.currentRunId,
        selected_files: stringArray(meta.relevant_files),
        files_to_read: stringArray(meta.files_to_read_with_tools),
        relevant_tests: stringArray(meta.relevant_tests),
      };
    } else {
      overlay.current_run = {
        run_id: input.currentRunId,
        selected_files: [],
        files_to_read: [],
        relevant_tests: [],
      };
    }
  }

  // --- Agents overlay ---
  if (input.coordinationClaims !== undefined) {
    const staleIds = input.staleAgentIds ?? new Set<string>();
    overlay.agents = {
      claims: input.coordinationClaims.map((claim) => ({
        path: claim.path,
        agent_id: claim.agent_id,
        agent_name: claim.agent_name,
        stale: staleIds.has(claim.agent_id) || claim.status === 'stale',
      })),
    };
  }

  // --- Conflicts overlay ---
  if (input.coordinationConflicts !== undefined) {
    overlay.conflicts = {
      conflicts: input.coordinationConflicts
        .filter((c) => c.status === 'detected')
        .map((c) => ({
          id: c.conflict_id,
          path: c.involved_files.length > 0 ? c.involved_files[0] : undefined,
          blocking_agent: undefined,
          status: c.status as 'detected' | 'resolved',
        })),
    };
  }

  return overlay;
}
