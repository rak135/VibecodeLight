import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  OPENCODE_MCP_SERVER_NAME,
  OPENCODE_MCP_ENABLED_TOOLS,
  buildOpenCodeMcpConfig,
  detectOpenCodeMcpConfig,
  applyOpenCodeMcpInstall,
  resolveOpenCodeConfigPath,
  type OpenCodeConfigScope,
} from '../../../src/core/mcp/opencode_config.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-opencode-config-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  return repo;
}

function makeOpenCodeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-opencode-home-'));
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function expectOk<T extends { ok: boolean }>(result: T): asserts result is T & { ok: true } {
  expect(result.ok).toBe(true);
}

describe('OpenCode MCP config generation', () => {
  let repoRoot: string;
  let opencodeHome: string;

  beforeEach(() => {
    repoRoot = makeRepo();
    opencodeHome = makeOpenCodeHome();
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(opencodeHome, { recursive: true, force: true });
  });

  test('generates the expected OpenCode MCP config with absolute repo and bin paths', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    const result = buildOpenCodeMcpConfig({ repoRoot, scope: 'project', vibecodeBinPath });

    expect(result.agent).toBe('opencode');
    expect(result.scope).toBe('project');
    expect(result.server_name).toBe(OPENCODE_MCP_SERVER_NAME);
    expect(result.command).toEqual([
      'node',
      path.resolve(vibecodeBinPath).replace(/\\/g, '/'),
      'mcp',
      'serve',
      '--repo',
      path.resolve(repoRoot).replace(/\\/g, '/'),
      '--codegraph-transport',
      'auto',
      '--log-level',
      'warn',
    ]);
    expect(result.enabled_tools).toEqual(OPENCODE_MCP_ENABLED_TOOLS);
  });

  test('uses forward slashes for Windows paths in command array', () => {
    const result = buildOpenCodeMcpConfig({
      repoRoot: 'C:\\DATA\\PROJECTS\\VibecodeLight',
      scope: 'user',
      vibecodeBinPath: 'C:\\DATA\\PROJECTS\\VibecodeLight\\bin\\vibecode.js',
    });

    for (const arg of result.command) {
      expect(arg).not.toContain('\\');
    }
    expect(result.command[1]).toBe('C:/DATA/PROJECTS/VibecodeLight/bin/vibecode.js');
    expect(result.command[5]).toBe('C:/DATA/PROJECTS/VibecodeLight');
  });

  test('includes exactly the VibecodeMCP tools and no shell/git/terminal tools', () => {
    const result = buildOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });

    expect(result.enabled_tools).toHaveLength(VIBECODE_MCP_TOOL_NAMES.length);
    expect(result.enabled_tools).toEqual([...VIBECODE_MCP_TOOL_NAMES]);
  });

  test('JSON envelope fields are stable', () => {
    const result = buildOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });

    expect(result).toMatchObject({
      ok: true,
      agent: 'opencode',
      scope: 'project',
      server_name: OPENCODE_MCP_SERVER_NAME,
      warnings: expect.any(Array),
    });
  });

  test('project scope resolves to opencode.json in repo root', () => {
    const result = resolveOpenCodeConfigPath({ repoRoot, scope: 'project' });
    expect(result.configPath).toBe(path.resolve(path.join(repoRoot, 'opencode.json')));
  });

  test('user scope resolves to ~/.config/opencode/opencode.json', () => {
    const result = resolveOpenCodeConfigPath({ repoRoot, scope: 'user', opencodeConfigDir: opencodeHome });
    expect(result.configPath).toBe(path.resolve(path.join(opencodeHome, 'opencode.json')));
  });
});

