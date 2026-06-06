import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  applyAgentGuidanceIntegration,
  getAgentGuidanceIntegrationStatus,
} from '../../../src/core/agent_guidance/agent_guidance_apply.js';
import { getAgentGuidanceConfigPath } from '../../../src/core/config/agent_guidance_config.js';
import { buildClaudeMcpInstallCommand } from '../../../src/core/mcp/claude_config.js';

function expectedClaudeServer(repoRoot: string, binPath: string): { type: string; command: string; args: string[]; env: Record<string, never> } {
  const command = buildClaudeMcpInstallCommand({ repoRoot, vibecodeBinPath: binPath });
  return { type: 'stdio', command: command.server_config.command, args: [...command.server_config.args], env: {} };
}

function writeClaudeLocalServer(configDir: string, repoRoot: string, server: unknown): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, '.claude.json'),
    JSON.stringify({ projects: { [repoRoot.replace(/\\/g, '/')]: { mcpServers: { vibecode: server } } } }),
    'utf8',
  );
}

function makeFixture(): {
  repoRoot: string;
  appData: string;
  codexHome: string;
  env: Record<string, string>;
  cleanup: () => void;
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-ag-apply-repo-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-ag-apply-app-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-ag-apply-codex-'));
  return {
    repoRoot,
    appData,
    codexHome,
    env: { LOCALAPPDATA: appData, CODEX_HOME: codexHome },
    cleanup: () => {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(appData, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    },
  };
}

function writeGuidance(env: Record<string, string>, text = 'custom apply guidance'): void {
  const configPath = getAgentGuidanceConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, [
    'schema_version: 1',
    'enabled: true',
    'apply_to_terminal_agents: true',
    'scope: global',
    `default_guidance: "${text}"`,
    '',
  ].join('\n'), 'utf8');
}

