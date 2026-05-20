import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      VIBECODE_PROVIDER: undefined,
      VIBECODE_API_KEY: undefined,
      VIBECODE_MODEL: undefined,
      VIBECODE_BASE_URL: undefined,
    },
  });
}

describe('prompt render CLI', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-prompt-render-cli-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'prompt render cli fixture\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('CLI prompt render latest creates final_prompt.md', () => {
    // Full pipeline first
    const build = runCli(['context-build', 'cli prompt render test', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(build.status).toBe(0);
    const built = JSON.parse(build.stdout.trim());

    runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo], tmpRepo);
    runCli(['context', 'finalize', 'latest', '--repo', tmpRepo], tmpRepo);

    const render = runCli(['prompt', 'render', 'latest', '--repo', tmpRepo], tmpRepo);
    expect(render.status).toBe(0);

    const runDir = built.data.runDir;
    expect(fs.existsSync(path.join(runDir, 'output', 'final_prompt.md'))).toBe(true);
  });

  test('CLI prompt render latest --json returns canonical envelope', () => {
    const build = runCli(['context-build', 'cli prompt render json test', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(build.status).toBe(0);

    runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo], tmpRepo);
    runCli(['context', 'finalize', 'latest', '--repo', tmpRepo], tmpRepo);

    const render = runCli(['prompt', 'render', 'latest', '--json', '--repo', tmpRepo], tmpRepo);
    expect(render.status).toBe(0);

    const envelope = JSON.parse(render.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.artifacts)).toBe(true);
    expect(Array.isArray(envelope.warnings)).toBe(true);
    expect(envelope.data).toBeDefined();
  });

  test('CLI prompt render failure returns canonical error envelope', () => {
    // No run at all - should fail
    const render = runCli(['prompt', 'render', 'nonexistent-run-id', '--json', '--repo', tmpRepo], tmpRepo);
    expect(render.status).not.toBe(0);

    const envelope = JSON.parse(render.stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBeDefined();
    expect(typeof envelope.error.code).toBe('string');
    expect(typeof envelope.error.message).toBe('string');
  });
});