describe('OpenCode MCP config detection', () => {
  let repoRoot: string;
  let opencodeHome: string;

  beforeEach(() => {
    repoRoot = makeRepo();
    opencodeHome = makeOpenCodeHome();
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(opencodeHome, { recursive: true, force: true });
  });

  test('detects missing project config', () => {
    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });
    expect(result.configured).toBe(false);
    expect(result.status).toBe('not_configured');
    expect(result.effective).toBeUndefined();
  });

  test('detects missing user config', () => {
    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'user',
      opencodeConfigDir: opencodeHome,
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });
    expect(result.configured).toBe(false);
    expect(result.status).toBe('not_configured');
  });

  test('detects configured Vibecode MCP server in project config', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    const expected = buildOpenCodeMcpConfig({ repoRoot, scope: 'project', vibecodeBinPath });
    writeJson(path.join(repoRoot, 'opencode.json'), {
      mcp: {
        vibecode: {
          type: 'local',
          command: expected.command,
          enabled: true,
        },
      },
    });

    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath,
    });
    expect(result.configured).toBe(true);
    expect(result.status).toBe('up_to_date');
    expect(result.effective).toBeDefined();
    expect(result.effective?.server_name).toBe('vibecode');
  });

  test('detects stale config when command differs', () => {
    writeJson(path.join(repoRoot, 'opencode.json'), {
      mcp: {
        vibecode: {
          type: 'local',
          command: ['node', '/old/path/vibecode.js', 'mcp', 'serve', '--repo', '/old/repo'],
          enabled: true,
        },
      },
    });

    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });
    expect(result.configured).toBe(true);
    expect(result.status).toBe('stale');
  });

  test('preserves unrelated config keys when detecting', () => {
    const configPath = path.join(repoRoot, 'opencode.json');
    writeJson(configPath, {
      model: 'anthropic/claude-sonnet-4-5',
      mcp: {
        other_server: { type: 'local', command: ['echo', 'hello'] },
        vibecode: {
          type: 'local',
          command: ['node', 'vibecode.js', 'mcp', 'serve', '--repo', path.resolve(repoRoot).replace(/\\/g, '/')],
          enabled: true,
        },
      },
    });

    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });
    expect(result.configured).toBe(true);

    // Verify the original file was not mutated
    const raw = readJson(configPath) as Record<string, unknown>;
    expect(raw.model).toBe('anthropic/claude-sonnet-4-5');
    expect((raw.mcp as Record<string, unknown>).other_server).toBeDefined();
  });

  test('handles malformed JSON gracefully without crashing', () => {
    fs.writeFileSync(path.join(repoRoot, 'opencode.json'), '{ not valid json', 'utf8');

    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });
    expect(result.configured).toBe(false);
    expect(result.status).toBe('unknown');
    expect(result.warnings.join('\n')).toMatch(/OPENCODE_CONFIG_PARSE_WARNING/);
  });

  test('handles JSONC (comments) gracefully', () => {
    const configPath = path.join(repoRoot, 'opencode.json');
    fs.writeFileSync(configPath, '{\n  // This is a comment\n  "mcp": {}\n}\n', 'utf8');

    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });
    // JSONC with comments cannot be parsed by JSON.parse
    // Should report unknown with a warning about JSONC
    expect(result.configured).toBe(false);
    expect(result.status).toBe('unknown');
    expect(result.warnings.join('\n')).toMatch(/OPENCODE_CONFIG_PARSE_WARNING|JSONC/);
  });

  test('detects partial config with missing type field', () => {
    writeJson(path.join(repoRoot, 'opencode.json'), {
      mcp: {
        vibecode: {
          command: ['node', 'vibecode.js'],
        },
      },
    });

    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });
    // Partial config detected but command won't match expected
    expect(result.configured).toBe(true);
    expect(result.status).toBe('stale');
  });

  test('reports stale when command matches but type is "remote"', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    const expected = buildOpenCodeMcpConfig({ repoRoot, scope: 'project', vibecodeBinPath });
    writeJson(path.join(repoRoot, 'opencode.json'), {
      mcp: {
        vibecode: {
          type: 'remote',
          command: expected.command,
          enabled: true,
        },
      },
    });

    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath,
    });
    expect(result.configured).toBe(true);
    expect(result.status).toBe('stale');
    expect(result.effective?.type).toBe('remote');
    expect(result.warnings.join('\n')).toMatch(/OPENCODE_MCP_TYPE_MISMATCH/);
  });

  test('reports stale when command matches but enabled is false', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    const expected = buildOpenCodeMcpConfig({ repoRoot, scope: 'project', vibecodeBinPath });
    writeJson(path.join(repoRoot, 'opencode.json'), {
      mcp: {
        vibecode: {
          type: 'local',
          command: expected.command,
          enabled: false,
        },
      },
    });

    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath,
    });
    expect(result.configured).toBe(true);
    expect(result.status).toBe('stale');
    expect(result.effective?.enabled).toBe(false);
    expect(result.warnings.join('\n')).toMatch(/OPENCODE_MCP_DISABLED/);
  });

  test('reports stale when command matches but type is missing', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    const expected = buildOpenCodeMcpConfig({ repoRoot, scope: 'project', vibecodeBinPath });
    writeJson(path.join(repoRoot, 'opencode.json'), {
      mcp: {
        vibecode: {
          command: expected.command,
          enabled: true,
        },
      },
    });

    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath,
    });
    expect(result.configured).toBe(true);
    expect(result.status).toBe('stale');
    expect(result.effective?.type).toBe('');
    expect(result.warnings.join('\n')).toMatch(/OPENCODE_MCP_TYPE_MISMATCH/);
  });

  test('reports stale when command matches but enabled is missing', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    const expected = buildOpenCodeMcpConfig({ repoRoot, scope: 'project', vibecodeBinPath });
    writeJson(path.join(repoRoot, 'opencode.json'), {
      mcp: {
        vibecode: {
          type: 'local',
          command: expected.command,
        },
      },
    });

    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath,
    });
    expect(result.configured).toBe(true);
    expect(result.status).toBe('stale');
    expect(result.effective?.enabled).toBe(false);
    expect(result.warnings.join('\n')).toMatch(/OPENCODE_MCP_DISABLED/);
  });

  test('reports up_to_date only when type is local, enabled is true, and command matches', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    const expected = buildOpenCodeMcpConfig({ repoRoot, scope: 'project', vibecodeBinPath });
    writeJson(path.join(repoRoot, 'opencode.json'), {
      mcp: {
        vibecode: {
          type: 'local',
          command: expected.command,
          enabled: true,
        },
      },
    });

    const result = detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath,
    });
    expect(result.configured).toBe(true);
    expect(result.status).toBe('up_to_date');
    expect(result.effective?.type).toBe('local');
    expect(result.effective?.enabled).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  test('detection is read-only and does not write files', () => {
    writeJson(path.join(repoRoot, 'opencode.json'), {
      mcp: {
        vibecode: {
          type: 'local',
          command: ['node', '/wrong/path'],
          enabled: true,
        },
      },
    });

    const before = fs.readdirSync(repoRoot).sort();
    detectOpenCodeMcpConfig({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });
    expect(fs.readdirSync(repoRoot).sort()).toEqual(before);
  });
});

