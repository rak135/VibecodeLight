import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CODEX_MCP_ENABLED_TOOLS,
  buildCodexMcpConfig,
} from '../../../src/core/mcp/codex_config.js';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codex-config-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  return repo;
}

describe('Codex MCP config generation', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeRepo();
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('generates the expected Codex TOML block with absolute repo and bin paths', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    const result = buildCodexMcpConfig({ repoRoot, scope: 'user', vibecodeBinPath });

    expect(result.agent).toBe('codex');
    expect(result.scope).toBe('user');
    expect(result.server_name).toBe('vibecode');
    expect(result.command).toBe('node');
    expect(result.args).toEqual([
      pathToTomlPath(vibecodeBinPath),
      'mcp',
      'serve',
      '--repo',
      pathToTomlPath(repoRoot),
      '--codegraph-transport',
      'auto',
      '--log-level',
      'warn',
    ]);
    expect(result.cwd).toBe(pathToTomlPath(repoRoot));
    expect(result.enabled_tools).toEqual(CODEX_MCP_ENABLED_TOOLS);
    expect(result.toml_snippet).toContain('[mcp_servers.vibecode]');
    expect(result.toml_snippet).toContain('command = "node"');
    expect(result.toml_snippet).toContain(`"${pathToTomlPath(vibecodeBinPath)}"`);
    expect(result.toml_snippet).toContain(`"${pathToTomlPath(repoRoot)}"`);
    expect(result.toml_snippet).toContain('startup_timeout_sec = 10');
    expect(result.toml_snippet).toContain('tool_timeout_sec = 60');
    expect(result.toml_snippet).toContain('default_tools_approval_mode = "auto"');
  });

  test('includes exactly the 7 read-only VibecodeMCP tools and no write/shell/git/terminal tools', () => {
    const result = buildCodexMcpConfig({
      repoRoot,
      scope: 'user',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });

    expect(result.enabled_tools).toHaveLength(7);
    expect(result.enabled_tools).toEqual([
      'vibecode_codegraph_status',
      'vibecode_codegraph_search',
      'vibecode_codegraph_context',
      'vibecode_codegraph_files',
      'vibecode_codegraph_callers',
      'vibecode_codegraph_callees',
      'vibecode_codegraph_impact',
    ]);
    const joined = result.toml_snippet.toLowerCase();
    expect(joined).not.toContain('write');
    expect(joined).not.toContain('shell');
    expect(joined).not.toContain('git_commit');
    expect(joined).not.toContain('terminal');
  });

  test('escapes Windows paths as TOML-safe forward-slash strings', () => {
    const result = buildCodexMcpConfig({
      repoRoot: 'C:\\DATA\\PROJECTS\\VibecodeLight',
      scope: 'user',
      vibecodeBinPath: 'C:\\DATA\\PROJECTS\\VibecodeLight\\bin\\vibecode.js',
    });

    expect(result.toml_snippet).toContain('"C:/DATA/PROJECTS/VibecodeLight/bin/vibecode.js"');
    expect(result.toml_snippet).toContain('"C:/DATA/PROJECTS/VibecodeLight"');
    expect(result.toml_snippet).not.toContain('C:\\DATA\\PROJECTS');
  });

  test('JSON envelope fields are stable', () => {
    const result = buildCodexMcpConfig({
      repoRoot,
      scope: 'project',
      configPath: path.join(repoRoot, '.codex', 'config.toml'),
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });

    expect(result).toMatchObject({
      ok: true,
      agent: 'codex',
      scope: 'project',
      config_path: pathToTomlPath(path.join(repoRoot, '.codex', 'config.toml')),
      server_name: 'vibecode',
      command: 'node',
      warnings: expect.any(Array),
      toml_snippet: expect.any(String),
    });
  });
});

function pathToTomlPath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/');
}
