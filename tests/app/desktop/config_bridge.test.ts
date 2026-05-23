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

  test('config sync never writes a .env into .vibecode', async () => {
    writeGlobal(true, true);
    const ipc = register();
    await ipc.invoke('config:syncFromGlobal');
    expect(fs.existsSync(path.join(repoRoot, '.vibecode', '.env'))).toBe(false);
    expect(fs.readFileSync(path.join(repoRoot, '.vibecode', 'config.yaml'), 'utf8')).not.toContain(SECRET);
  });
});
