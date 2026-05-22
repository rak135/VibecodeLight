import {
  ensureLocalConfig,
  getConfigPaths,
  resolveFlashConfig,
  syncConfig,
} from '../../core/config/index.js';

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface ConfigBridgeOptions {
  getRepoPath: () => string;
}

/**
 * Register desktop config IPC handlers. All resolution/sync logic lives in the
 * shared core config service; this bridge only wires it to IPC. The renderer
 * never receives secrets — config:show returns the safe ConfigResolution only.
 */
export function registerDesktopConfigIpcHandlers(ipcMain: IpcMainLike, options: ConfigBridgeOptions): void {
  ipcMain.handle('config:getPaths', () => {
    const repoRoot = options.getRepoPath();
    const paths = getConfigPaths(repoRoot, process.env);
    return { ok: true, ...paths };
  });

  ipcMain.handle('config:show', () => {
    const repoRoot = options.getRepoPath();
    const resolved = resolveFlashConfig({ repoRoot, env: process.env });
    return { ok: true, resolution: resolved.resolution };
  });

  ipcMain.handle('config:providers', () => {
    const repoRoot = options.getRepoPath();
    const r = resolveFlashConfig({ repoRoot, env: process.env }).resolution;
    return {
      ok: true,
      providers: r.providers,
      active_provider: r.provider,
      active_model: r.model,
      config_source: r.selected_config_source,
      local_config_path: r.local_config_path,
      global_config_path: r.global_config_path,
      global_env_path: r.global_env_path,
    };
  });

  ipcMain.handle('config:models', () => {
    const repoRoot = options.getRepoPath();
    const r = resolveFlashConfig({ repoRoot, env: process.env }).resolution;
    return {
      ok: true,
      providers: r.providers.map((p) => ({
        id: p.id,
        label: p.label,
        has_api_key: p.has_api_key,
        api_key_env: p.api_key_env,
        models: p.models,
      })),
      active_provider: r.provider,
      active_model: r.model,
    };
  });

  ipcMain.handle('config:initLocal', () => {
    const repoRoot = options.getRepoPath();
    return { ok: true, ...ensureLocalConfig({ repoRoot, env: process.env }) };
  });

  ipcMain.handle('config:syncFromGlobal', () => {
    const repoRoot = options.getRepoPath();
    return syncConfig({ direction: 'from-global', repoRoot, env: process.env });
  });

  ipcMain.handle('config:syncToGlobal', () => {
    const repoRoot = options.getRepoPath();
    return syncConfig({ direction: 'to-global', repoRoot, env: process.env });
  });
}
