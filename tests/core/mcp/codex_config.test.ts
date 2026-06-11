import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CODEX_MCP_ENABLED_TOOLS,
  buildCodexMcpConfig,
} from '../../../src/core/mcp/codex_config.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';

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

  test('includes exactly the VibecodeMCP tools and no shell/git/terminal tools', () => {
    const result = buildCodexMcpConfig({
      repoRoot,
      scope: 'user',
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
    });

    expect(result.enabled_tools).toHaveLength(VIBECODE_MCP_TOOL_NAMES.length);
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
      // Phase 1B-2 (read-only bounded scan summary + allowlisted scan artifact reads)
      'vibecode_scan_summary',
      'vibecode_scan_artifact_read',
      // Phase MCP-3 (read-only workspace orientation tools)
      'vibecode_workspace_info',
      'vibecode_workspace_status',
      'vibecode_mcp_guidance',
      'vibecode_project_instructions',
      'vibecode_artifacts_list',
      // Phase 1B-3 (named recommended tool sets; static, read-only)
      'vibecode_tool_profile',
      // Phase 1A (session bootstrap + claim-aware git changes)
      'vibecode_session_bootstrap',
      'vibecode_git_changes',
      // Phase Coordination-1 (read-only coordination status)
      'vibecode_coordination_status',
      // Phase Coordination-2 (agent session registry + heartbeat; advisory generated-state writes only)
      'vibecode_agent_register',
      'vibecode_agent_heartbeat',
      'vibecode_agents_list',
      'vibecode_agent_status',
      // Phase Coordination-3A (advisory claims; generated-state writes only)
      'vibecode_claim_add',
      'vibecode_claims_list',
      'vibecode_claim_status',
      'vibecode_claim_release',
      // Phase 2A (agent-declared work scope: claim plan + explicit bulk claim)
      'vibecode_claims_plan',
      'vibecode_claims_add_bulk',
      // Phase 2B (claim intent lifecycle: list + release)
      'vibecode_claim_intents_list',
      'vibecode_claim_intent_release',
      // Phase Coordination-4A (read-only finalize check)
      'vibecode_finalize_check',
      // Phase Coordination-4C (watcher evidence; list read-only, scan writes generated state only)
      'vibecode_evidence_list',
      'vibecode_evidence_scan',
      // Phase Coordination-4D-cleanup (claims reap + conflict history)
      'vibecode_claims_reap',
      'vibecode_conflicts_list',
      'vibecode_conflict_resolve',
      // Phase 2D (intent-aware conflict triage detail)
      'vibecode_conflict_detail',
      // Phase 4A (read-only handoff packet)
      'vibecode_handoff_prepare',
    ]);
    const joined = result.toml_snippet.toLowerCase();
    // Tool names referencing destructive verbs must not appear.
    expect(joined).not.toMatch(/\bshell\b/);
    expect(joined).not.toMatch(/\bexec\b/);
    expect(joined).not.toMatch(/\bgit_commit\b/);
    expect(joined).not.toMatch(/\bterminal\b/);
    expect(joined).not.toMatch(/\b(write|create|update|delete|put|post|set|edit|modify)\b/);
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
