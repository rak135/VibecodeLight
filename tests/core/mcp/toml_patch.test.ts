import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  applyCodexMcpInstall,
  buildCodexMcpConfig,
  patchTomlTableBlock,
  resolveCodexConfigPath,
} from '../../../src/core/mcp/codex_config.js';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codex-patch-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  return repo;
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('Codex MCP TOML patching', () => {
  let repoRoot: string;
  let codexHome: string;
  let configPath: string;

  beforeEach(() => {
    repoRoot = makeRepo();
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codex-home-'));
    configPath = path.join(codexHome, 'config.toml');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  test('creates new config if missing', () => {
    const result = applyCodexMcpInstall({
      repoRoot,
      scope: 'user',
      codexHome,
      yes: true,
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.action).toBe('create');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(read(configPath)).toContain('[mcp_servers.vibecode]');
    expect(result.backup_path).toBeNull();
  });

  test('appends [mcp_servers.vibecode] to existing config and preserves unrelated settings', () => {
    fs.writeFileSync(configPath, 'model = "gpt-5.5"\n\n[features]\ngoals = true\n', 'utf8');

    const result = applyCodexMcpInstall({
      repoRoot,
      scope: 'user',
      codexHome,
      yes: true,
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.action).toBe('create');
    const updated = read(configPath);
    expect(updated).toContain('model = "gpt-5.5"');
    expect(updated).toContain('[features]');
    expect(updated).toContain('[mcp_servers.vibecode]');
    expect(result.backup_path).toBeTruthy();
    expect(fs.existsSync(result.backup_path!)).toBe(true);
    expect(read(result.backup_path!)).toContain('model = "gpt-5.5"');
  });

  test('replaces existing [mcp_servers.vibecode] without touching other tables or MCP servers', () => {
    const existing = [
      'approval_policy = "on-request"',
      '',
      '[mcp_servers.other]',
      'command = "npx"',
      '',
      '[mcp_servers.vibecode]',
      'command = "old"',
      'args = ["old"]',
      '',
      '[model_providers.example]',
      'name = "example"',
      '',
    ].join('\n');

    const snippet = buildCodexMcpConfig({
      repoRoot,
      scope: 'user',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    }).toml_snippet;
    const patch = patchTomlTableBlock(existing, 'mcp_servers.vibecode', snippet);

    expect(patch.existed).toBe(true);
    expect(patch.next).toContain('approval_policy = "on-request"');
    expect(patch.next).toContain('[mcp_servers.other]');
    expect(patch.next).toContain('[model_providers.example]');
    expect(patch.next).not.toContain('command = "old"');
    expect(patch.next.match(/\[mcp_servers\.vibecode\]/g)).toHaveLength(1);
  });

  test('project scope resolves <repo>/.codex/config.toml and warns about trusted projects', () => {
    const resolved = resolveCodexConfigPath({ repoRoot, scope: 'project', codexHome });
    expect(resolved.configPath).toBe(path.join(repoRoot, '.codex', 'config.toml'));
    expect(resolved.warnings.some((w) => /trusted projects/i.test(w))).toBe(true);
  });

  test('dry-run writes nothing and reports whether server would be updated', () => {
    fs.writeFileSync(configPath, '[mcp_servers.vibecode]\ncommand = "old"\n', 'utf8');
    const before = read(configPath);

    const result = applyCodexMcpInstall({
      repoRoot,
      scope: 'user',
      codexHome,
      dryRun: true,
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.dry_run).toBe(true);
    expect(result.existing_server).toBe(true);
    expect(result.action).toBe('update');
    expect(read(configPath)).toBe(before);
    expect(result.backup_path).toBeNull();
  });

  test('install without --yes refuses to write and suggests dry-run or --yes', () => {
    const result = applyCodexMcpInstall({
      repoRoot,
      scope: 'user',
      codexHome,
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected install to fail without --yes');
    expect(result.error.code).toBe('CODEX_CONFIG_WRITE_FAILED');
    expect(result.error.message).toMatch(/--dry-run|--yes/);
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
