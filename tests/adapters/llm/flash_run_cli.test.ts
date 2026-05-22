import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

function runCli(args: string[], cwd: string, extraEnv: Record<string, string | undefined> = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.VIBECODE_PROVIDER;
  delete env.VIBECODE_API_KEY;
  delete env.VIBECODE_MODEL;
  delete env.VIBECODE_BASE_URL;
  delete env.VIBECODE_FLASH_PROVIDER;
  delete env.VIBECODE_FLASH_API_KEY;
  delete env.VIBECODE_FLASH_MODEL;
  delete env.VIBECODE_FLASH_BASE_URL;
  delete env.VIBECODE_FLASH_TIMEOUT_MS;
  delete env.VIBECODE_FLASH_MAX_TOKENS;
  delete env.VIBECODE_FLASH_TEMPERATURE;
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env,
  });
}

function makeRepo() {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-flash-run-cli-'));
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'flash run cli fixture\n', 'utf8');
  return tmpRepo;
}

function contextBuild(tmpRepo: string) {
  const result = runCli(['context-build', 'flash run cli task', '--repo', tmpRepo, '--json'], tmpRepo);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim());
}

describe('flash run CLI', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = makeRepo();
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('flash run latest --mock uses existing latest context-build run', () => {
    const built = contextBuild(tmpRepo);

    const result = runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo], tmpRepo);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(built.data.run_id);
    expect(fs.existsSync(path.join(built.data.runDir, 'flash', 'flash_output.md'))).toBe(true);
    expect(fs.existsSync(path.join(built.data.runDir, 'flash', 'flash_output_meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(built.data.runDir, 'flash', 'tool_calls.json'))).toBe(true);
  });

  test('flash run latest --mock fails clearly if latest run has no flash_input.md', () => {
    const runId = '20260101-000000-noinput';
    const runDir = path.join(tmpRepo, '.vibecode', 'runs', runId);
    fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, '.vibecode', 'current'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, '.vibecode', 'current', 'run_manifest.json'),
      `${JSON.stringify({ run_id: runId, created_at: new Date().toISOString(), task: 'missing input', status: 'done' }, null, 2)}\n`,
      'utf8',
    );

    const result = runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo], tmpRepo);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/flash_input\.md/i);
  });

  test('flash run latest --json returns canonical success envelope', () => {
    contextBuild(tmpRepo);

    const result = runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo, '--json'], tmpRepo);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data).toHaveProperty('run_id');
    expect(payload.data).toHaveProperty('flash_output');
    expect(Array.isArray(payload.artifacts)).toBe(true);
    expect(payload.artifacts.map((entry: string) => path.basename(entry))).toEqual([
      'flash_output.md',
      'flash_output_meta.json',
      'tool_calls.json',
    ]);
    expect(payload.warnings).toEqual([]);
  });

  test('flash run latest failure returns canonical error envelope', () => {
    const result = runCli(['flash', 'run', 'latest', '--repo', tmpRepo, '--json'], tmpRepo);

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error).toEqual(expect.objectContaining({
      code: expect.any(String),
      message: expect.any(String),
      details: expect.any(Array),
    }));
  });

  test('normal default tests do not call a real provider', () => {
    contextBuild(tmpRepo);

    const result = runCli(['flash', 'run', 'latest', '--repo', tmpRepo], tmpRepo, {
      VIBECODE_PROVIDER: 'fake-live-provider',
      VIBECODE_API_KEY: 'fake-key',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/--live|live model calls are disabled|provider/i);
  });
});
