import {
  ensureLocalConfig,
  getConfigPaths,
  readCodeGraphTransportSetting,
  rememberLiveSelection,
  resetCodeGraphTransportSetting,
  resolveFlashConfig,
  syncConfig,
  writeCodeGraphTransportSetting,
} from '../../core/config/index.js';
import { CODEGRAPH_TRANSPORT_VALUES, parseCodeGraphTransport } from '../../adapters/codegraph/codegraph_transport.js';

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface ConfigBridgeOptions {
  getRepoPath: () => string;
}

function codeGraphTransportPayload(setting: ReturnType<typeof readCodeGraphTransportSetting>) {
  return {
    ok: true,
    transport: setting.transport,
    default: setting.default,
    source: setting.source,
    global_config_path: setting.globalConfigPath,
    global_config_exists: setting.globalConfigExists,
    warnings: setting.warnings,
  };
}

function codeGraphTransportWritePayload(setting: ReturnType<typeof writeCodeGraphTransportSetting>) {
  return {
    ...codeGraphTransportPayload(setting),
    artifactPath: setting.artifactPath,
  };
}

function invalidCodeGraphTransportPayload(raw: unknown) {
  return {
    ok: false,
    error: {
      code: 'INVALID_CODEGRAPH_TRANSPORT',
      message: `Invalid CodeGraph transport: ${String(raw)}`,
      details: [`Expected one of: ${CODEGRAPH_TRANSPORT_VALUES.join(', ')}.`],
    },
  };
}

/**
 * Register desktop config IPC handlers. All resolution/sync logic lives in the
 * shared core config service; this bridge only wires it to IPC. The renderer
 * never receives secrets — config:show returns the safe ConfigResolution only.
 */
export function registerDesktopConfigIpcHandlers(ipcMain: IpcMainLike, options: ConfigBridgeOptions): void {
  ipcMain.handle('config:getCodeGraphTransportSetting', () => {
    return codeGraphTransportPayload(readCodeGraphTransportSetting({ env: process.env }));
  });

  ipcMain.handle('config:setCodeGraphTransportSetting', (_event, transport: unknown) => {
    const parsed = parseCodeGraphTransport(transport);
    if (!parsed) return invalidCodeGraphTransportPayload(transport);
    return codeGraphTransportWritePayload(writeCodeGraphTransportSetting({ transport: parsed, env: process.env }));
  });

  ipcMain.handle('config:resetCodeGraphTransportSetting', () => {
    return codeGraphTransportWritePayload(resetCodeGraphTransportSetting({ env: process.env }));
  });

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

  ipcMain.handle('config:rememberLiveSelection', (_event, provider: unknown, model: unknown) => {
    const repoRoot = options.getRepoPath();
    return rememberLiveSelection({
      repoRoot,
      provider: typeof provider === 'string' ? provider : '',
      model: typeof model === 'string' ? model : '',
      env: process.env,
    });
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
