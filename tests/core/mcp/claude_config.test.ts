import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  applyClaudeMcpInstall,
  buildClaudeMcpConfig,
  buildClaudeMcpInstallCommand,
  CLAUDE_FORBIDDEN_CONFIG_KEYS,
  findForbiddenClaudeConfigKeys,
  parseClaudeMcpScope,
  type ClaudeMcpInstallCommand,
  type ClaudeProcessRunner,
} from '../../../src/core/mcp/claude_config.js';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-claude-config-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  return repo;
}

describe('Claude MCP config generation', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeRepo();
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('generates stdio JSON config for repo-bound VibecodeMCP with no approval or permission fields', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    const result = buildClaudeMcpConfig({ repoRoot, vibecodeBinPath });

    expect(result).toMatchObject({
      ok: true,
      data: {
        agent: 'claude',
        scope: 'local',
        server_name: 'vibecode',
        claude_command: 'claude',
        warnings: [],
      },
    });
    expect(result.data.server_config).toEqual({
      type: 'stdio',
      command: 'node',
      args: [
        normalizeCliPath(vibecodeBinPath),
        'mcp',
        'serve',
        '--repo',
        normalizeCliPath(repoRoot),
        '--codegraph-transport',
        'auto',
        '--log-level',
        'warn',
      ],
      env: {},
    });

    const serialized = JSON.stringify(result.data.server_config);
    for (const key of CLAUDE_FORBIDDEN_CONFIG_KEYS) {
      expect(serialized).not.toContain(key);
    }
    expect(serialized).not.toContain('OPENAI');
    expect(serialized).not.toContain('ANTHROPIC');
    expect(serialized).not.toContain('API_KEY');
  });

  test('escapes Windows paths as valid JSON strings without backslash path separators', () => {
    const result = buildClaudeMcpConfig({
      repoRoot: 'C:\\DATA\\PROJECTS\\VibecodeLight',
      vibecodeBinPath: 'C:\\DATA\\PROJECTS\\VibecodeLight\\bin\\vibecode.js',
    });

    const json = JSON.stringify(result.data.server_config);
    expect(json).toContain('C:/DATA/PROJECTS/VibecodeLight/bin/vibecode.js');
    expect(json).toContain('C:/DATA/PROJECTS/VibecodeLight');
    expect(json).not.toContain('C:\\DATA\\PROJECTS');
  });

  test('builds exact claude mcp add-json argv with local default and scoped warnings', () => {
    const local = buildClaudeMcpInstallCommand({ repoRoot });
    expect(local.cwd).toBe(normalizeCliPath(repoRoot));
    expect(local.command).toBe('claude');
    expect(local.args).toEqual([
      'mcp',
      'add-json',
      'vibecode',
      JSON.stringify(local.server_config),
      '--scope',
      'local',
    ]);
    expect(local.scope).toBe('local');
    expect(local.warnings).toEqual([]);

    const user = buildClaudeMcpInstallCommand({ repoRoot, scope: 'user' });
    expect(user.args.at(-1)).toBe('user');
    expect(user.warnings.some((warning) => /repo-bound/i.test(warning))).toBe(true);

    const project = buildClaudeMcpInstallCommand({ repoRoot, scope: 'project' });
    expect(project.args.at(-1)).toBe('project');
    expect(project.warnings.some((warning) => /\.mcp\.json/i.test(warning))).toBe(true);
    expect(project.warnings.some((warning) => /approval|trust/i.test(warning))).toBe(true);
  });

  test('parses Claude scopes with local as the default', () => {
    expect(parseClaudeMcpScope(undefined)).toBe('local');
    expect(parseClaudeMcpScope('')).toBe('local');
    expect(parseClaudeMcpScope(' LOCAL ')).toBe('local');
    expect(parseClaudeMcpScope('user')).toBe('user');
    expect(parseClaudeMcpScope('project')).toBe('project');
    expect(parseClaudeMcpScope('team')).toBeNull();
  });
});

function normalizeCliPath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/');
}

