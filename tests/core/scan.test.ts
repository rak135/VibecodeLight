import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../..');

function runCli(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'vibecode.js'), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
  });
}

describe('scan command', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-scan-test-'));
    // Minimal workspace init
    const vibecodePath = path.join(tmpRepo, '.vibecode');
    fs.mkdirSync(path.join(vibecodePath, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(vibecodePath, 'current'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'hello.py'), 'print("hello")\n');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('vibecode scan "task" exits 0', () => {
    const result = runCli(['scan', 'test task'], tmpRepo);
    expect(result.status).toBe(0);
  });

  test('vibecode scan "task" creates a run directory with scan artifacts', () => {
    const result = runCli(['scan', 'test task'], tmpRepo);
    expect(result.status).toBe(0);

    const runsDir = path.join(tmpRepo, '.vibecode', 'runs');
    const runs = fs.readdirSync(runsDir);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const runDir = path.join(runsDir, runs[0]);
    const scanDir = path.join(runDir, 'scan');
    expect(fs.existsSync(scanDir)).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'scan_manifest.json'))).toBe(true);
  });

  test('vibecode scan "task" writes user_prompt.md', () => {
    const result = runCli(['scan', 'my test task'], tmpRepo);
    expect(result.status).toBe(0);

    const runsDir = path.join(tmpRepo, '.vibecode', 'runs');
    const runs = fs.readdirSync(runsDir);
    const runDir = path.join(runsDir, runs[0]);
    const promptContent = fs.readFileSync(path.join(runDir, 'user_prompt.md'), 'utf8');
    expect(promptContent).toContain('my test task');
  });

  test('vibecode scan "task" --json returns stable JSON envelope', () => {
    const result = runCli(['scan', 'json test', '--json'], tmpRepo);
    expect(result.status).toBe(0);
    const jsonOut = JSON.parse(result.stdout.trim());
    expect(jsonOut).toHaveProperty('status');
    expect(jsonOut).toHaveProperty('run_id');
  });

  test('vibecode scan "task" updates current/run_manifest.json', () => {
    const result = runCli(['scan', 'update current test'], tmpRepo);
    expect(result.status).toBe(0);

    const currentManifestPath = path.join(tmpRepo, '.vibecode', 'current', 'run_manifest.json');
    expect(fs.existsSync(currentManifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(currentManifestPath, 'utf8'));
    expect(manifest.task).toBe('update current test');
  });

  test('vibecode scan --repo <path> uses specified repo path', () => {
    const result = runCli(['scan', 'repo path test', '--repo', tmpRepo]);
    expect(result.status).toBe(0);
  });
});
