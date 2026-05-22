import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

const SECRET = 'sk-cli-secret-should-never-print';

function runCli(args: string[], cwd: string, localAppData?: string) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.VIBECODE_PROVIDER;
  delete env.VIBECODE_API_KEY;
  delete env.VIBECODE_MODEL;
  delete env.VIBECODE_BASE_URL;
  delete env.VIBECODE_FLASH_PROVIDER;
  delete env.VIBECODE_FLASH_API_KEY;
  delete env.VIBECODE_FLASH_MODEL;
  delete env.VIBECODE_FLASH_BASE_URL;
  if (localAppData) env.LOCALAPPDATA = localAppData;
  return spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: 'utf8', timeout: 60000, env });
}

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-config-cli-'));
}

function makeAppData(withConfig: boolean, withEnv: boolean) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-config-cli-appdata-'));
  const dir = path.join(appData, 'vibecodelight');
  fs.mkdirSync(dir, { recursive: true });
  if (withConfig) {
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      ['models:', '  flash_provider: "global-provider"', '  flash_base_url: "https://global.example.com/v1"'].join('\n') + '\n',
      'utf8',
    );
  }
  if (withEnv) {
    fs.writeFileSync(path.join(dir, '.env'), `VIBECODE_FLASH_API_KEY=${SECRET}\n`, 'utf8');
  }
  return appData;
}

describe('config CLI', () => {
  let tmpRepo: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    tmpRepo = makeRepo();
    cleanup.push(tmpRepo);
  });

  afterEach(() => {
    while (cleanup.length) {
      const dir = cleanup.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('config paths --json returns a stable envelope', () => {
    const result = runCli(['config', 'paths', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data).toHaveProperty('global_dir');
    expect(payload.data).toHaveProperty('global_config');
    expect(payload.data).toHaveProperty('global_env');
    expect(payload.data.local_config).toBe(path.join(tmpRepo, '.vibecode', 'config.yaml'));
    expect(payload.artifacts).toEqual([]);
    expect(payload.warnings).toEqual([]);
  });

  test('config show --json returns resolved config and source map without API keys', () => {
    const appData = makeAppData(true, true);
    cleanup.push(appData);

    const result = runCli(['config', 'show', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(SECRET);

    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.provider).toBe('global-provider');
    expect(payload.data.has_api_key).toBe(true);
    expect(payload.data.source_map.apiKey).toBe('env');
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(payload.data).not.toHaveProperty('apiKey');
  });

  test('config init-local creates a local config from global', () => {
    const appData = makeAppData(true, false);
    cleanup.push(appData);

    const result = runCli(['config', 'init-local', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.created).toBe(true);
    expect(payload.data.created_from_global).toBe(true);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'config.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpRepo, '.vibecode', 'config.yaml'), 'utf8')).toContain('global-provider');
  });

  test('config sync --from-global copies global config to local', () => {
    const appData = makeAppData(true, false);
    cleanup.push(appData);

    const result = runCli(['config', 'sync', '--from-global', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.direction).toBe('from-global');
    expect(payload.data.destination).toBe(path.join(tmpRepo, '.vibecode', 'config.yaml'));
    expect(fs.readFileSync(path.join(tmpRepo, '.vibecode', 'config.yaml'), 'utf8')).toContain('global-provider');
  });

  test('config sync --to-global copies local config to global', () => {
    const appData = makeAppData(false, false);
    cleanup.push(appData);
    const localPath = path.join(tmpRepo, '.vibecode', 'config.yaml');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, ['models:', '  flash_provider: "local-to-global"'].join('\n') + '\n', 'utf8');

    const result = runCli(['config', 'sync', '--to-global', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.direction).toBe('to-global');
    expect(fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8')).toContain('local-to-global');
  });

  test('config sync requires an explicit direction', () => {
    const result = runCli(['config', 'sync', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('SYNC_DIRECTION_REQUIRED');
  });

  test('config sync rejects both directions at once', () => {
    const result = runCli(['config', 'sync', '--from-global', '--to-global', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('SYNC_DIRECTION_REQUIRED');
  });
});
