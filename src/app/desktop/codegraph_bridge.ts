/**
 * Desktop IPC bridge for explicit CodeGraph maintenance actions (Phase 1.6).
 *
 * Exposes four channels:
 *   codegraph:status   — detect-only refresh (read-only, no mutation)
 *   codegraph:init     — initialize repo (codegraph init -i)
 *   codegraph:sync     — sync index (codegraph sync)
 *   codegraph:reindex  — full re-index (codegraph index --force)
 *
 * All mutating actions must be triggered by explicit user gesture — they are
 * never called automatically when the composer opens. The renderer calls these
 * via bridge methods, never by spawning processes directly.
 *
 * Anti-scope: no MCP, no context enrichment, no agent config writes.
 */

import {
  getCodeGraphStatus,
  initializeCodeGraphRepo,
  syncCodeGraphRepo,
  reindexCodeGraphRepo,
  type CodeGraphActionResult,
  type CodeGraphStatusResult,
} from '../../adapters/codegraph/codegraph_actions.js';

// ---------------------------------------------------------------------------
// Injectable interfaces (for unit tests)
// ---------------------------------------------------------------------------

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface WorkspaceLike {
  getRepoRoot(): Promise<string>;
}

export interface CodeGraphActionServiceLike {
  getCodeGraphStatus(repoRoot: string): Promise<CodeGraphStatusResult>;
  initializeCodeGraphRepo(repoRoot: string): Promise<CodeGraphActionResult>;
  syncCodeGraphRepo(repoRoot: string): Promise<CodeGraphActionResult>;
  reindexCodeGraphRepo(repoRoot: string): Promise<CodeGraphActionResult>;
}

// ---------------------------------------------------------------------------
// Default service implementation (delegates to action functions directly)
// ---------------------------------------------------------------------------

export const defaultCodeGraphActionService: CodeGraphActionServiceLike = {
  getCodeGraphStatus: (r) => getCodeGraphStatus(r),
  initializeCodeGraphRepo: (r) => initializeCodeGraphRepo(r),
  syncCodeGraphRepo: (r) => syncCodeGraphRepo(r),
  reindexCodeGraphRepo: (r) => reindexCodeGraphRepo(r),
};

// ---------------------------------------------------------------------------
// Bridge registration
// ---------------------------------------------------------------------------

/**
 * Register all CodeGraph IPC handlers on `ipcMain`.
 *
 * @param ipcMain   Electron ipcMain (or test stub).
 * @param workspace Workspace service providing the current repo root.
 * @param service   CodeGraph action service (injected; defaults to real impl).
 */
export function registerCodeGraphBridge(
  ipcMain: IpcMainLike,
  workspace: WorkspaceLike,
  service: CodeGraphActionServiceLike = defaultCodeGraphActionService,
): void {
  // ------------------------------------------------------------------
  // codegraph:status — detect-only, never mutates
  // ------------------------------------------------------------------
  ipcMain.handle('codegraph:status', async (): Promise<CodeGraphStatusResult> => {
    let repoRoot: string;
    try {
      repoRoot = await workspace.getRepoRoot();
    } catch (err) {
      return {
        ok: false,
        available: false,
        initialized: false,
        warnings: [],
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
    return service.getCodeGraphStatus(repoRoot);
  });

  // ------------------------------------------------------------------
  // codegraph:init — explicit user action only
  // ------------------------------------------------------------------
  ipcMain.handle('codegraph:init', async (): Promise<CodeGraphActionResult> => {
    let repoRoot: string;
    try {
      repoRoot = await workspace.getRepoRoot();
    } catch (err) {
      return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
    return service.initializeCodeGraphRepo(repoRoot);
  });

  // ------------------------------------------------------------------
  // codegraph:sync — explicit user action only
  // ------------------------------------------------------------------
  ipcMain.handle('codegraph:sync', async (): Promise<CodeGraphActionResult> => {
    let repoRoot: string;
    try {
      repoRoot = await workspace.getRepoRoot();
    } catch (err) {
      return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
    return service.syncCodeGraphRepo(repoRoot);
  });

  // ------------------------------------------------------------------
  // codegraph:reindex — explicit user action only (may take longer)
  // ------------------------------------------------------------------
  ipcMain.handle('codegraph:reindex', async (): Promise<CodeGraphActionResult> => {
    let repoRoot: string;
    try {
      repoRoot = await workspace.getRepoRoot();
    } catch (err) {
      return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
    return service.reindexCodeGraphRepo(repoRoot);
  });
}
