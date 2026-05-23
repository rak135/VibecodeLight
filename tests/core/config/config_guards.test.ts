import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureLocalConfig, syncConfig } from '../../../src/core/config/config_service.js';
import { initWorkspace } from '../../../src/core/workspace/initializer.js';

const repoRoot = path.resolve(__dirname, '../../..');

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else out.push(full);
  }
  return out;
}

describe('config layout guards', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-config-guard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('local config is YAML, never .vibecode/config.json', async () => {
    await initWorkspace(tmpRepo);
    ensureLocalConfig({ repoRoot: tmpRepo, env: process.env });
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'config.json'))).toBe(false);
  });

  test('sync never creates a scan/config.json or .vibecode/config.json', () => {
    fs.mkdirSync(path.join(tmpRepo, '.vibecode'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, '.vibecode', 'config.yaml'),
      'providers:\n  p:\n    type: openai-compatible\n    base_url: https://p.invalid\n    api_key_env: P_KEY\n    models: []\ndefaults:\n  flash:\n    provider: p\n',
      'utf8',
    );
    const globalConfigPath = path.join(tmpRepo, 'global', 'config.yaml');
    // to-global is disabled; verify it does not produce unexpected files
    syncConfig({ direction: 'to-global', repoRoot: tmpRepo, globalConfigPath, localConfigPath: path.join(tmpRepo, '.vibecode', 'config.yaml') });
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRepo, 'scan', 'config.json'))).toBe(false);
  });

  test('sync from-global never writes a .env file under .vibecode', () => {
    const globalConfigPath = path.join(tmpRepo, 'global', 'config.yaml');
    const globalEnvPath = path.join(tmpRepo, 'global', '.env');
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      'providers:\n  p:\n    type: openai-compatible\n    base_url: https://p.invalid\n    api_key_env: P_KEY\n    models: []\ndefaults:\n  flash:\n    provider: p\n',
      'utf8',
    );
    fs.writeFileSync(globalEnvPath, 'P_KEY=sk-should-stay-global\n', 'utf8');
    syncConfig({ direction: 'from-global', repoRoot: tmpRepo, globalConfigPath, localConfigPath: path.join(tmpRepo, '.vibecode', 'config.yaml') });
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', '.env'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpRepo, '.vibecode', 'config.yaml'), 'utf8')).not.toContain('sk-should-stay-global');
  });
});

describe('python scanner config boundary', () => {
  test('python scanner source does not read the global/local YAML config directly', () => {
    const pythonDir = path.join(repoRoot, 'src', 'core', 'scanning', 'python', 'vibecode_scanner');
    const files = collectFiles(pythonDir).filter((f) => f.endsWith('.py'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      // The scanner must never reach into the global user profile or read the
      // human-maintained YAML config as configuration.
      expect(source, `${path.relative(repoRoot, file)} must not reference LOCALAPPDATA`).not.toMatch(/LOCALAPPDATA/);
      expect(source, `${path.relative(repoRoot, file)} must not reference the vibecodelight profile dir`).not.toMatch(/vibecodelight/);
      expect(source, `${path.relative(repoRoot, file)} must not read .vibecode/config.yaml`).not.toMatch(/\.vibecode[\\/]config\.yaml/);
    }
  });
});
