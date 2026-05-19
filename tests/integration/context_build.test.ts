import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../..');

function runCli(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'vibecode.js'), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
}

describe('context-build command', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-context-build-'));
    fs.writeFileSync(path.join(tmpRepo, 'hello.py'), 'print("hello")\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('vibecode context-build "task" --repo <tmpdir> exits 0', () => {
    const result = runCli(['context-build', 'integration task', '--repo', tmpRepo]);
    expect(result.status).toBe(0);
  });

  test('vibecode context-build "task" --json returns canonical envelope with run_id and artifact paths', () => {
    const result = runCli(['context-build', 'integration json task', '--repo', tmpRepo, '--json']);
    expect(result.status).toBe(0);

    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data).toHaveProperty('run_id');
    expect(payload.data).toHaveProperty('flash_dir');
    expect(Array.isArray(payload.artifacts)).toBe(true);
    expect(Array.isArray(payload.warnings)).toBe(true);
    const artifactNames = payload.artifacts.map((entry: string) => path.basename(entry));
    expect(artifactNames).toContain('scan_manifest.json');
    expect(artifactNames).toContain('skills_catalog.json');
    expect(artifactNames).toContain('flash_input_manifest.json');
    expect(artifactNames).toContain('flash_input.md');
  });

  test('vibecode context-build creates scan, skills, and flash artifacts', () => {
    const result = runCli(['context-build', 'artifact creation task', '--repo', tmpRepo]);
    expect(result.status).toBe(0);

    const runsDir = path.join(tmpRepo, '.vibecode', 'runs');
    const runs = fs.readdirSync(runsDir);
    expect(runs.length).toBeGreaterThanOrEqual(1);

    const runDir = path.join(runsDir, runs[0]);
    expect(fs.existsSync(path.join(runDir, 'scan', 'scan_manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'skills', 'skills_catalog.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_input_manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_input.md'))).toBe(true);
  });
});
