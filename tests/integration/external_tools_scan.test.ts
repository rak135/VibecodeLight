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

function latestRunDir(tmpRepo: string): string {
  const runsDir = path.join(tmpRepo, '.vibecode', 'runs');
  const runs = fs.readdirSync(runsDir);
  expect(runs.length).toBeGreaterThanOrEqual(1);
  return path.join(runsDir, runs[0]);
}

describe('external_tools scan artifact (end-to-end)', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-ext-tools-e2e-'));
    fs.writeFileSync(path.join(tmpRepo, 'hello.py'), 'print("hello")\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('context-build produces scan/external_tools.json with a detect-only shape', () => {
    const result = runCli(['context-build', 'external tools task', '--repo', tmpRepo]);
    expect(result.status).toBe(0);

    const runDir = latestRunDir(tmpRepo);
    const externalToolsPath = path.join(runDir, 'scan', 'external_tools.json');
    expect(fs.existsSync(externalToolsPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(externalToolsPath, 'utf8'));
    expect(parsed.tools.codegraph.mode).toBe('detect-only');
    expect(typeof parsed.tools.codegraph.available).toBe('boolean');
    expect(typeof parsed.tools.codegraph.initialized).toBe('boolean');
    expect(Array.isArray(parsed.tools.codegraph.warnings)).toBe(true);
  });

  test('scan never fails just because CodeGraph is unavailable, and .codegraph/ is not created', () => {
    const result = runCli(['context-build', 'no codegraph task', '--repo', tmpRepo]);
    expect(result.status).toBe(0);
    // Detect-only must never create .codegraph/.
    expect(fs.existsSync(path.join(tmpRepo, '.codegraph'))).toBe(false);

    const parsed = JSON.parse(
      fs.readFileSync(path.join(latestRunDir(tmpRepo), 'scan', 'external_tools.json'), 'utf8'),
    );
    expect(parsed.tools.codegraph.initialized).toBe(false);
  });

  test('an existing .codegraph/ is detected (initialized=true) and excluded from the scan', () => {
    const codegraphDir = path.join(tmpRepo, '.codegraph');
    fs.mkdirSync(codegraphDir);
    fs.writeFileSync(path.join(codegraphDir, 'codegraph.db'), 'binary');

    const result = runCli(['context-build', 'existing codegraph task', '--repo', tmpRepo]);
    expect(result.status).toBe(0);

    const runDir = latestRunDir(tmpRepo);

    // Detection reports it as initialized.
    const parsed = JSON.parse(fs.readFileSync(path.join(runDir, 'scan', 'external_tools.json'), 'utf8'));
    expect(parsed.tools.codegraph.initialized).toBe(true);
    expect(parsed.tools.codegraph.codegraph_dir).toBe('.codegraph');

    // But .codegraph/ is treated as generated state: excluded from scan inventory/tree.
    const tree = fs.readFileSync(path.join(runDir, 'scan', 'repo_tree.txt'), 'utf8');
    expect(tree).not.toContain('.codegraph');
    expect(tree).not.toContain('codegraph.db');

    const inventory = JSON.parse(
      fs.readFileSync(path.join(runDir, 'scan', 'file_inventory.json'), 'utf8'),
    ) as Array<{ path: string }>;
    expect(inventory.some((entry) => entry.path.includes('.codegraph'))).toBe(false);

    // The user's existing .codegraph/ is preserved (not deleted).
    expect(fs.existsSync(path.join(codegraphDir, 'codegraph.db'))).toBe(true);
  });
});