describe('OpenCode MCP install', () => {
  let repoRoot: string;
  let opencodeHome: string;

  beforeEach(() => {
    repoRoot = makeRepo();
    opencodeHome = makeOpenCodeHome();
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(opencodeHome, { recursive: true, force: true });
  });

  test('dry-run returns planned config and writes no files', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    const result = applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath,
      dryRun: true,
    });

    expectOk(result);
    expect(result.dry_run).toBe(true);
    expect(result.action).toBe('create');
    expect(result.existing_server).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'opencode.json'))).toBe(false);
  });

  test('apply requires explicit yes when not dry-run', () => {
    const result = applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      dryRun: false,
      yes: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/--yes|--dry-run/);
    }
    expect(fs.existsSync(path.join(repoRoot, 'opencode.json'))).toBe(false);
  });

  test('apply --yes creates new config file with correct MCP entry', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    const result = applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath,
      yes: true,
    });

    expectOk(result);
    expect(result.action).toBe('create');
    expect(result.existing_server).toBe(false);
    expect(result.backup_path).toBeNull();

    const written = readJson(path.join(repoRoot, 'opencode.json')) as Record<string, unknown>;
    const mcp = written.mcp as Record<string, unknown>;
    const vibecode = mcp.vibecode as Record<string, unknown>;
    expect(vibecode.type).toBe('local');
    expect(vibecode.enabled).toBe(true);
    expect(Array.isArray(vibecode.command)).toBe(true);
    expect((vibecode.command as string[])[0]).toBe('node');
  });

  test('apply --yes preserves unrelated existing config keys', () => {
    const configPath = path.join(repoRoot, 'opencode.json');
    writeJson(configPath, {
      model: 'anthropic/claude-sonnet-4-5',
      small_model: 'anthropic/claude-haiku-4-5',
      autoupdate: true,
    });

    applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    const written = readJson(configPath) as Record<string, unknown>;
    expect(written.model).toBe('anthropic/claude-sonnet-4-5');
    expect(written.small_model).toBe('anthropic/claude-haiku-4-5');
    expect(written.autoupdate).toBe(true);
    expect((written.mcp as Record<string, unknown>).vibecode).toBeDefined();
  });

  test('apply --yes preserves other MCP server entries', () => {
    const configPath = path.join(repoRoot, 'opencode.json');
    writeJson(configPath, {
      mcp: {
        sentry: { type: 'remote', url: 'https://mcp.sentry.dev/mcp' },
      },
    });

    applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    const written = readJson(configPath) as Record<string, unknown>;
    const mcp = written.mcp as Record<string, unknown>;
    expect(mcp.sentry).toEqual({ type: 'remote', url: 'https://mcp.sentry.dev/mcp' });
    expect(mcp.vibecode).toBeDefined();
  });

  test('apply is idempotent - running twice produces the same config', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    applyOpenCodeMcpInstall({ repoRoot, scope: 'project', vibecodeBinPath, yes: true });
    const first = fs.readFileSync(path.join(repoRoot, 'opencode.json'), 'utf8');

    applyOpenCodeMcpInstall({ repoRoot, scope: 'project', vibecodeBinPath, yes: true });
    const second = fs.readFileSync(path.join(repoRoot, 'opencode.json'), 'utf8');

    expect(second).toBe(first);
  });

  test('apply updates stale config', () => {
    const configPath = path.join(repoRoot, 'opencode.json');
    writeJson(configPath, {
      mcp: {
        vibecode: {
          type: 'local',
          command: ['node', '/old/path'],
          enabled: true,
        },
      },
    });

    const result = applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    expectOk(result);
    expect(result.action).toBe('update');
    expect(result.existing_server).toBe(true);

    const written = readJson(configPath) as Record<string, unknown>;
    const mcp = written.mcp as Record<string, unknown>;
    const vibecode = mcp.vibecode as Record<string, unknown>;
    expect((vibecode.command as string[])[1]).not.toBe('/old/path');
  });

  test('apply with user scope writes to global config dir', () => {
    const result = applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'user',
      opencodeConfigDir: opencodeHome,
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    expectOk(result);
    expect(result.config_path).toBe(path.resolve(path.join(opencodeHome, 'opencode.json')).replace(/\\/g, '/'));

    const written = readJson(path.join(opencodeHome, 'opencode.json')) as Record<string, unknown>;
    expect((written.mcp as Record<string, unknown>).vibecode).toBeDefined();
  });

  test('apply with user scope creates backup of existing file', () => {
    const configPath = path.join(opencodeHome, 'opencode.json');
    writeJson(configPath, { model: 'test' });

    const result = applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'user',
      opencodeConfigDir: opencodeHome,
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    expectOk(result);
    expect(result.backup_path).toBeTruthy();
    expect(result.backup_path).toMatch(/\.bak\./);
  });

  test('apply does not write approval/permission keys', () => {
    applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    const written = fs.readFileSync(path.join(repoRoot, 'opencode.json'), 'utf8');
    expect(written).not.toMatch(/allowedTools|deniedTools|hooks|permissions|approval/);
  });

  test('rejects JSONC files with a clear diagnostic', () => {
    const configPath = path.join(repoRoot, 'opencode.json');
    fs.writeFileSync(configPath, '{\n  // comment\n  "model": "test"\n}\n', 'utf8');

    const result = applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('OPENCODE_CONFIG_JSONC_UNSUPPORTED');
      expect(result.error.message).toMatch(/JSONC/);
    }
    // Original file must not be modified
    expect(fs.readFileSync(configPath, 'utf8')).toContain('// comment');
  });

  test('does not write secrets', () => {
    applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    const written = fs.readFileSync(path.join(repoRoot, 'opencode.json'), 'utf8');
    expect(written).not.toMatch(/api[_-]?key|secret|token|password/i);
  });

  test('apply fixes wrong type (remote) while preserving unrelated config', () => {
    const configPath = path.join(repoRoot, 'opencode.json');
    writeJson(configPath, {
      model: 'anthropic/claude-sonnet-4-5',
      mcp: {
        sentry: { type: 'remote', url: 'https://mcp.sentry.dev/mcp' },
        vibecode: {
          type: 'remote',
          command: ['node', '/old/path'],
          enabled: true,
        },
      },
    });

    const result = applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    expectOk(result);
    expect(result.action).toBe('update');
    expect(result.existing_server).toBe(true);

    const written = readJson(configPath) as Record<string, unknown>;
    expect(written.model).toBe('anthropic/claude-sonnet-4-5');
    const mcp = written.mcp as Record<string, unknown>;
    expect(mcp.sentry).toEqual({ type: 'remote', url: 'https://mcp.sentry.dev/mcp' });
    const vibecode = mcp.vibecode as Record<string, unknown>;
    expect(vibecode.type).toBe('local');
    expect(vibecode.enabled).toBe(true);
  });

  test('apply fixes enabled false while preserving unrelated config', () => {
    const configPath = path.join(repoRoot, 'opencode.json');
    writeJson(configPath, {
      small_model: 'anthropic/claude-haiku-4-5',
      mcp: {
        vibecode: {
          type: 'local',
          command: ['node', '/old/path'],
          enabled: false,
        },
      },
    });

    const result = applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    expectOk(result);
    expect(result.action).toBe('update');

    const written = readJson(configPath) as Record<string, unknown>;
    expect(written.small_model).toBe('anthropic/claude-haiku-4-5');
    const vibecode = (written.mcp as Record<string, unknown>).vibecode as Record<string, unknown>;
    expect(vibecode.type).toBe('local');
    expect(vibecode.enabled).toBe(true);
  });

  test('apply fixes missing type while preserving unrelated config', () => {
    const configPath = path.join(repoRoot, 'opencode.json');
    writeJson(configPath, {
      mcp: {
        other_server: { type: 'local', command: ['echo', 'hello'] },
        vibecode: {
          command: ['node', '/old/path'],
          enabled: true,
        },
      },
    });

    const result = applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    expectOk(result);
    expect(result.action).toBe('update');

    const written = readJson(configPath) as Record<string, unknown>;
    const mcp = written.mcp as Record<string, unknown>;
    expect(mcp.other_server).toEqual({ type: 'local', command: ['echo', 'hello'] });
    const vibecode = mcp.vibecode as Record<string, unknown>;
    expect(vibecode.type).toBe('local');
    expect(vibecode.enabled).toBe(true);
  });

  test('apply fixes missing enabled while preserving unrelated config', () => {
    const configPath = path.join(repoRoot, 'opencode.json');
    writeJson(configPath, {
      mcp: {
        vibecode: {
          type: 'local',
          command: ['node', '/old/path'],
        },
      },
    });

    const result = applyOpenCodeMcpInstall({
      repoRoot,
      scope: 'project',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      yes: true,
    });

    expectOk(result);
    expect(result.action).toBe('update');

    const written = readJson(configPath) as Record<string, unknown>;
    const vibecode = (written.mcp as Record<string, unknown>).vibecode as Record<string, unknown>;
    expect(vibecode.type).toBe('local');
    expect(vibecode.enabled).toBe(true);
  });
});
