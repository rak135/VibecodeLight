import {
  AGENT_GUIDANCE_CONFIG_FILENAME,
  AGENT_GUIDANCE_SCHEMA_VERSION,
  defaultAgentGuidanceConfig,
  ensureLocalConfig,
  getAgentGuidanceConfigPath,
  getConfigPaths,
  readAgentGuidanceConfig,
  readCodeGraphTransportSetting,
  readDesktopAutoApproveEnabledSetting,
  readDesktopCodeGraphModeSetting,
  readDesktopTaskNormalizerEnabledSetting,
  rememberLiveSelection,
  resetAgentGuidanceConfig,
  resetCodeGraphTransportSetting,
  resetDesktopAutoApproveEnabledSetting,
  resetDesktopCodeGraphModeSetting,
  resetDesktopTaskNormalizerEnabledSetting,
  resolveFlashConfig,
  syncConfig,
  writeAgentGuidanceConfig,
  writeCodeGraphTransportSetting,
  writeDesktopAutoApproveEnabledSetting,
  writeDesktopCodeGraphModeSetting,
  writeDesktopTaskNormalizerEnabledSetting,
  type AgentGuidanceConfig,
} from '../../core/config/index.js';
import { buildAgentGuidanceMcpTools } from '../../core/config/agent_guidance_mcp_tools.js';
import { buildAgentGuidanceRuntime } from '../../core/agent_guidance/agent_guidance_runtime.js';
import {
  applyAgentGuidanceIntegration,
  getAgentGuidanceIntegrationStatus,
  type AgentGuidanceIntegrationAgent,
} from '../../core/agent_guidance/agent_guidance_apply.js';
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

function desktopCodeGraphModePayload(setting: ReturnType<typeof readDesktopCodeGraphModeSetting>) {
  return {
    ok: true,
    mode: setting.mode,
    default: setting.default,
    source: setting.source,
    global_config_path: setting.globalConfigPath,
    global_config_exists: setting.globalConfigExists,
    warnings: setting.warnings,
  };
}

function desktopCodeGraphModeWritePayload(setting: ReturnType<typeof writeDesktopCodeGraphModeSetting>) {
  return {
    ...desktopCodeGraphModePayload(setting),
    artifactPath: setting.artifactPath,
  };
}

function desktopBooleanPayload(setting: ReturnType<typeof readDesktopTaskNormalizerEnabledSetting>) {
  return {
    ok: true,
    enabled: setting.enabled,
    default: setting.default,
    source: setting.source,
    global_config_path: setting.globalConfigPath,
    global_config_exists: setting.globalConfigExists,
    warnings: setting.warnings,
  };
}

function desktopBooleanWritePayload(setting: ReturnType<typeof writeDesktopTaskNormalizerEnabledSetting>) {
  return {
    ...desktopBooleanPayload(setting),
    artifactPath: setting.artifactPath,
  };
}

