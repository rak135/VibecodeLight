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
    // Vibecode registers the MCP server and tools but must NOT manage approval
    // policy by default (see docs/codegraph.md "does not" list).
    expect(result.toml_snippet).not.toContain('default_tools_approval_mode');
  });

  test('does not write any approval/permission keys in the managed block by default', () => {
    const result = buildCodexMcpConfig({
      repoRoot,
      scope: 'user',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });

    for (const forbidden of [
      'default_tools_approval_mode',
      'approval_policy',
      'allowedTools',
      'deniedTools',
      'hooks',
    ]) {
      expect(result.toml_snippet).not.toContain(forbidden);
    }

    // The server-registration keys that ARE part of the contract remain.
    for (const required of [
      '[mcp_servers.vibecode]',
      'command = "node"',
      'args = ',
      'cwd = ',
      'enabled = true',
      'startup_timeout_sec = 10',
      'tool_timeout_sec = 60',
      'enabled_tools = ',
    ]) {
      expect(result.toml_snippet).toContain(required);
    }
  });

  test('includes exactly the 22 VibecodeMCP tools (MCP-1 CodeGraph + MCP-2 run/artifact + MCP-3 workspace orientation + Coordination-1 status + Coordination-2 agent sessions) and no write/shell/git/terminal tools', () => {
    const result = buildCodexMcpConfig({
      repoRoot,
      scope: 'user',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });

    expect(result.enabled_tools).toHaveLength(22);
    expect(result.enabled_tools).toEqual([
      // Phase MCP-1
      'vibecode_codegraph_status',
      'vibecode_codegraph_search',
      'vibecode_codegraph_context',
      'vibecode_codegraph_files',
      'vibecode_codegraph_callers',
      'vibecode_codegraph_callees',
      'vibecode_codegraph_impact',
      // Phase MCP-2 (read-only run / artifact tools)
      'vibecode_runs_list',
      'vibecode_current_run',
      'vibecode_run_get',
      'vibecode_artifact_read',
      'vibecode_codegraph_usage',
      // Phase MCP-3 (read-only workspace orientation tools)
      'vibecode_workspace_info',
      'vibecode_workspace_status',
      'vibecode_mcp_guidance',
      'vibecode_project_instructions',
      'vibecode_artifacts_list',
      // Phase Coordination-1 (read-only coordination status)
      'vibecode_coordination_status',
      // Phase Coordination-2 (agent session registry + heartbeat; advisory generated-state writes only)
      'vibecode_agent_register',
      'vibecode_agent_heartbeat',
      'vibecode_agents_list',
      'vibecode_agent_status',
    ]);
    const joined = result.toml_snippet.toLowerCase();
    // Tool names referencing destructive verbs must not appear.
    expect(joined).not.toMatch(/\bshell\b/);
    expect(joined).not.toMatch(/\bexec\b/);
    expect(joined).not.toMatch(/\bgit_commit\b/);
    expect(joined).not.toMatch(/\bterminal\b/);
    expect(joined).not.toMatch(/(write|create|update|delete|put|post|set|edit|modify)/);
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
