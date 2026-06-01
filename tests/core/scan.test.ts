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

  test('root config.yaml is scanned as an ordinary project file only', () => {
    fs.writeFileSync(path.join(tmpRepo, 'config.yaml'), 'defaults:\n  flash:\n    provider: fake-root-provider\n', 'utf8');

    const result = runCli(['scan', 'ordinary root config scan', '--json'], tmpRepo);
    expect(result.status).toBe(0);
    const jsonOut = JSON.parse(result.stdout.trim());
    const runDir = path.dirname(jsonOut.data.scan_dir);
    const scanDir = jsonOut.data.scan_dir;
    const repoTree = fs.readFileSync(path.join(scanDir, 'repo_tree.txt'), 'utf8');
    const inventory = JSON.parse(fs.readFileSync(path.join(scanDir, 'file_inventory.json'), 'utf8'));
    const scannerConfig = fs.readFileSync(path.join(runDir, 'scanner_config.json'), 'utf8');
    const configSnapshot = fs.readFileSync(path.join(scanDir, 'config_snapshot.json'), 'utf8');

    expect(repoTree).toContain('config.yaml');
    const inventoryEntries = Array.isArray(inventory) ? inventory : inventory.files;
    expect(inventoryEntries.some((entry: { path: string }) => entry.path === 'config.yaml')).toBe(true);
    expect(scannerConfig).not.toContain('fake-root-provider');
    expect(configSnapshot).not.toContain('fake-root-provider');
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

  test('vibecode scan "task" --json returns canonical envelope {ok, data, artifacts, warnings}', () => {
    const result = runCli(['scan', 'json test', '--json'], tmpRepo);
    expect(result.status).toBe(0);
    const jsonOut = JSON.parse(result.stdout.trim());
    expect(jsonOut).toHaveProperty('ok', true);
    expect(jsonOut).toHaveProperty('data');
    expect(jsonOut).toHaveProperty('artifacts');
    expect(jsonOut).toHaveProperty('warnings');
    expect(jsonOut.data).toHaveProperty('run_id');
    expect(typeof jsonOut.data.run_id).toBe('string');
    expect(Array.isArray(jsonOut.artifacts)).toBe(true);
    expect(Array.isArray(jsonOut.warnings)).toBe(true);
  });

  test('vibecode scan "task" --json artifacts list includes manifests/commands/tooling/environment', () => {
    const result = runCli(['scan', 'manifest commands env test', '--json'], tmpRepo);
    expect(result.status).toBe(0);
    const jsonOut = JSON.parse(result.stdout.trim());
    const artifactNames = jsonOut.artifacts.map((a: string) => a.split(/[\\/]/).pop());
    expect(artifactNames).toContain('manifests.json');
    expect(artifactNames).toContain('commands.json');
    expect(artifactNames).toContain('tooling.json');
    expect(artifactNames).toContain('environment.json');
  });

  test('vibecode scan "task" --json artifacts list includes documentation artifacts', () => {
    const result = runCli(['scan', 'docs scan test', '--json'], tmpRepo);
    expect(result.status).toBe(0);
    const jsonOut = JSON.parse(result.stdout.trim());
    const artifactNames = jsonOut.artifacts.map((a: string) => a.split(/[\\/]/).pop());
    expect(artifactNames).toContain('repo_instructions.json');
    expect(artifactNames).toContain('docs.json');
    expect(artifactNames).toContain('architecture_docs.json');
  });

  test('vibecode scan "task" --json artifacts list includes code map artifacts', () => {
    const result = runCli(['scan', 'symbol import test schema keyword history', '--json'], tmpRepo);
    expect(result.status).toBe(0);
    const jsonOut = JSON.parse(result.stdout.trim());
    const artifactNames = jsonOut.artifacts.map((a: string) => a.split(/[\\/]/).pop());
    expect(artifactNames).toContain('symbols.json');
    expect(artifactNames).toContain('imports.json');
    expect(artifactNames).toContain('entrypoints.json');
    expect(artifactNames).toContain('tests.json');
    expect(artifactNames).toContain('schemas.json');
    expect(artifactNames).toContain('keyword_hits.json');
    expect(artifactNames).toContain('recent_history.json');
  });

  test('vibecode scan produces new artifact files on disk', () => {
    const result = runCli(['scan', 'artifact disk test'], tmpRepo);
    expect(result.status).toBe(0);
    const runsDir = path.join(tmpRepo, '.vibecode', 'runs');
    const runs = fs.readdirSync(runsDir);
    const scanDir = path.join(runsDir, runs[0], 'scan');
    expect(fs.existsSync(path.join(scanDir, 'manifests.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'commands.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'tooling.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'environment.json'))).toBe(true);
    // Docs/instruction artifacts
    expect(fs.existsSync(path.join(scanDir, 'repo_instructions.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'docs.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'architecture_docs.json'))).toBe(true);
    // Code-map artifacts
    expect(fs.existsSync(path.join(scanDir, 'symbols.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'imports.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'entrypoints.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'tests.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'schemas.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'keyword_hits.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'recent_history.json'))).toBe(true);
    // Existing base artifacts must still be present
    expect(fs.existsSync(path.join(scanDir, 'repo_tree.txt'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'file_inventory.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'git_status.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'git_diff_stat.txt'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'ignore_rules.json'))).toBe(true);
    expect(fs.existsSync(path.join(scanDir, 'config_snapshot.json'))).toBe(true);
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
