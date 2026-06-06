import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { detectClaudeMcpConfig } from '../../../src/core/mcp/claude_mcp_detect.js';
import { buildClaudeMcpInstallCommand } from '../../../src/core/mcp/claude_config.js';

interface Fixture {
  repoRoot: string;
  configDir: string;
  binPath: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-claude-detect-repo-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-claude-detect-home-'));
  const binPath = path.join(repoRoot, 'bin', 'vibecode.js');
  return {
    repoRoot,
    configDir,
    binPath,
    cleanup: () => {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    },
  };
}

function expectedServer(repoRoot: string, binPath: string): { type: string; command: string; args: string[]; env: Record<string, never> } {
  const command = buildClaudeMcpInstallCommand({ repoRoot, vibecodeBinPath: binPath });
  return {
    type: 'stdio',
    command: command.server_config.command,
    args: [...command.server_config.args],
    env: {},
  };
}

function writeClaudeJson(configDir: string, payload: unknown): void {
  fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify(payload, null, 2), 'utf8');
}

function writeMcpJson(repoRoot: string, payload: unknown): void {
  fs.writeFileSync(path.join(repoRoot, '.mcp.json'), JSON.stringify(payload, null, 2), 'utf8');
}

describe('detectClaudeMcpConfig', () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.cleanup();
  });

  test('recognizes local-scope server in ~/.claude.json projects map', () => {
    writeClaudeJson(f.configDir, {
      projects: {
        [f.repoRoot.replace(/\\/g, '/')]: {
          mcpServers: { vibecode: expectedServer(f.repoRoot, f.binPath) },
        },
      },
    });
    const result = detectClaudeMcpConfig({ repoRoot: f.repoRoot, vibecodeBinPath: f.binPath, claudeConfigDir: f.configDir });
    expect(result.configured).toBe(true);
    expect(result.status).toBe('up_to_date');
    expect(result.effective?.scope).toBe('local');
    expect(result.effective?.config_path).toBe(path.join(f.configDir, '.claude.json'));
    expect(result.effective?.repo_binding).toBeTruthy();
    expect(result.effective?.command).toBe('node');
  });

  test('recognizes project-scoped .mcp.json in the repo root', () => {
    writeMcpJson(f.repoRoot, { mcpServers: { vibecode: expectedServer(f.repoRoot, f.binPath) } });
    const result = detectClaudeMcpConfig({ repoRoot: f.repoRoot, vibecodeBinPath: f.binPath, claudeConfigDir: f.configDir });
    expect(result.configured).toBe(true);
    expect(result.status).toBe('up_to_date');
    expect(result.effective?.scope).toBe('project');
    expect(result.effective?.config_path).toBe(path.join(f.repoRoot, '.mcp.json'));
  });

  test('recognizes user-scope server in top-level mcpServers', () => {
    writeClaudeJson(f.configDir, { mcpServers: { vibecode: expectedServer(f.repoRoot, f.binPath) } });
    const result = detectClaudeMcpConfig({ repoRoot: f.repoRoot, vibecodeBinPath: f.binPath, claudeConfigDir: f.configDir });
    expect(result.configured).toBe(true);
    expect(result.status).toBe('up_to_date');
    expect(result.effective?.scope).toBe('user');
  });

  test('matches local project key that uses backslashes against forward-slash repo', () => {
    writeClaudeJson(f.configDir, {
      projects: {
        [f.repoRoot.replace(/\//g, '\\')]: {
          mcpServers: { vibecode: expectedServer(f.repoRoot, f.binPath) },
        },
      },
    });
    const result = detectClaudeMcpConfig({ repoRoot: f.repoRoot, vibecodeBinPath: f.binPath, claudeConfigDir: f.configDir });
    expect(result.configured).toBe(true);
    expect(result.effective?.scope).toBe('local');
  });

  test('reports stale when the repo binding differs', () => {
    const server = expectedServer(f.repoRoot, f.binPath);
    const repoIdx = server.args.indexOf('--repo');
    server.args[repoIdx + 1] = 'C:/some/other/repo';
    writeClaudeJson(f.configDir, {
      projects: { [f.repoRoot.replace(/\\/g, '/')]: { mcpServers: { vibecode: server } } },
    });
    const result = detectClaudeMcpConfig({ repoRoot: f.repoRoot, vibecodeBinPath: f.binPath, claudeConfigDir: f.configDir });
    expect(result.configured).toBe(true);
    expect(result.status).toBe('stale');
    expect(result.effective?.matches_repo).toBe(false);
  });

  test('reports stale when the command/bin path differs', () => {
    const server = expectedServer(f.repoRoot, f.binPath);
    server.args[0] = 'D:/elsewhere/bin/vibecode.js';
    writeClaudeJson(f.configDir, {
      projects: { [f.repoRoot.replace(/\\/g, '/')]: { mcpServers: { vibecode: server } } },
    });
    const result = detectClaudeMcpConfig({ repoRoot: f.repoRoot, vibecodeBinPath: f.binPath, claudeConfigDir: f.configDir });
    expect(result.status).toBe('stale');
    expect(result.effective?.command_ok).toBe(false);
  });

  test('reports unknown only when no recognized config exists', () => {
    const result = detectClaudeMcpConfig({ repoRoot: f.repoRoot, vibecodeBinPath: f.binPath, claudeConfigDir: f.configDir });
    expect(result.configured).toBe(false);
    expect(result.status).toBe('unknown');
    expect(result.sources).toEqual([]);
    expect(result.effective).toBeUndefined();
  });

  test('local scope takes precedence over project scope and reports all sources', () => {
    // local is stale, project is up-to-date; local is what Claude actually uses.
    const localServer = expectedServer(f.repoRoot, f.binPath);
    const repoIdx = localServer.args.indexOf('--repo');
    localServer.args[repoIdx + 1] = 'C:/stale/repo';
    writeClaudeJson(f.configDir, {
      projects: { [f.repoRoot.replace(/\\/g, '/')]: { mcpServers: { vibecode: localServer } } },
    });
    writeMcpJson(f.repoRoot, { mcpServers: { vibecode: expectedServer(f.repoRoot, f.binPath) } });

    const result = detectClaudeMcpConfig({ repoRoot: f.repoRoot, vibecodeBinPath: f.binPath, claudeConfigDir: f.configDir });
    expect(result.effective?.scope).toBe('local');
    expect(result.status).toBe('stale');
    expect(result.sources.map((s) => s.scope).sort()).toEqual(['local', 'project']);
  });

  test('malformed ~/.claude.json yields a structured warning and does not throw', () => {
    fs.writeFileSync(path.join(f.configDir, '.claude.json'), '{ not valid json', 'utf8');
    const result = detectClaudeMcpConfig({ repoRoot: f.repoRoot, vibecodeBinPath: f.binPath, claudeConfigDir: f.configDir });
    expect(result.configured).toBe(false);
    expect(result.status).toBe('unknown');
    expect(result.warnings.join('\n')).toMatch(/CLAUDE_MCP_CONFIG_PARSE_WARNING/);
  });

  test('does not mutate any config files in detection mode', () => {
    writeClaudeJson(f.configDir, {
      projects: { [f.repoRoot.replace(/\\/g, '/')]: { mcpServers: { vibecode: expectedServer(f.repoRoot, f.binPath) } } },
    });
    const before = fs.readFileSync(path.join(f.configDir, '.claude.json'), 'utf8');
    detectClaudeMcpConfig({ repoRoot: f.repoRoot, vibecodeBinPath: f.binPath, claudeConfigDir: f.configDir });
    expect(fs.readFileSync(path.join(f.configDir, '.claude.json'), 'utf8')).toBe(before);
  });

  test('does not surface unrelated server names or sensitive config contents', () => {
    writeClaudeJson(f.configDir, {
      oauthAccount: { secret: 'TOP_SECRET_TOKEN' },
      projects: {
        [f.repoRoot.replace(/\\/g, '/')]: {
          mcpServers: {
            vibecode: expectedServer(f.repoRoot, f.binPath),
            other: { type: 'stdio', command: 'node', args: ['x'], env: {} },
          },
        },
      },
    });
    const result = detectClaudeMcpConfig({ repoRoot: f.repoRoot, vibecodeBinPath: f.binPath, claudeConfigDir: f.configDir });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/TOP_SECRET_TOKEN/);
    expect(serialized).not.toMatch(/"other"/);
  });
});
