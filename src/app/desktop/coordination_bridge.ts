import {
  getCoordinationOverview,
  type CoordinationOverview,
} from '../../core/coordination/overview.js';

/**
 * Desktop IPC bridge for read-only multi-agent coordination observability
 * (Phase 5A).
 *
 * Exposes a single channel:
 *   coordination:getOverview — compact, read-only coordination overview
 *
 * This bridge is observability-only. It deliberately exposes NO mutation
 * channels: no claim add/release/reap, no conflict resolve, no scoped commit,
 * no git, no watcher start/stop, no finalize, and no handoff. All summarizing
 * logic lives in the shared core overview service (the same read-only
 * coordination services the CLI/MCP use); this bridge only wires it to IPC and
 * the renderer never reads coordination state from the filesystem directly.
 */

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface CoordinationBridgeOptions {
  getRepoPath: () => string;
}

export interface CoordinationOverviewResult {
  ok: boolean;
  overview?: CoordinationOverview;
  error?: { code: string; message: string; details: string[] };
}

/**
 * Register the read-only coordination IPC handler on `ipcMain`.
 */
export function registerDesktopCoordinationIpcHandlers(
  ipcMain: IpcMainLike,
  options: CoordinationBridgeOptions,
): void {
  ipcMain.handle('coordination:getOverview', (): CoordinationOverviewResult => {
    const repoRoot = options.getRepoPath();
    if (!repoRoot) {
      return {
        ok: false,
        error: { code: 'REPO_ROOT_REQUIRED', message: 'no repository root resolved', details: [] },
      };
    }
    try {
      return { ok: true, overview: getCoordinationOverview(repoRoot) };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'COORDINATION_OVERVIEW_FAILED',
          message: err instanceof Error ? err.message : String(err),
          details: [],
        },
      };
    }
  });
}
