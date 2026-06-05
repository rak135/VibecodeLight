import fs from 'fs';
import path from 'path';

import {
  RENDERER_RUN_ARTIFACTS,
  readRunArtifactText,
} from '../../core/runs/run_artifacts.js';
import { getWorkspacePaths } from '../../core/workspace/paths.js';

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface ArtifactBridgeOptions {
  getRepoPath: () => string;
}

export interface ArtifactReadResult {
  ok: boolean;
  content?: string;
  error?: string;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Renderer-facing artifact read. The renderer never touches the filesystem
 * directly; it calls this through the contextBridge IPC channel.
 *
 * The allowlist, alias-free normalization, and per-artifact path-escape guard
 * all live in `src/core/runs/run_artifacts.ts`; this function adds only the
 * desktop-specific input validation, the runs-directory existence check, and
 * the legacy flat-error string format that the renderer already consumes.
 */
export function readRunArtifact(repoRoot: string, runId: string, relativePath: string): ArtifactReadResult {
  if (!repoRoot) return { ok: false, error: 'repo root required' };
  if (!runId) return { ok: false, error: 'run id required' };
  if (!relativePath) return { ok: false, error: 'artifact path required' };

  const paths = getWorkspacePaths(repoRoot);
  const runsDir = path.resolve(paths.runs);
  const runDir = path.resolve(runsDir, runId);
  if (!isInside(runsDir, runDir)) {
    return { ok: false, error: 'run id resolves outside the runs directory' };
  }
  if (!fs.existsSync(runDir)) {
    return { ok: false, error: `run not found: ${runId}` };
  }

  // The shared core resolver applies the renderer allowlist (no CLI aliases),
  // checks the per-artifact path-escape guard, and reads the file as UTF-8.
  // Error codes are translated back into the legacy flat error strings the
  // renderer already handles.
  const result = readRunArtifactText(runDir, relativePath, {
    allowlist: RENDERER_RUN_ARTIFACTS,
    applyAliases: false,
  });

  if (result.ok) {
    return { ok: true, content: result.value.content };
  }

  if (result.error.code === 'ARTIFACT_NOT_ALLOWED') {
    return { ok: false, error: `artifact path is not allowed: ${relativePath}` };
  }
  if (result.error.code === 'PATH_OUTSIDE_RUN') {
    return { ok: false, error: 'artifact path resolves outside the run directory' };
  }
  return { ok: false, error: result.error.message };
}

export function registerDesktopArtifactIpcHandlers(ipcMain: IpcMainLike, options: ArtifactBridgeOptions): void {
  ipcMain.handle('artifacts:readRunArtifact', (_event, ...args: unknown[]) => {
    const runId = typeof args[0] === 'string' ? args[0] : '';
    const relativePath = typeof args[1] === 'string' ? args[1] : '';
    return readRunArtifact(options.getRepoPath(), runId, relativePath);
  });
}
