import { spawnSync } from 'child_process';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

// Canonical local dev invocation: node bin/vibecode.js (deterministic, no global PATH dependency)
function runCli(args: string[]) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'vibecode.js'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('CLI basics', () => {
  test('vibecode --help exits 0 and outputs help text', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output.toLowerCase()).toContain('vibecode');
  });

  test('vibecode doctor exits 0 and reports status', () => {
    const result = runCli(['doctor']);
    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output.toLowerCase()).toContain('status');
  });

  test('help output includes VibecodeLight commands: doctor, init, run', () => {
    const result = runCli(['--help']);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('doctor');
    expect(output).toContain('init');
    expect(output).toContain('run');
  });

  test('help output does NOT include stale VibecodeApp commands', () => {
    const result = runCli(['--help']);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toContain('inventory');
    expect(output).not.toContain('dashboard');
    expect(output).not.toContain('monitor');
    expect(output).not.toContain('export-agents');
  });

  test('vibecode init --repo <tmpdir> exits 0', () => {
    const os = require('os');
    const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-init-'));
    const result = runCli(['init', '--repo', tmp]);
    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('.vibecode');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('vibecode run create exits 0 and prints run ID', () => {
    // Need .vibecode/ to exist - run from repoRoot which should have it after init smoke
    const result = runCli(['run', 'create', 'cli regression test']);
    expect(result.status).toBe(0);
    const output = result.stdout.trim();
    // run ID format: YYYYMMDD-HHMMSS-XXXX
    expect(output).toMatch(/^\d{8}-\d{6}-[A-Z0-9]{4}$/);
  });

  test('vibecode prompt --help advertises the --auto-approve flag', () => {
    const result = runCli(['prompt', '--help']);
    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('--auto-approve');
  });
});