function invalidDesktopSettingPayload(code: string, raw: unknown, expected: string) {
  return {
    ok: false,
    error: {
      code,
      message: `Invalid desktop setting: ${String(raw)}`,
      details: [expected],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceAgentGuidanceConfig(raw: unknown):
  | { ok: true; config: AgentGuidanceConfig }
  | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'expected a config object' };
  const defaults = defaultAgentGuidanceConfig();
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled;
  const applyToTerminal =
    typeof raw.apply_to_terminal_agents === 'boolean'
      ? raw.apply_to_terminal_agents
      : defaults.apply_to_terminal_agents;
  const guidance =
    typeof raw.default_guidance === 'string' ? raw.default_guidance : defaults.default_guidance;
  const scope = raw.scope === 'global' ? 'global' : defaults.scope;
  const perToolRaw = raw.per_tool_notes;
  const perToolNotes: Record<string, string> = {};
  if (isRecord(perToolRaw)) {
    for (const [key, value] of Object.entries(perToolRaw)) {
      if (typeof value === 'string') perToolNotes[key] = value;
    }
  } else if (perToolRaw !== undefined) {
    return { ok: false, reason: 'per_tool_notes must be a mapping of string notes' };
  }
  return {
    ok: true,
    config: {
      schema_version: AGENT_GUIDANCE_SCHEMA_VERSION,
      enabled,
      apply_to_terminal_agents: applyToTerminal,
      scope,
      default_guidance: guidance,
      per_tool_notes: perToolNotes,
    },
  };
}

function agentGuidanceReadPayload(result: ReturnType<typeof readAgentGuidanceConfig>) {
  if (!result.ok && result.error) {
    return {
      ok: false,
      config: result.config,
      source: result.source,
      exists: result.exists,
      configPath: result.configPath,
      warnings: result.warnings,
      error: {
        code: result.error.code,
        message: result.error.message,
        details: [`Inspect ${result.configPath} to fix the YAML or delete the file to fall back to defaults.`],
      },
    };
  }
  return {
    ok: true,
    config: result.config,
    source: result.source,
    exists: result.exists,
    configPath: result.configPath,
    warnings: result.warnings,
  };
}

function agentGuidanceWritePayload(result: ReturnType<typeof writeAgentGuidanceConfig>) {
  return {
    ok: result.ok,
    config: result.config,
    configPath: result.configPath,
    warnings: result.warnings,
  };
}

function parseIntegrationAgent(raw: unknown): AgentGuidanceIntegrationAgent | null {
  return raw === 'claude' || raw === 'codex' ? raw : null;
}

function invalidIntegrationAgentPayload(raw: unknown) {
  return {
    ok: false,
    warnings: [],
    error: {
      code: 'INVALID_AGENT',
      message: `Invalid agent: ${String(raw)}`,
      details: ['Expected one of: claude, codex.'],
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

  ipcMain.handle('config:getDesktopCodeGraphModeSetting', () => {
    return desktopCodeGraphModePayload(readDesktopCodeGraphModeSetting({ env: process.env }));
  });

  ipcMain.handle('config:setDesktopCodeGraphModeSetting', (_event, mode: unknown) => {
    if (mode !== 'detect-only' && mode !== 'use-existing') {
      return invalidDesktopSettingPayload(
        'INVALID_DESKTOP_CODEGRAPH_MODE',
        mode,
        'Expected one of: detect-only, use-existing.',
      );
    }
    return desktopCodeGraphModeWritePayload(writeDesktopCodeGraphModeSetting({ mode, env: process.env }));
  });

  ipcMain.handle('config:resetDesktopCodeGraphModeSetting', () => {
    return desktopCodeGraphModeWritePayload(resetDesktopCodeGraphModeSetting({ env: process.env }));
  });

  ipcMain.handle('config:getDesktopTaskNormalizerEnabledSetting', () => {
    return desktopBooleanPayload(readDesktopTaskNormalizerEnabledSetting({ env: process.env }));
  });

  ipcMain.handle('config:setDesktopTaskNormalizerEnabledSetting', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return invalidDesktopSettingPayload(
        'INVALID_DESKTOP_TASK_NORMALIZER_ENABLED',
        enabled,
        'Expected a boolean.',
      );
    }
    return desktopBooleanWritePayload(writeDesktopTaskNormalizerEnabledSetting({ enabled, env: process.env }));
  });

  ipcMain.handle('config:resetDesktopTaskNormalizerEnabledSetting', () => {
    return desktopBooleanWritePayload(resetDesktopTaskNormalizerEnabledSetting({ env: process.env }));
  });

  ipcMain.handle('config:getDesktopAutoApproveEnabledSetting', () => {
    return desktopBooleanPayload(readDesktopAutoApproveEnabledSetting({ env: process.env }));
  });

  ipcMain.handle('config:setDesktopAutoApproveEnabledSetting', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return invalidDesktopSettingPayload(
        'INVALID_DESKTOP_AUTO_APPROVE_ENABLED',
        enabled,
        'Expected a boolean.',
      );
    }
    return desktopBooleanWritePayload(writeDesktopAutoApproveEnabledSetting({ enabled, env: process.env }));
  });

  ipcMain.handle('config:resetDesktopAutoApproveEnabledSetting', () => {
    return desktopBooleanWritePayload(resetDesktopAutoApproveEnabledSetting({ env: process.env }));
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

  ipcMain.handle('config:getAgentGuidanceConfig', () => {
    return agentGuidanceReadPayload(readAgentGuidanceConfig({ env: process.env }));
  });

  ipcMain.handle('config:setAgentGuidanceConfig', (_event, payload: unknown) => {
    const parsed = coerceAgentGuidanceConfig(payload);
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          code: 'INVALID_AGENT_GUIDANCE_CONFIG',
          message: `Invalid agent guidance config: ${parsed.reason}.`,
          details: ['Expected an object with schema_version, enabled, default_guidance, and per_tool_notes.'],
        },
      };
    }
    return agentGuidanceWritePayload(writeAgentGuidanceConfig({ env: process.env, config: parsed.config }));
  });

  ipcMain.handle('config:resetAgentGuidanceConfig', () => {
    return agentGuidanceWritePayload(resetAgentGuidanceConfig({ env: process.env }));
  });

  ipcMain.handle('config:getAgentGuidanceDefaults', () => {
    return {
      ok: true,
      config: defaultAgentGuidanceConfig(),
    };
  });

  ipcMain.handle('config:getAgentGuidanceConfigPath', () => {
    return {
      ok: true,
      configPath: getAgentGuidanceConfigPath(process.env),
      filename: AGENT_GUIDANCE_CONFIG_FILENAME,
    };
  });

  ipcMain.handle('config:getAgentGuidanceMcpTools', () => {
    return {
      ok: true,
      tools: buildAgentGuidanceMcpTools(),
    };
  });

  ipcMain.handle('config:getAgentGuidanceRuntimeStatus', () => {
    const runtime = buildAgentGuidanceRuntime({ env: process.env });
    return {
      ok: true,
      enabled: runtime.enabled,
      apply_to_terminal_agents: runtime.apply_to_terminal_agents,
      source: runtime.source,
      config_valid: runtime.config_valid,
      guidance_hash: runtime.guidance_hash,
      config_path: runtime.config_path,
      expected_tool_count: buildAgentGuidanceMcpTools().length,
      warnings: runtime.warnings,
    };
  });

  ipcMain.handle('config:getAgentGuidanceIntegrationStatus', (_event, agentRaw: unknown) => {
    const agent = parseIntegrationAgent(agentRaw);
    if (!agent) return invalidIntegrationAgentPayload(agentRaw);
    return getAgentGuidanceIntegrationStatus({
      agent,
      repoRoot: options.getRepoPath(),
      env: process.env,
    });
  });

  ipcMain.handle('config:dryRunAgentGuidanceIntegration', (_event, agentRaw: unknown) => {
    const agent = parseIntegrationAgent(agentRaw);
    if (!agent) return invalidIntegrationAgentPayload(agentRaw);
    return applyAgentGuidanceIntegration({
      agent,
      repoRoot: options.getRepoPath(),
      env: process.env,
      dryRun: true,
    });
  });

  ipcMain.handle('config:applyAgentGuidanceIntegration', (_event, agentRaw: unknown, confirmed: unknown) => {
    const agent = parseIntegrationAgent(agentRaw);
    if (!agent) return invalidIntegrationAgentPayload(agentRaw);
    if (confirmed !== true) {
      return {
        ok: false,
        warnings: [],
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: 'Agent Guidance integration apply requires explicit confirmation. Run dry-run first.',
          details: ['No terminal text, repo instruction file, approval setting, or permission setting was written.'],
        },
      };
    }
    return applyAgentGuidanceIntegration({
      agent,
      repoRoot: options.getRepoPath(),
      env: process.env,
      yes: true,
    });
  });
}