describe('agent guidance integration status/apply', () => {
  test('status reports valid config, hash, expected tools, and approval boundary for Codex', () => {
    const f = makeFixture();
    try {
      writeGuidance(f.env);
      const status = getAgentGuidanceIntegrationStatus({
        agent: 'codex',
        repoRoot: f.repoRoot,
        env: f.env,
        codexHome: f.codexHome,
        vibecodeBinPath: path.join(f.repoRoot, 'bin', 'vibecode.js'),
      });
      expect(status.ok).toBe(true);
      expect(status.agent).toBe('codex');
      expect(status.guidance?.config_valid).toBe(true);
      expect(status.guidance?.source).toBe('file');
      expect(status.guidance?.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(status.mcp?.expected_tool_count).toBe(26);
      expect(status.approval_boundary).toMatch(/does not manage.*approval/i);
      expect(JSON.stringify(status)).not.toMatch(/allowedTools|deniedTools|hooks|permission profile/i);
    } finally {
      f.cleanup();
    }
  });

  test('status reports invalid guidance config without crashing', () => {
    const f = makeFixture();
    try {
      const configPath = getAgentGuidanceConfigPath(f.env);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, ': not valid yaml: : :::\n', 'utf8');
      const status = getAgentGuidanceIntegrationStatus({
        agent: 'claude',
        repoRoot: f.repoRoot,
        env: f.env,
      });
      expect(status.ok).toBe(true);
      expect(status.guidance?.config_valid).toBe(false);
      expect(status.guidance?.source).toBe('invalid_file_with_defaults');
      expect(status.guidance?.warnings.join('\n')).toMatch(/AGENT_GUIDANCE_CONFIG_PARSE_ERROR/);
    } finally {
      f.cleanup();
    }
  });

  test('dry-run apply returns planned action and writes no files', () => {
    const f = makeFixture();
    try {
      const beforeRepo = fs.readdirSync(f.repoRoot).sort();
      const result = applyAgentGuidanceIntegration({
        agent: 'codex',
        repoRoot: f.repoRoot,
        env: f.env,
        codexHome: f.codexHome,
        dryRun: true,
        vibecodeBinPath: path.join(f.repoRoot, 'bin', 'vibecode.js'),
      });
      expect(result.ok).toBe(true);
      expect(result.dry_run).toBe(true);
      expect(result.planned_action).toMatch(/VibecodeMCP/i);
      expect(result.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.existsSync(path.join(f.codexHome, 'config.toml'))).toBe(false);
      expect(fs.readdirSync(f.repoRoot).sort()).toEqual(beforeRepo);
    } finally {
      f.cleanup();
    }
  });

  test('apply requires explicit yes when not dry-run', () => {
    const f = makeFixture();
    try {
      const result = applyAgentGuidanceIntegration({
        agent: 'codex',
        repoRoot: f.repoRoot,
        env: f.env,
        codexHome: f.codexHome,
        dryRun: false,
        yes: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/--yes|--dry-run/);
      expect(fs.existsSync(path.join(f.codexHome, 'config.toml'))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test('apply --yes never writes repo instruction files or root config.yaml', () => {
    const f = makeFixture();
    try {
      const result = applyAgentGuidanceIntegration({
        agent: 'codex',
        repoRoot: f.repoRoot,
        env: f.env,
        codexHome: f.codexHome,
        yes: true,
        vibecodeBinPath: path.join(f.repoRoot, 'bin', 'vibecode.js'),
      });
      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(f.repoRoot, 'AGENTS.md'))).toBe(false);
      expect(fs.existsSync(path.join(f.repoRoot, 'CLAUDE.md'))).toBe(false);
      expect(fs.existsSync(path.join(f.repoRoot, 'config.yaml'))).toBe(false);
      expect(fs.existsSync(path.join(f.repoRoot, '.vibecode', 'config.yaml'))).toBe(false);
      const written = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
      expect(written).toContain('mcp_servers.vibecode');
      expect(written).not.toMatch(/allowedTools|deniedTools|hooks|permissions/);
    } finally {
      f.cleanup();
    }
  });

  test('Claude dry-run uses safe installer path and does not mutate approvals', () => {
    const f = makeFixture();
    try {
      const result = applyAgentGuidanceIntegration({
        agent: 'claude',
        repoRoot: f.repoRoot,
        env: f.env,
        dryRun: true,
      });
      expect(result.ok).toBe(true);
      expect(result.agent).toBe('claude');
      expect(result.planned_action).toMatch(/claude mcp add-json/i);
      expect(JSON.stringify(result)).not.toMatch(/allowedTools|deniedTools|hooks|permission profile/i);
    } finally {
      f.cleanup();
    }
  });

  test('Claude status reports configured/up_to_date from a local-scope .claude.json server', () => {
    const f = makeFixture();
    try {
      writeGuidance(f.env);
      const binPath = path.join(f.repoRoot, 'bin', 'vibecode.js');
      const claudeConfigDir = path.join(f.appData, 'claude-home');
      writeClaudeLocalServer(claudeConfigDir, f.repoRoot, expectedClaudeServer(f.repoRoot, binPath));
      const status = getAgentGuidanceIntegrationStatus({
        agent: 'claude',
        repoRoot: f.repoRoot,
        env: f.env,
        vibecodeBinPath: binPath,
        claudeConfigDir,
      });
      expect(status.ok).toBe(true);
      expect(status.configured).toBe(true);
      expect(status.up_to_date).toBe(true);
      expect(status.mcp?.status).toBe('up_to_date');
      expect(status.mcp?.source).toBe('local');
      expect(status.mcp?.source_path).toBe(path.join(claudeConfigDir, '.claude.json'));
      expect(status.mcp?.repo_binding).toBeTruthy();
      expect(JSON.stringify(status)).not.toMatch(/allowedTools|deniedTools|hooks|permission profile/i);
    } finally {
      f.cleanup();
    }
  });

  test('Claude status reports stale when the detected repo binding differs', () => {
    const f = makeFixture();
    try {
      const binPath = path.join(f.repoRoot, 'bin', 'vibecode.js');
      const claudeConfigDir = path.join(f.appData, 'claude-home');
      const server = expectedClaudeServer(f.repoRoot, binPath);
      server.args[server.args.indexOf('--repo') + 1] = 'C:/some/other/repo';
      writeClaudeLocalServer(claudeConfigDir, f.repoRoot, server);
      const status = getAgentGuidanceIntegrationStatus({
        agent: 'claude',
        repoRoot: f.repoRoot,
        env: f.env,
        vibecodeBinPath: binPath,
        claudeConfigDir,
      });
      expect(status.configured).toBe(true);
      expect(status.up_to_date).toBe(false);
      expect(status.mcp?.status).toBe('stale');
    } finally {
      f.cleanup();
    }
  });

  test('Claude status reports unknown only when no recognized config exists', () => {
    const f = makeFixture();
    try {
      const claudeConfigDir = path.join(f.appData, 'claude-home-empty');
      const status = getAgentGuidanceIntegrationStatus({
        agent: 'claude',
        repoRoot: f.repoRoot,
        env: f.env,
        claudeConfigDir,
      });
      expect(status.configured).toBe(false);
      expect(status.mcp?.status).toBe('unknown');
      expect(status.mcp?.source).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  test('Claude status does not mutate Claude config and surfaces malformed config as a warning', () => {
    const f = makeFixture();
    try {
      const claudeConfigDir = path.join(f.appData, 'claude-home-bad');
      fs.mkdirSync(claudeConfigDir, { recursive: true });
      const claudeJson = path.join(claudeConfigDir, '.claude.json');
      fs.writeFileSync(claudeJson, '{ not valid json', 'utf8');
      const before = fs.readFileSync(claudeJson, 'utf8');
      const status = getAgentGuidanceIntegrationStatus({
        agent: 'claude',
        repoRoot: f.repoRoot,
        env: f.env,
        claudeConfigDir,
      });
      expect(status.ok).toBe(true);
      expect(status.mcp?.status).toBe('unknown');
      expect(status.warnings.join('\n')).toMatch(/CLAUDE_MCP_CONFIG_PARSE_WARNING/);
      expect(fs.readFileSync(claudeJson, 'utf8')).toBe(before);
    } finally {
      f.cleanup();
    }
  });

  test('invalid agent returns structured error', () => {
    const f = makeFixture();
    try {
      const result = getAgentGuidanceIntegrationStatus({
        agent: 'cursor' as 'codex',
        repoRoot: f.repoRoot,
        env: f.env,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('INVALID_AGENT');
    } finally {
      f.cleanup();
    }
  });
});
