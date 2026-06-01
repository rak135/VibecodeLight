import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import YAML from 'yaml';
import { afterEach, describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-binary-cli-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  return repo;
}

function makeAppData(initialConfig?: unknown): string {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-binary-appdata-'));
  const dir = path.join(appData, 'vibecodelight');
  fs.mkdirSync(dir, { recursive: true });
  if (initialConfig !== undefined) {
    fs.writeFileSync(path.join(dir, 'config.yaml'), YAML.stringify(initialConfig), 'utf8');
  }
  return appData;
}

function runCli(args: string[], cwd: string, localAppData: string, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, LOCALAPPDATA: localAppData };
  delete env.VIBECODE_CODEGRAPH_BIN;
  for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: env as NodeJS.ProcessEnv,
  });
}

describe('vibecode codegraph binary settings CLI', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
    process.exitCode = 0;
  });

  test('binary get --json reports default PATH_FALLBACK when nothing is configured', () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData();
    cleanup.push(tmpRepo, appData);

    const result = runCli(['codegraph', 'binary', 'get', '--json'], tmpRepo, appData);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload).toMatchObject({
      ok: true,
      data: {
        configured: null,
        source: 'PATH_FALLBACK',
        command: 'codegraph',
        global_config_exists: false,
      },
      artifacts: [],
      warnings: [],
    });
  });

  test('binary set <path> persists defaults.codegraph.binary in the global config', () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData({ version: 1, providers: {}, defaults: { flash: {} } });
    cleanup.push(tmpRepo, appData);

    const setResult = runCli(
      ['codegraph', 'binary', 'set', 'C:/bin/codegraph.exe', '--json'],
      tmpRepo,
      appData,
    );
    expect(setResult.status).toBe(0);
    const payload = JSON.parse(setResult.stdout.trim());
    expect(payload).toMatchObject({
      ok: true,
      data: { configured: 'C:/bin/codegraph.exe', source: 'GLOBAL_CONFIG', command: 'C:/bin/codegraph.exe' },
    });
    expect(payload.artifacts).toEqual([path.join(appData, 'vibecodelight', 'config.yaml')]);

    const saved = YAML.parse(
      fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(saved).toMatchObject({ defaults: { codegraph: { binary: 'C:/bin/codegraph.exe' } } });

    const getResult = runCli(['codegraph', 'binary', 'get', '--json'], tmpRepo, appData);
    expect(JSON.parse(getResult.stdout.trim()).data).toMatchObject({
      configured: 'C:/bin/codegraph.exe',
      source: 'GLOBAL_CONFIG',
    });
  });

  test('binary reset removes the persisted binary value and returns to PATH_FALLBACK', () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData({
      version: 1,
      defaults: { codegraph: { binary: 'C:/bin/codegraph.exe', transport: 'mcp' }, flash: {} },
      providers: {},
    });
    cleanup.push(tmpRepo, appData);

    const reset = runCli(['codegraph', 'binary', 'reset', '--json'], tmpRepo, appData);
    expect(reset.status).toBe(0);
    expect(JSON.parse(reset.stdout.trim()).data).toMatchObject({
      configured: null,
      source: 'PATH_FALLBACK',
      command: 'codegraph',
    });

    const saved = YAML.parse(
      fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8'),
    ) as { defaults: { codegraph: Record<string, unknown> } };
    expect(saved.defaults.codegraph).toMatchObject({ transport: 'mcp' });
    expect(saved.defaults.codegraph.binary).toBeUndefined();
  });

  test('binary set with empty path fails with structured validation error', () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData();
    cleanup.push(tmpRepo, appData);

    const result = runCli(['codegraph', 'binary', 'set', '   ', '--json'], tmpRepo, appData);

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('INVALID_CODEGRAPH_BINARY');
    expect(fs.existsSync(path.join(appData, 'vibecodelight', 'config.yaml'))).toBe(false);
  });

  test('codegraph status --json includes binary resolution diagnostics', () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData();
    cleanup.push(tmpRepo, appData);

    const result = runCli(
      ['codegraph', 'status', '--repo', tmpRepo, '--json'],
      tmpRepo,
      appData,
      { VIBECODE_CODEGRAPH_BIN: 'C:/bin/codegraph-from-env.exe' },
    );
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.data.binary).toMatchObject({
      command: 'C:/bin/codegraph-from-env.exe',
      source: 'VIBECODE_CODEGRAPH_BIN',
      configured: 'C:/bin/codegraph-from-env.exe',
    });
  });

  test('codegraph status --json reports PATH_FALLBACK when nothing configured', () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData();
    cleanup.push(tmpRepo, appData);

    const result = runCli(['codegraph', 'status', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.data.binary).toMatchObject({
      command: 'codegraph',
      source: 'PATH_FALLBACK',
      configured: null,
    });
  });

  test('codegraph search with missing binary surfaces attempted binary/source in error', () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData();
    cleanup.push(tmpRepo, appData);

    // Use an explicit `.exe` extension on Windows so the probe does not also
    // attempt a cmd.exe shim path (which would let the probe think the command
    // exists even when the .exe is missing).
    const missingBin = path.join(
      tmpRepo,
      process.platform === 'win32' ? 'does-not-exist-codegraph.exe' : 'does-not-exist-codegraph-binary',
    );

    const result = runCli(
      [
        'codegraph',
        'search',
        'anything',
        '--repo',
        tmpRepo,
        '--json',
        '--codegraph-bin',
        missingBin,
      ],
      tmpRepo,
      appData,
    );
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('CODEGRAPH_NOT_INSTALLED');
    expect(payload.error.attempted_binary).toBe(missingBin);
    expect(payload.error.binary_source).toBe('CLI_OPTION');
  });
});
