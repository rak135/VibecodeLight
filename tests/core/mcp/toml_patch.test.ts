import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  applyCodexMcpInstall,
  buildCodexMcpConfig,
  patchTomlTableBlock,
  resolveCodexConfigPath,
  validateCodexConfigToml,
  CODEX_CONFIG_BACKUP_LIMIT,
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

describe('Codex MCP config write hardening', () => {
  let repoRoot: string;
  let codexHome: string;
  let configPath: string;

  beforeEach(() => {
    repoRoot = makeRepo();
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codex-home-hardening-'));
    configPath = path.join(codexHome, 'config.toml');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  function binPath(): string {
    return path.join(repoRoot, 'bin', 'vibecode.js');
  }

  // ---- Problem 1: parse/validate patched TOML before overwrite ----

  test('rejects an invalid patched TOML without overwriting the original config', () => {
    fs.writeFileSync(configPath, 'model = "gpt-5.5"\n\n[features]\ngoals = true\n', 'utf8');
    const before = read(configPath);

    const result = applyCodexMcpInstall({
      repoRoot,
      scope: 'user',
      codexHome,
      yes: true,
      vibecodeBinPath: binPath(),
      // Inject a validator that rejects, simulating a patch that produced
      // structurally invalid TOML.
      validateToml: () => ({ ok: false, error: 'simulated invalid TOML' }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.error.code).toBe('CODEX_CONFIG_INVALID');
    expect(result.error.message).toMatch(/valid/i);
    // Original config is untouched.
    expect(read(configPath)).toBe(before);
    // No corrupted temp file was left behind, and nothing was renamed into place.
    const leftovers = fs.readdirSync(codexHome).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
    // No backup was retained for a write that never safely completed.
    const backups = fs.readdirSync(codexHome).filter((f) => /^config\.toml\.bak\./.test(f));
    expect(backups).toEqual([]);
  });

  test('a valid patch passes the default validator and preserves unrelated content', () => {
    fs.writeFileSync(configPath, 'model = "gpt-5.5"\n\n[features]\ngoals = true\n', 'utf8');

    const result = applyCodexMcpInstall({
      repoRoot,
      scope: 'user',
      codexHome,
      yes: true,
      vibecodeBinPath: binPath(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const updated = read(configPath);
    expect(updated).toContain('model = "gpt-5.5"');
    expect(updated).toContain('[features]');
    expect(updated).toContain('[mcp_servers.vibecode]');
    // The default validator agrees the final text is structurally valid.
    expect(validateCodexConfigToml(updated).ok).toBe(true);
  });

  test('default validator rejects missing or duplicated [mcp_servers.vibecode] tables', () => {
    expect(validateCodexConfigToml('model = "x"\n').ok).toBe(false);
    const duplicate = [
      '[mcp_servers.vibecode]',
      'command = "node"',
      'args = []',
      'enabled_tools = []',
      '',
      '[mcp_servers.vibecode]',
      'command = "node"',
      'args = []',
      'enabled_tools = []',
      '',
    ].join('\n');
    expect(validateCodexConfigToml(duplicate).ok).toBe(false);
  });

  // ---- Problem 2: POSIX permissions ----

  test('on POSIX, chmod 0600 is applied to the backup and the written config; on win32 it is skipped', () => {
    fs.writeFileSync(configPath, 'model = "x"\n', 'utf8');

    const posixCalls: Array<{ path: string; mode: number }> = [];
    const posixResult = applyCodexMcpInstall({
      repoRoot,
      scope: 'user',
      codexHome,
      yes: true,
      vibecodeBinPath: binPath(),
      platform: 'linux',
      chmod: (p: string, mode: number) => posixCalls.push({ path: p, mode }),
    });

    expect(posixResult.ok).toBe(true);
    if (!posixResult.ok) throw new Error(posixResult.error.message);
    // At least the temp/final write and the backup were chmodded.
    expect(posixCalls.length).toBeGreaterThanOrEqual(2);
    expect(posixCalls.every((c) => c.mode === 0o600)).toBe(true);

    // Reset and verify Windows skips chmod entirely.
    fs.writeFileSync(configPath, 'model = "x"\n', 'utf8');
    const winCalls: Array<{ path: string; mode: number }> = [];
    const winResult = applyCodexMcpInstall({
      repoRoot,
      scope: 'user',
      codexHome,
      yes: true,
      vibecodeBinPath: binPath(),
      platform: 'win32',
      chmod: (p: string, mode: number) => winCalls.push({ path: p, mode }),
    });
    expect(winResult.ok).toBe(true);
    expect(winCalls).toEqual([]);
  });

  // ---- Problem 3: backup pruning ----

  test('prunes old backups to CODEX_CONFIG_BACKUP_LIMIT for the same config only', () => {
    fs.writeFileSync(configPath, 'model = "x"\n', 'utf8');

    // Seven pre-existing timestamped backups for THIS config (sortable past dates).
    const oldBackups: string[] = [];
    for (let i = 1; i <= 7; i += 1) {
      const name = `config.toml.bak.2020-01-0${i}T00-00-00-000Z`;
      fs.writeFileSync(path.join(codexHome, name), `old ${i}\n`, 'utf8');
      oldBackups.push(name);
    }
    // Files that must NOT be pruned: a non-timestamped name, an unrelated file,
    // and a backup belonging to a different config path.
    fs.writeFileSync(path.join(codexHome, 'config.toml.bak'), 'no-timestamp\n', 'utf8');
    fs.writeFileSync(path.join(codexHome, 'other.txt'), 'keep me\n', 'utf8');
    fs.writeFileSync(path.join(codexHome, 'otherconfig.toml.bak.2020-01-01T00-00-00-000Z'), 'different config\n', 'utf8');

    const result = applyCodexMcpInstall({
      repoRoot,
      scope: 'user',
      codexHome,
      yes: true,
      vibecodeBinPath: binPath(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    const remaining = fs.readdirSync(codexHome).filter((f) => /^config\.toml\.bak\.\d/.test(f));
    expect(remaining.length).toBe(CODEX_CONFIG_BACKUP_LIMIT);
    // The freshly created backup (newest) survives.
    expect(remaining.some((f) => !oldBackups.includes(f))).toBe(true);
    // The oldest pre-existing backups were pruned.
    expect(remaining).not.toContain('config.toml.bak.2020-01-01T00-00-00-000Z');
    // Unrelated / differently-named files are untouched.
    expect(fs.existsSync(path.join(codexHome, 'config.toml.bak'))).toBe(true);
    expect(fs.existsSync(path.join(codexHome, 'other.txt'))).toBe(true);
    expect(fs.existsSync(path.join(codexHome, 'otherconfig.toml.bak.2020-01-01T00-00-00-000Z'))).toBe(true);
  });
});
