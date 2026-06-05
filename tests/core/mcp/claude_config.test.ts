import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildClaudeMcpConfig,
  buildClaudeMcpInstallCommand,
  CLAUDE_FORBIDDEN_CONFIG_KEYS,
  parseClaudeMcpScope,
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
