import fs from 'fs';
import path from 'path';

import { getCodebaseMapOverview } from '../../core/codebase_map/overview.js';
import { buildCodebaseGraphScene } from '../../core/codebase_map/scene.js';
import type { SceneOverlayInput } from '../../core/codebase_map/scene.js';
import { assembleOverlayData } from '../../core/codebase_map/overlay_assembly.js';
import { getCoordinationOverview } from '../../core/coordination/overview.js';
import { getGitChangedFiles } from '../../core/workspace/git_changed_files.js';

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface CodebaseMapBridgeOptions {
  getRepoPath: () => string;
  /** Optional overlay assembler override for testability. */
  assembleOverlay?: (repoRoot: string, runDir?: string, runId?: string) => SceneOverlayInput;
}

function readRunManifestRunId(runDir: string): string | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'run_manifest.json'), 'utf8'));
    return typeof manifest.run_id === 'string' ? manifest.run_id : undefined;
  } catch {
    return undefined;
  }
}

function resolveLatestRunDir(repoRoot: string): { runDir: string; runId: string } | undefined {
  const currentManifestPath = path.join(repoRoot, '.vibecode', 'current', 'run_manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(currentManifestPath, 'utf8'));
    if (typeof manifest.run_id === 'string') {
      const runDir = path.join(repoRoot, '.vibecode', 'runs', manifest.run_id);
      if (fs.existsSync(runDir)) return { runDir, runId: manifest.run_id };
    }
  } catch {
    // No current pointer
  }
  // Fallback: find latest run directory
  const runsDir = path.join(repoRoot, '.vibecode', 'runs');
  try {
    const entries = fs.readdirSync(runsDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    if (dirs.length > 0) {
      const latestDir = path.join(runsDir, dirs[dirs.length - 1]);
      const runId = readRunManifestRunId(latestDir) ?? dirs[dirs.length - 1];
      return { runDir: latestDir, runId };
    }
  } catch {
    // No runs directory
  }
  return undefined;
}

/**
 * Default overlay assembler: gathers git changes, current run context, and
 * coordination data. All read-only, resilient to missing data.
 */
function defaultAssembleOverlay(repoRoot: string, runDir?: string, runId?: string): SceneOverlayInput {
  // Gather git changed files
  let gitChangedFiles;
  try {
    const gitResult = getGitChangedFiles(repoRoot);
    if (gitResult.ok) {
      gitChangedFiles = gitResult.files;
    }
  } catch {
    // Git not available
  }

  // Gather coordination data
  let coordinationClaims;
  let coordinationConflicts;
  let staleAgentIds;
  try {
    const overview = getCoordinationOverview(repoRoot);
    coordinationClaims = overview.claims.items;
    coordinationConflicts = overview.conflicts.recent;
    // Build stale agent IDs set from overview
    const statusResult = overview;
    staleAgentIds = new Set(
      statusResult.agents.items
        .filter((a) => a.status === 'stale')
        .map((a) => a.agent_id),
    );
  } catch {
    // No coordination state
  }

  return assembleOverlayData(repoRoot, {
    gitChangedFiles,
    currentRunDir: runDir,
    currentRunId: runId,
    coordinationClaims,
    coordinationConflicts,
    staleAgentIds,
  });
}

/**
 * Register desktop Codebase Map IPC handlers. Read-only bridge — never mutates
 * repo state, agents, runs, or .vibecode artifacts.
 */
export function registerDesktopCodebaseMapIpcHandlers(
  ipcMain: IpcMainLike,
  options: CodebaseMapBridgeOptions,
): void {
  ipcMain.handle('codebaseMap:getOverview', () => {
    const repoRoot = options.getRepoPath();
    if (!repoRoot) {
      return {
        ok: true,
        repo_root: '',
        generated_at: new Date().toISOString(),
        source: { kind: 'fallback' as const },
        summary: { total_nodes: 0, displayed_nodes: 0, total_edges: 0, displayed_edges: 0, truncated: false },
        nodes: [],
        edges: [],
        overlays: {},
        warnings: ['No repository root resolved.'],
      };
    }

    const overview = getCodebaseMapOverview(repoRoot, 'latest');

    // Resolve current run for overlay assembly
    const runInfo = resolveLatestRunDir(repoRoot);

    // Assemble overlay data
    const assembleFn = options.assembleOverlay ?? defaultAssembleOverlay;
    const overlayInput = assembleFn(repoRoot, runInfo?.runDir, runInfo?.runId);

    // Build scene with overlays
    const scene = buildCodebaseGraphScene(overview, overlayInput);

    // Return renderer-compatible response with overlays
    // Map scene nodes to include overlay status flags on each node
    const nodesWithOverlayStatus = scene.nodes.map((node) => {
      const mapped: Record<string, unknown> = {
        id: node.id,
        path: node.path,
        label: node.label,
        kind: node.kind,
        group: node.group_id,
        language: node.language,
        lines: node.lines,
      };
      if (node.status.changed) mapped.changed = true;
      if (node.status.entrypoint) mapped.entrypoint = true;
      if (node.status.claimed) mapped.claimed = true;
      if (node.status.conflicted) mapped.conflicted = true;
      return mapped;
    });

    return {
      ok: scene.repo_root !== '',
      repo_root: scene.repo_root,
      generated_at: scene.generated_at,
      source: scene.source,
      summary: {
        total_nodes: scene.summary.total_nodes,
        displayed_nodes: scene.summary.total_nodes,
        total_edges: scene.summary.total_edges,
        displayed_edges: scene.summary.total_edges,
        truncated: false,
      },
      nodes: nodesWithOverlayStatus,
      edges: scene.edges,
      overlays: scene.overlays,
      warnings: scene.warnings,
    };
  });
}
