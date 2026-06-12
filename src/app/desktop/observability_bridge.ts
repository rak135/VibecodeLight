import {
  getActivityObservabilityOverview,
  type ActivityObservabilityOverview,
} from '../../core/observability/activity_overview.js';

/**
 * Desktop IPC bridge for read-only activity/attribution observability.
 *
 * Exposes a single channel:
 *   observability:getActivityOverview — agents, MCP tool usage, claims,
 *   workspace safety, and stale-coordination counts.
 *
 * This bridge is observability-only. It deliberately exposes NO mutation
 * channels: no claim add/release/reap, no conflict resolve, no commit, no git
 * mutation, no watcher control, no handoff. All summarizing logic lives in the
 * shared core observability service; this bridge only wires it to IPC so the
 * renderer never reads `.vibecode/` files directly.
 */

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface ObservabilityBridgeOptions {
  getRepoPath: () => string;
}

export interface ActivityOverviewResult {
  ok: boolean;
  overview?: ActivityObservabilityOverview;
  error?: { code: string; message: string; details: string[] };
}

/**
 * Register the read-only observability IPC handler on `ipcMain`.
 */
export function registerDesktopObservabilityIpcHandlers(
  ipcMain: IpcMainLike,
  options: ObservabilityBridgeOptions,
): void {
  ipcMain.handle('observability:getActivityOverview', (): ActivityOverviewResult => {
    const repoRoot = options.getRepoPath();
    if (!repoRoot) {
      return {
        ok: false,
        error: { code: 'REPO_ROOT_REQUIRED', message: 'no repository root resolved', details: [] },
      };
    }
    try {
      return { ok: true, overview: getActivityObservabilityOverview(repoRoot) };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'ACTIVITY_OVERVIEW_FAILED',
          message: err instanceof Error ? err.message : String(err),
          details: [],
        },
      };
    }
  });
}