describe('findForbiddenClaudeConfigKeys', () => {
  test('returns [] for the normal Claude MCP server payload', () => {
    const repoRoot = makeRepo();
    try {
      const command = buildClaudeMcpInstallCommand({
        repoRoot,
        vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      });
      expect(findForbiddenClaudeConfigKeys(command.server_config)).toEqual([]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('detects a forbidden top-level object key', () => {
    const found = findForbiddenClaudeConfigKeys({ type: 'stdio', allowedTools: ['*'] });
    expect(found).toContain('allowedTools');
  });

  test('detects forbidden keys nested under objects and arrays', () => {
    const payload = {
      type: 'stdio',
      command: 'node',
      env: { nested: { hooks: { PreToolUse: 'x' } } },
      extras: [{ ok: true }, { deniedTools: ['shell'] }],
    };
    const found = findForbiddenClaudeConfigKeys(payload);
    expect(found).toEqual(expect.arrayContaining(['hooks', 'deniedTools']));
  });

  test('checks object KEYS only — does not flag string values that merely contain the words', () => {
    const payload = {
      type: 'stdio',
      command: 'node',
      args: ['--note', 'this string mentions allowedTools and hooks but is not a key'],
    };
    expect(findForbiddenClaudeConfigKeys(payload)).toEqual([]);
  });

  test('matches forbidden keys case-insensitively', () => {
    expect(findForbiddenClaudeConfigKeys({ AllowedTools: [] })).toContain('AllowedTools');
  });
});

describe('Claude MCP install forbidden-key runtime guard', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeRepo();
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('the normal install payload passes the guard and still spawns Claude', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: ClaudeProcessRunner = (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = applyClaudeMcpInstall({ repoRoot, yes: true, runner });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('a payload with a forbidden top-level key fails before spawning Claude', () => {
    const calls: unknown[] = [];
    const runner: ClaudeProcessRunner = (...args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    };
    // Inject a builder that produces a payload a future bug might create.
    const buildInstallCommand = (options: { repoRoot: string }): ClaudeMcpInstallCommand => {
      const base = buildClaudeMcpInstallCommand(options);
      return {
        ...base,
        server_config: { ...base.server_config, allowedTools: ['*'] } as unknown as ClaudeMcpInstallCommand['server_config'],
      };
    };

    const result = applyClaudeMcpInstall({ repoRoot, yes: true, runner, buildInstallCommand });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected guard failure');
    expect(result.error.code).toBe('CLAUDE_MCP_FORBIDDEN_KEY');
    expect((result.error.details ?? []).join(' ')).toContain('allowedTools');
    // Claude was never spawned.
    expect(calls).toEqual([]);
  });

  test('a payload with a nested forbidden key fails before spawning Claude', () => {
    const calls: unknown[] = [];
    const runner: ClaudeProcessRunner = (...args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    };
    const buildInstallCommand = (options: { repoRoot: string }): ClaudeMcpInstallCommand => {
      const base = buildClaudeMcpInstallCommand(options);
      return {
        ...base,
        server_config: { ...base.server_config, env: { hooks: { PreToolUse: 'x' } } } as unknown as ClaudeMcpInstallCommand['server_config'],
      };
    };

    const result = applyClaudeMcpInstall({ repoRoot, yes: true, runner, buildInstallCommand });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected guard failure');
    expect(result.error.code).toBe('CLAUDE_MCP_FORBIDDEN_KEY');
    expect((result.error.details ?? []).join(' ')).toContain('hooks');
    expect(calls).toEqual([]);
  });

  test('the guard also fails closed on dry-run (no preview of a forbidden payload)', () => {
    const buildInstallCommand = (options: { repoRoot: string }): ClaudeMcpInstallCommand => {
      const base = buildClaudeMcpInstallCommand(options);
      return {
        ...base,
        server_config: { ...base.server_config, deniedTools: ['x'] } as unknown as ClaudeMcpInstallCommand['server_config'],
      };
    };

    const result = applyClaudeMcpInstall({ repoRoot, dryRun: true, buildInstallCommand });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected guard failure');
    expect(result.error.code).toBe('CLAUDE_MCP_FORBIDDEN_KEY');
  });

  test('every declared CLAUDE_FORBIDDEN_CONFIG_KEYS value is detected as a key', () => {
    for (const key of CLAUDE_FORBIDDEN_CONFIG_KEYS) {
      expect(findForbiddenClaudeConfigKeys({ [key]: true })).toContain(key);
    }
  });
});
