import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerDesktopConfigIpcHandlers } from '../../../src/app/desktop/config_bridge.js';

interface Handler {
  (event: unknown, ...args: unknown[]): unknown;
}

class FakeIpcMain {
  handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler) {
    this.handlers.set(channel, listener);
  }
  invoke(channel: string, ...args: unknown[]) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  }
}

const SECRET = 'sk-bridge-secret-should-never-surface';

describe('desktop config bridge', () => {
  let repoRoot: string;
  let appData: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-bridge-repo-'));
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-bridge-appdata-'));
    process.env.LOCALAPPDATA = appData;
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(appData, { recursive: true, force: true });
  });

  function register() {
    const ipc = new FakeIpcMain();
    registerDesktopConfigIpcHandlers(ipc, { getRepoPath: () => repoRoot });
    return ipc;
  }

  function writeGlobal(config: boolean, env: boolean) {
    const dir = path.join(appData, 'vibecodelight');
    fs.mkdirSync(dir, { recursive: true });
    if (config) {
      const registry = [
        'version: 1',
        'providers:',
        '  openrouter:',
        '    type: openai-compatible',
        '    label: OpenRouter',
        '    base_url: https://openrouter.ai/api/v1',
        '    api_key_env: OPENROUTER_API_KEY',
        '    models:',
        '      - id: deepseek/deepseek-chat',
        '        role: flash',
        '  deepseek:',
        '    type: openai-compatible',
        '    label: DeepSeek',
        '    base_url: https://api.deepseek.com',
        '    api_key_env: DEEPSEEK_API_KEY',
        '    models:',
        '      - id: deepseek-chat',
        '        role: flash',
        'defaults:',
        '  flash:',
        '    provider: openrouter',
        '    model: deepseek/deepseek-chat',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'config.yaml'), registry, 'utf8');
    }
    if (env) {
      fs.writeFileSync(path.join(dir, '.env'), `OPENROUTER_API_KEY=${SECRET}\n`, 'utf8');
    }
  }

  test('config:getPaths returns the local config path under .vibecode', async () => {
    const ipc = register();
    const result = (await ipc.invoke('config:getPaths')) as { ok: boolean; localConfig: string };
    expect(result.ok).toBe(true);
    expect(result.localConfig).toBe(path.join(repoRoot, '.vibecode', 'config.yaml'));
  });

  test('config:show returns the safe resolution without any API key value', async () => {
    writeGlobal(true, true);
    const ipc = register();
    const result = (await ipc.invoke('config:show')) as { ok: boolean; resolution: Record<string, unknown> };
    expect(result.ok).toBe(true);
    expect(result.resolution.provider).toBe('openrouter');
    expect(result.resolution.model).toBe('deepseek/deepseek-chat');
    expect(result.resolution.has_api_key).toBe(true);
    expect(result.resolution.api_key_env).toBe('OPENROUTER_API_KEY');
    expect(result.resolution).not.toHaveProperty('apiKey');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('config:providers lists configured providers and per-provider API key status (no keys)', async () => {
    writeGlobal(true, true);
    const ipc = register();
    const result = (await ipc.invoke('config:providers')) as {
      ok: boolean;
      providers: Array<{ id: string; has_api_key: boolean; api_key_env: string | null; models: unknown[] }>;
      active_provider: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.providers.map((p) => p.id).sort()).toEqual(['deepseek', 'openrouter']);
    const openrouter = result.providers.find((p) => p.id === 'openrouter');
    expect(openrouter?.has_api_key).toBe(true);
    expect(openrouter?.api_key_env).toBe('OPENROUTER_API_KEY');
    expect(result.providers.find((p) => p.id === 'deepseek')?.has_api_key).toBe(false);
    expect(result.active_provider).toBe('openrouter');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('config:models lists models per provider through the core service', async () => {
    writeGlobal(true, true);
    const ipc = register();
    const result = (await ipc.invoke('config:models')) as {
      ok: boolean;
      providers: Array<{ id: string; models: Array<{ id: string }> }>;
    };
    expect(result.ok).toBe(true);
    const openrouter = result.providers.find((p) => p.id === 'openrouter');
    expect(openrouter?.models.map((m) => m.id)).toEqual(['deepseek/deepseek-chat']);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('config:initLocal creates the local config from global', async () => {
    writeGlobal(true, false);
    const ipc = register();
    const result = (await ipc.invoke('config:initLocal')) as { ok: boolean; created: boolean; createdFromGlobal: boolean };
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.createdFromGlobal).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'config.yaml'))).toBe(true);
  });

  test('config:syncFromGlobal copies global to local; config:syncToGlobal is disabled', async () => {
    writeGlobal(true, false);
    const ipc = register();

    const fromGlobal = (await ipc.invoke('config:syncFromGlobal')) as { ok: boolean; direction: string };
    expect(fromGlobal.ok).toBe(true);
    expect(fromGlobal.direction).toBe('from-global');
    expect(fs.readFileSync(path.join(repoRoot, '.vibecode', 'config.yaml'), 'utf8')).toContain('openrouter');

    const toGlobal = (await ipc.invoke('config:syncToGlobal')) as { ok: boolean; error?: { code: string } };
    expect(toGlobal.ok).toBe(false);
    expect(toGlobal.error?.code).toBe('CONFIG_SYNC_TO_GLOBAL_DISABLED');
    // global config must not have been overwritten by local edits
    expect(fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8')).toContain('openrouter');
  });

  test('config:rememberLiveSelection stores the last GUI live provider/model in local config', async () => {
    writeGlobal(true, true);
    const ipc = register();

    const result = (await ipc.invoke('config:rememberLiveSelection', 'deepseek', 'deepseek-chat')) as {
      ok: boolean;
      provider: string;
      model: string;
    };

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('deepseek');
    expect(result.model).toBe('deepseek-chat');
    const localYaml = fs.readFileSync(path.join(repoRoot, '.vibecode', 'config.yaml'), 'utf8');
    expect(localYaml).toContain('provider: deepseek');
    expect(localYaml).toContain('model: deepseek-chat');
  });

  test('config sync never writes a .env into .vibecode', async () => {
    writeGlobal(true, true);
    const ipc = register();
    await ipc.invoke('config:syncFromGlobal');
    expect(fs.existsSync(path.join(repoRoot, '.vibecode', '.env'))).toBe(false);
    expect(fs.readFileSync(path.join(repoRoot, '.vibecode', 'config.yaml'), 'utf8')).not.toContain(SECRET);
  });

  test('config:getCodeGraphTransportSetting reads the global CodeGraph transport setting', async () => {
    writeGlobal(true, false);
    fs.appendFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), '  codegraph:\n    transport: mcp\n', 'utf8');
    const ipc = register();

    const result = (await ipc.invoke('config:getCodeGraphTransportSetting')) as {
      ok: boolean;
      transport: string;
      source: string;
      global_config_path: string;
    };

    expect(result.ok).toBe(true);
    expect(result.transport).toBe('mcp');
    expect(result.source).toBe('global');
    expect(result.global_config_path).toBe(path.join(appData, 'vibecodelight', 'config.yaml'));
  });

  test('config:setCodeGraphTransportSetting writes defaults.codegraph.transport to global config only', async () => {
    writeGlobal(true, false);
    const ipc = register();

    const result = (await ipc.invoke('config:setCodeGraphTransportSetting', 'auto')) as {
      ok: boolean;
      transport: string;
      artifactPath: string;
    };

    expect(result.ok).toBe(true);
    expect(result.transport).toBe('auto');
    expect(result.artifactPath).toBe(path.join(appData, 'vibecodelight', 'config.yaml'));
    const globalYaml = fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8');
    expect(globalYaml).toContain('codegraph:');
    expect(globalYaml).toContain('transport: auto');
    expect(fs.existsSync(path.join(repoRoot, 'config.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'config.yaml'))).toBe(false);
  });

  test('config:resetCodeGraphTransportSetting removes the global value and returns cli', async () => {
    writeGlobal(true, false);
    fs.appendFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), '  codegraph:\n    transport: mcp\n', 'utf8');
    const ipc = register();

    const result = (await ipc.invoke('config:resetCodeGraphTransportSetting')) as { ok: boolean; transport: string; source: string };

    expect(result.ok).toBe(true);
    expect(result.transport).toBe('cli');
    expect(result.source).toBe('default');
    const get = (await ipc.invoke('config:getCodeGraphTransportSetting')) as { ok: boolean; transport: string; source: string };
    expect(get).toMatchObject({ ok: true, transport: 'cli', source: 'default' });
  });

  test('config:setCodeGraphTransportSetting rejects invalid values without writing global config', async () => {
    writeGlobal(true, false);
    const before = fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8');
    const ipc = register();

    const result = (await ipc.invoke('config:setCodeGraphTransportSetting', 'socket')) as {
      ok: boolean;
      error?: { code: string; details: string[] };
    };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_CODEGRAPH_TRANSPORT');
    expect(result.error?.details).toContain('Expected one of: cli, mcp, auto.');
    expect(fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8')).toBe(before);
  });

  test('config desktop CodeGraph mode get/set/reset uses desktop.codegraph.mode in global config only', async () => {
    writeGlobal(true, false);
    const ipc = register();

    const initial = (await ipc.invoke('config:getDesktopCodeGraphModeSetting')) as { ok: boolean; mode: string; source: string };
    expect(initial).toMatchObject({ ok: true, mode: 'detect-only', source: 'default' });

    const written = (await ipc.invoke('config:setDesktopCodeGraphModeSetting', 'use-existing')) as {
      ok: boolean;
      mode: string;
      artifactPath: string;
    };
    expect(written).toMatchObject({ ok: true, mode: 'use-existing', artifactPath: path.join(appData, 'vibecodelight', 'config.yaml') });
    const globalYaml = fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8');
    expect(globalYaml).toContain('desktop:');
    expect(globalYaml).toContain('codegraph:');
    expect(globalYaml).toContain('mode: use-existing');
    expect(fs.existsSync(path.join(repoRoot, 'config.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'config.yaml'))).toBe(false);

    const reset = (await ipc.invoke('config:resetDesktopCodeGraphModeSetting')) as { ok: boolean; mode: string; source: string };
    expect(reset).toMatchObject({ ok: true, mode: 'detect-only', source: 'default' });
  });

  test('config desktop boolean settings get/set/reset use desktop namespace', async () => {
    writeGlobal(true, false);
    const ipc = register();

    expect(await ipc.invoke('config:getDesktopTaskNormalizerEnabledSetting')).toMatchObject({ ok: true, enabled: false, source: 'default' });
    expect(await ipc.invoke('config:setDesktopTaskNormalizerEnabledSetting', true)).toMatchObject({ ok: true, enabled: true });
    expect(await ipc.invoke('config:getDesktopAutoApproveEnabledSetting')).toMatchObject({ ok: true, enabled: false, source: 'default' });
    expect(await ipc.invoke('config:setDesktopAutoApproveEnabledSetting', true)).toMatchObject({ ok: true, enabled: true });

    const globalYaml = fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8');
    expect(globalYaml).toContain('task_normalizer:');
    expect(globalYaml).toContain('auto_approve:');
    expect(globalYaml).toContain('enabled: true');

    expect(await ipc.invoke('config:resetDesktopTaskNormalizerEnabledSetting')).toMatchObject({ ok: true, enabled: false, source: 'default' });
    expect(await ipc.invoke('config:resetDesktopAutoApproveEnabledSetting')).toMatchObject({ ok: true, enabled: false, source: 'default' });
  });

  test('config desktop settings reject invalid values without writing global config or exposing secrets', async () => {
    writeGlobal(true, true);
    const before = fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8');
    const ipc = register();

    const invalidMode = await ipc.invoke('config:setDesktopCodeGraphModeSetting', 'enabled');
    const invalidTask = await ipc.invoke('config:setDesktopTaskNormalizerEnabledSetting', 'true');
    const invalidApprove = await ipc.invoke('config:setDesktopAutoApproveEnabledSetting', 1);

    expect(invalidMode).toMatchObject({ ok: false, error: { code: 'INVALID_DESKTOP_CODEGRAPH_MODE' } });
    expect(invalidTask).toMatchObject({ ok: false, error: { code: 'INVALID_DESKTOP_TASK_NORMALIZER_ENABLED' } });
    expect(invalidApprove).toMatchObject({ ok: false, error: { code: 'INVALID_DESKTOP_AUTO_APPROVE_ENABLED' } });
    expect(fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8')).toBe(before);
    expect(JSON.stringify({ invalidMode, invalidTask, invalidApprove })).not.toContain(SECRET);
  });

  test('config:getAgentGuidanceConfig returns defaults when the dedicated file is missing', async () => {
    const ipc = register();
    const result = (await ipc.invoke('config:getAgentGuidanceConfig')) as {
      ok: boolean;
      config: { enabled: boolean; default_guidance: string; per_tool_notes: Record<string, string> };
      source: string;
      exists: boolean;
      configPath: string;
    };
    expect(result.ok).toBe(true);
    expect(result.source).toBe('default');
    expect(result.exists).toBe(false);
    expect(result.config.enabled).toBe(true);
    expect(result.config.default_guidance).toMatch(/VibecodeMCP/);
    expect(result.configPath).toBe(path.join(appData, 'vibecodelight', 'agent-guidance-config.yaml'));
    // The root and .vibecode config layers must NOT be touched for agent guidance.
    expect(fs.existsSync(path.join(appData, 'vibecodelight', 'config.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'config.yaml'))).toBe(false);
  });

  test('config:getAgentGuidanceConfigPath returns the dedicated path under LOCALAPPDATA', async () => {
    const ipc = register();
    const result = (await ipc.invoke('config:getAgentGuidanceConfigPath')) as {
      ok: boolean;
      configPath: string;
      filename: string;
    };
    expect(result.ok).toBe(true);
    expect(result.configPath).toBe(path.join(appData, 'vibecodelight', 'agent-guidance-config.yaml'));
    expect(result.filename).toBe('agent-guidance-config.yaml');
  });

  test('config:setAgentGuidanceConfig writes to the dedicated file and leaves root config.yaml untouched', async () => {
    writeGlobal(true, false);
    const before = fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8');
    const ipc = register();

    const initial = (await ipc.invoke('config:getAgentGuidanceConfig')) as { config: Record<string, unknown> };
    const next = {
      ...initial.config,
      enabled: false,
      default_guidance: 'Custom guidance from bridge test.',
      per_tool_notes: { vibecode_workspace_info: 'bridge note' },
    };
    const write = (await ipc.invoke('config:setAgentGuidanceConfig', next)) as {
      ok: boolean;
      config: { enabled: boolean; default_guidance: string };
      configPath: string;
    };
    expect(write.ok).toBe(true);
    expect(write.config.enabled).toBe(false);
    expect(write.config.default_guidance).toContain('Custom guidance from bridge test.');
    expect(write.configPath).toBe(path.join(appData, 'vibecodelight', 'agent-guidance-config.yaml'));

    // Reading back via the bridge returns the persisted custom guidance.
    const reread = (await ipc.invoke('config:getAgentGuidanceConfig')) as {
      source: string;
      config: { enabled: boolean; default_guidance: string; per_tool_notes: Record<string, string> };
    };
    expect(reread.source).toBe('file');
    expect(reread.config.enabled).toBe(false);
    expect(reread.config.per_tool_notes.vibecode_workspace_info).toBe('bridge note');

    // Root and .vibecode config layers must not have been used for agent guidance.
    expect(fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'config.yaml'))).toBe(false);
  });

  test('config get/set Agent Guidance terminal preflight settings use the dedicated file only', async () => {
    writeGlobal(true, false);
    const beforeGlobal = fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8');
    const ipc = register();

    const initial = (await ipc.invoke('config:getAgentGuidanceTerminalPreflightConfig')) as {
      ok: boolean;
      terminal_preflight: { enabled: boolean; mode: string; supported_agents: { codex: boolean; claude: boolean } };
      configPath: string;
    };
    expect(initial.ok).toBe(true);
    expect(initial.terminal_preflight).toMatchObject({
      enabled: true,
      mode: 'check_only',
      supported_agents: { codex: true, claude: true },
    });

    const written = (await ipc.invoke('config:setAgentGuidanceTerminalPreflightConfig', {
      enabled: true,
      mode: 'auto_repair',
      supported_agents: { codex: true, claude: false, opencode: true },
      repair: { create_backup: false, require_valid_guidance_config: true },
      configPath: 'C:/other/path.yaml',
    })) as {
      ok: boolean;
      terminal_preflight: { mode: string; supported_agents: { codex: boolean; claude: boolean }; repair: { create_backup: boolean } };
      configPath: string;
    };

    expect(written.ok).toBe(true);
    expect(written.terminal_preflight.mode).toBe('auto_repair');
    expect(written.terminal_preflight.supported_agents).toEqual({ codex: true, claude: false });
    expect(written.terminal_preflight.repair.create_backup).toBe(false);
    expect(written.configPath).toBe(path.join(appData, 'vibecodelight', 'agent-guidance-config.yaml'));
    expect(fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8')).toBe(beforeGlobal);
    expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'config.yaml'))).toBe(false);
  });

  test('config rejects invalid terminal preflight mode and exposes no terminal-write channel', async () => {
    const ipc = register();
    const result = (await ipc.invoke('config:setAgentGuidanceTerminalPreflightConfig', {
      enabled: true,
      mode: 'repair_all',
    })) as { ok: boolean; error?: { code: string } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_TERMINAL_PREFLIGHT_MODE');
    expect(ipc.handlers.has('terminal:input')).toBe(false);
    expect(ipc.handlers.has('config:setAgentGuidanceTerminalPreflightPath')).toBe(false);
  });

  test('config:resetAgentGuidanceConfig restores the default guidance text', async () => {
    const ipc = register();
    const initial = (await ipc.invoke('config:getAgentGuidanceConfig')) as { config: Record<string, unknown> };
    await ipc.invoke('config:setAgentGuidanceConfig', { ...initial.config, enabled: false, default_guidance: 'temporary' });
    const reset = (await ipc.invoke('config:resetAgentGuidanceConfig')) as {
      ok: boolean;
      config: { enabled: boolean; default_guidance: string };
    };
    expect(reset.ok).toBe(true);
    expect(reset.config.enabled).toBe(true);
    expect(reset.config.default_guidance).toMatch(/VibecodeMCP/);
  });

  test('config:getAgentGuidanceDefaults returns built-in defaults without touching the file', async () => {
    const ipc = register();
    const defaultsResp = (await ipc.invoke('config:getAgentGuidanceDefaults')) as {
      ok: boolean;
      config: { enabled: boolean; default_guidance: string };
    };
    expect(defaultsResp.ok).toBe(true);
    expect(defaultsResp.config.enabled).toBe(true);
    expect(defaultsResp.config.default_guidance).toMatch(/VibecodeMCP/);
    expect(fs.existsSync(path.join(appData, 'vibecodelight', 'agent-guidance-config.yaml'))).toBe(false);
  });

  test('config:getAgentGuidanceMcpTools returns read-only tool metadata grouped by area', async () => {
    const ipc = register();
    const result = (await ipc.invoke('config:getAgentGuidanceMcpTools')) as {
      ok: boolean;
      tools: Array<{ name: string; group: string; description: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.tools.length).toBeGreaterThan(0);
    const groups = new Set(result.tools.map((t) => t.group));
    expect(groups).toContain('workspace_orientation');
    expect(groups).toContain('codegraph');
    expect(groups).toContain('runs_artifacts');
    for (const tool of result.tools) {
      expect(tool.name).toMatch(/^vibecode_/);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test('config:setAgentGuidanceConfig rejects non-object payload without writing the file', async () => {
    const ipc = register();
    const result = (await ipc.invoke('config:setAgentGuidanceConfig', 'not-a-config')) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_AGENT_GUIDANCE_CONFIG');
    expect(fs.existsSync(path.join(appData, 'vibecodelight', 'agent-guidance-config.yaml'))).toBe(false);
  });

  test('agent guidance bridge surfaces parse errors as structured diagnostics without overwriting the file', async () => {
    const profileDir = path.join(appData, 'vibecodelight');
    fs.mkdirSync(profileDir, { recursive: true });
    const configPath = path.join(profileDir, 'agent-guidance-config.yaml');
    const broken = ': not valid yaml: : :::\n';
    fs.writeFileSync(configPath, broken, 'utf8');

    const ipc = register();
    const result = (await ipc.invoke('config:getAgentGuidanceConfig')) as {
      ok: boolean;
      error?: { code: string };
      config: { enabled: boolean };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AGENT_GUIDANCE_CONFIG_PARSE_ERROR');
    // Defaults are still returned so the UI can render *something*.
    expect(result.config.enabled).toBe(true);
    // The broken file is preserved untouched for user inspection.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(broken);
  });

  test('config:getAgentGuidanceRuntimeStatus returns hash, source, expected tools, and no secret values', async () => {
    const ipc = register();
    const result = (await ipc.invoke('config:getAgentGuidanceRuntimeStatus')) as {
      ok: boolean;
      enabled: boolean;
      source: string;
      guidance_hash: string;
      config_path: string;
      expected_tool_count: number;
    };
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('defaults');
    expect(result.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.config_path).toBe(path.join(appData, 'vibecodelight', 'agent-guidance-config.yaml'));
    expect(result.expected_tool_count).toBe(29);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('config:getAgentGuidanceIntegrationStatus is repo-bound and supports Claude/Codex only', async () => {
    const ipc = register();
    const codex = (await ipc.invoke('config:getAgentGuidanceIntegrationStatus', 'codex')) as {
      ok: boolean;
      agent: string;
      guidance: { guidance_hash: string };
      mcp: { expected_tool_count: number };
    };
    const claude = (await ipc.invoke('config:getAgentGuidanceIntegrationStatus', 'claude')) as {
      ok: boolean;
      agent: string;
    };
    const invalid = (await ipc.invoke('config:getAgentGuidanceIntegrationStatus', 'opencode')) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(codex.ok).toBe(true);
    expect(codex.agent).toBe('codex');
    expect(codex.guidance.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(codex.mcp.expected_tool_count).toBe(29);
    expect(claude.ok).toBe(true);
    expect(claude.agent).toBe('claude');
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe('INVALID_AGENT');
  });

  test('config:dryRunAgentGuidanceIntegration previews without writing and apply requires confirmation', async () => {
    const ipc = register();
    const dryRun = (await ipc.invoke('config:dryRunAgentGuidanceIntegration', 'codex')) as {
      ok: boolean;
      dry_run: boolean;
      guidance_hash: string;
    };
    expect(dryRun.ok).toBe(true);
    expect(dryRun.dry_run).toBe(true);
    expect(dryRun.guidance_hash).toMatch(/^[a-f0-9]{64}$/);

    const refused = (await ipc.invoke('config:applyAgentGuidanceIntegration', 'codex', false)) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toMatch(/confirm|--yes|dry-run/i);
    expect(fs.existsSync(path.join(appData, 'vibecodelight', 'config.toml'))).toBe(false);
  });

  test('agent guidance integration bridge exposes no terminal write or arbitrary path input', async () => {
    const ipc = register();
    const result = (await ipc.invoke('config:dryRunAgentGuidanceIntegration', 'codex', 'C:/other/repo')) as {
      ok: boolean;
      dry_run: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(ipc.handlers.has('terminal:input')).toBe(false);
    expect(ipc.handlers.has('config:writeAgentGuidancePath')).toBe(false);
  });
});
