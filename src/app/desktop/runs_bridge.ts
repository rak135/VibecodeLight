import fs from 'fs';
import path from 'path';

import { getRunInfo, listRuns, RunInfo } from '../../core/runs/run_display.js';
import { getWorkspacePaths } from '../../core/workspace/paths.js';

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface RunsBridgeOptions {
  getRepoPath: () => string;
}

export interface RunsListResult {
  ok: boolean;
  runs: RunInfo[];
  error?: { code: string; message: string; details: string[] };
}

export interface RunsShowResult {
  ok: boolean;
  run?: RunInfo;
  error?: { code: string; message: string; path?: string; details: string[] };
}

/**
 * Register desktop runs IPC handlers. All run discovery/inspection logic lives
 * in the shared core run-display module (the same code the CLI `runs list` /
 * `runs show` commands use); this bridge only wires it to IPC. The renderer
 * never reads the filesystem directly.
 */
export function registerDesktopRunsIpcHandlers(ipcMain: IpcMainLike, options: RunsBridgeOptions): void {
  ipcMain.handle('runs:list', (): RunsListResult => {
    const repoRoot = options.getRepoPath();
    if (!repoRoot) {
      return {
        ok: false,
        runs: [],
        error: { code: 'REPO_ROOT_REQUIRED', message: 'no repository root resolved', details: [] },
      };
    }
    const paths = getWorkspacePaths(repoRoot);
    return { ok: true, runs: listRuns(paths.vibecode, paths.runs) };
  });

  ipcMain.handle('runs:show', (_event, ...args: unknown[]): RunsShowResult => {
    const runId = typeof args[0] === 'string' ? args[0] : '';
    const repoRoot = options.getRepoPath();
    if (!repoRoot) {
      return {
        ok: false,
        error: { code: 'REPO_ROOT_REQUIRED', message: 'no repository root resolved', details: [] },
      };
    }
    if (!runId) {
      return {
        ok: false,
        error: { code: 'RUN_ID_REQUIRED', message: 'run id is required', details: [] },
      };
    }
    const paths = getWorkspacePaths(repoRoot);
    const runDir = path.join(paths.runs, runId);
    if (!fs.existsSync(runDir)) {
      return {
        ok: false,
        error: { code: 'RUN_NOT_FOUND', message: `run not found: ${runId}`, path: runDir, details: [] },
      };
    }
    return { ok: true, run: getRunInfo(runDir) };
  });
}
