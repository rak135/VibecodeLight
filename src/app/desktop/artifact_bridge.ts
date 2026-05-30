import fs from 'fs';
import path from 'path';

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

const ALLOWED_RUN_ARTIFACTS = new Set([
  'flash/flash_output.md',
  'flash/provider_error.json',
  'output/context_pack.md',
  'output/final_prompt.md',
  'config_resolution.json',
  'flash/flash_output_meta.json',
  'scan/codegraph_usage.json',
  'scan/codegraph_context.md',
  'scan/codegraph_repo_atlas.md',
  'scan/codegraph_repo_atlas.json',
  'scan/repo_atlas.md',
  'scan/repo_atlas.json',
]);

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function readRunArtifact(repoRoot: string, runId: string, relativePath: string): ArtifactReadResult {
  if (!repoRoot) return { ok: false, error: 'repo root required' };
  if (!runId) return { ok: false, error: 'run id required' };
  if (!relativePath) return { ok: false, error: 'artifact path required' };

  const safeRelativePath = normalizeRelativePath(relativePath);
  if (!ALLOWED_RUN_ARTIFACTS.has(safeRelativePath)) {
    return { ok: false, error: `artifact path is not allowed: ${relativePath}` };
  }

  const paths = getWorkspacePaths(repoRoot);
  const runsDir = path.resolve(paths.runs);
  const runDir = path.resolve(runsDir, runId);
  if (!isInside(runsDir, runDir)) {
    return { ok: false, error: 'run id resolves outside the runs directory' };
  }
  if (!fs.existsSync(runDir)) {
    return { ok: false, error: `run not found: ${runId}` };
  }

  const artifactPath = path.resolve(runDir, ...safeRelativePath.split('/'));
  if (!isInside(runDir, artifactPath)) {
    return { ok: false, error: 'artifact path resolves outside the run directory' };
  }
  if (!fs.existsSync(artifactPath)) {
    return { ok: false, error: `artifact not found: ${safeRelativePath}` };
  }

  try {
    return { ok: true, content: fs.readFileSync(artifactPath, 'utf8') };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerDesktopArtifactIpcHandlers(ipcMain: IpcMainLike, options: ArtifactBridgeOptions): void {
  ipcMain.handle('artifacts:readRunArtifact', (_event, ...args: unknown[]) => {
    const runId = typeof args[0] === 'string' ? args[0] : '';
    const relativePath = typeof args[1] === 'string' ? args[1] : '';
    return readRunArtifact(options.getRepoPath(), runId, relativePath);
  });
}
