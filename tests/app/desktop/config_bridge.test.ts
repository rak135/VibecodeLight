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
      fs.writeFileSync(path.join(dir, 'config.yaml'), 'models:\n  flash_provider: "bridge-provider"\n  flash_base_url: "https://b.example.com/v1"\n', 'utf8');
    }
    if (env) {
      fs.writeFileSync(path.join(dir, '.env'), `VIBECODE_FLASH_API_KEY=${SECRET}\n`, 'utf8');
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
    expect(result.resolution.provider).toBe('bridge-provider');
    expect(result.resolution.has_api_key).toBe(true);
    expect(result.resolution).not.toHaveProperty('apiKey');
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

  test('config:syncFromGlobal and syncToGlobal copy in the requested direction only', async () => {
    writeGlobal(true, false);
    const ipc = register();

    const fromGlobal = (await ipc.invoke('config:syncFromGlobal')) as { ok: boolean; direction: string };
    expect(fromGlobal.ok).toBe(true);
    expect(fromGlobal.direction).toBe('from-global');
    expect(fs.readFileSync(path.join(repoRoot, '.vibecode', 'config.yaml'), 'utf8')).toContain('bridge-provider');

    fs.writeFileSync(path.join(repoRoot, '.vibecode', 'config.yaml'), 'models:\n  flash_provider: "edited-local"\n', 'utf8');
    const toGlobal = (await ipc.invoke('config:syncToGlobal')) as { ok: boolean; direction: string };
    expect(toGlobal.ok).toBe(true);
    expect(toGlobal.direction).toBe('to-global');
    expect(fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8')).toContain('edited-local');
  });
});
