import { getCodebaseMapOverview } from '../../core/codebase_map/overview.js';

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface CodebaseMapBridgeOptions {
  getRepoPath: () => string;
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
        warnings: ['No repository root resolved.'],
      };
    }
    return getCodebaseMapOverview(repoRoot, 'latest');
  });
}
