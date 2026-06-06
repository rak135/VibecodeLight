import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildClaudeMcpInstallCommand,
  runClaudeMcpDoctor,
  type ClaudeProcessRunner,
} from '../../../src/core/mcp/claude_config.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';

interface Fixture {
  repoRoot: string;
  configDir: string;
  binPath: string;
}

function makeFixture(): Fixture {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-claude-doctor-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-claude-doctor-home-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  return { repoRoot, configDir, binPath: path.join(repoRoot, 'bin', 'vibecode.js') };
}

/** Build the canonical up-to-date server config, optionally mutated for stale cases. */
function expectedServer(
  repoRoot: string,
  binPath: string,
  mutate?: (server: { type: string; command: string; args: string[]; env: Record<string, never> }) => void,
): { type: string; command: string; args: string[]; env: Record<string, never> } {
  const command = buildClaudeMcpInstallCommand({ repoRoot, vibecodeBinPath: binPath });
  const server = {
    type: 'stdio',
    command: command.server_config.command,
    args: [...command.server_config.args],
    env: {} as Record<string, never>,
  };
  if (mutate) mutate(server);
  return server;
}

/** Write a local-scope server into <configDir>/.claude.json (the form `--scope local` produces). */
function writeLocalConfig(
  f: Fixture,
  mutate?: (server: { type: string; command: string; args: string[]; env: Record<string, never> }) => void,
): void {
  fs.writeFileSync(
    path.join(f.configDir, '.claude.json'),
    JSON.stringify(
      {
        projects: {
          [f.repoRoot.replace(/\\/g, '/')]: {
            mcpServers: { vibecode: expectedServer(f.repoRoot, f.binPath, mutate) },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

const okRunner: ClaudeProcessRunner = (_command, args) => {
  if (args.join(' ') === '--version') return { status: 0, stdout: '2.1.0\n', stderr: '' };
  if (args.join(' ') === 'mcp list') return { status: 0, stdout: 'vibecode connected\n', stderr: '' };
  if (args.join(' ') === 'mcp get vibecode') return { status: 0, stdout: 'vibecode stdio\n', stderr: '' };
  return { status: 1, stdout: '', stderr: 'unexpected' };
};

describe('Claude MCP doctor', () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
    fs.rmSync(f.configDir, { recursive: true, force: true });
  });

  test('reports OK when the configured server matches the repo and serve command (up to date)', () => {
    writeLocalConfig(f);
    const calls: string[][] = [];
    const runner: ClaudeProcessRunner = (command, args, options) => {
      calls.push(args);
      return okRunner(command, args, options);
    };

    const result = runClaudeMcpDoctor({
      repoRoot: f.repoRoot,
      vibecodeBinPath: f.binPath,
      claudeConfigDir: f.configDir,
      runner,
      toolsProvider: () => ({ ok: true, tools: [...VIBECODE_MCP_TOOL_NAMES] }),
    });

    expect(result.ok).toBe(true);
    expect(result.checks.claude_cli.ok).toBe(true);
    expect(result.checks.tools.ok).toBe(true);
    expect(result.checks.server_binding.ok).toBe(true);
    expect(result.checks.server_binding.message).toMatch(/up to date|matches/i);
    // Existing call-order contract is preserved.
    expect(calls).toEqual([['--version'], ['mcp', 'list'], ['mcp', 'get', 'vibecode']]);
    // Doctor never mutates config.
    expect(fs.existsSync(path.join(f.repoRoot, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(f.repoRoot, '.claude', 'settings.json'))).toBe(false);
  });

  test('reports missing Claude CLI cleanly', () => {
    writeLocalConfig(f);
    const result = runClaudeMcpDoctor({
      repoRoot: f.repoRoot,
      vibecodeBinPath: f.binPath,
      claudeConfigDir: f.configDir,
      runner: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }),
      toolsProvider: () => ({ ok: true, tools: [...VIBECODE_MCP_TOOL_NAMES] }),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CLAUDE_CLI_NOT_FOUND');
    expect(result.checks.claude_cli.ok).toBe(false);
  });

  test('reports pending approval/trust as a warning only when binding is up to date', () => {
    writeLocalConfig(f);
    const runner: ClaudeProcessRunner = (_command, args) => {
      if (args.join(' ') === '--version') return { status: 0, stdout: '2.1.0\n', stderr: '' };
      if (args.join(' ') === 'mcp list') return { status: 0, stdout: 'vibecode Pending approval\n', stderr: '' };
      if (args.join(' ') === 'mcp get vibecode') return { status: 0, stdout: 'Pending approval\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = runClaudeMcpDoctor({
      repoRoot: f.repoRoot,
      vibecodeBinPath: f.binPath,
      claudeConfigDir: f.configDir,
      runner,
      toolsProvider: () => ({ ok: true, tools: [...VIBECODE_MCP_TOOL_NAMES] }),
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => /pending approval|trust/i.test(warning))).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('reports NOT OK when no vibecode server is configured for this repo', () => {
    // No .claude.json / .mcp.json written.
    const result = runClaudeMcpDoctor({
      repoRoot: f.repoRoot,
      vibecodeBinPath: f.binPath,
      claudeConfigDir: f.configDir,
      runner: okRunner,
      toolsProvider: () => ({ ok: true, tools: [...VIBECODE_MCP_TOOL_NAMES] }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks.server_binding.ok).toBe(false);
    expect(result.checks.server_binding.message).toMatch(/no configured|not configured|not found/i);
  });

  test('reports NOT OK when the configured server points to a different repo', () => {
    writeLocalConfig(f, (server) => {
      const idx = server.args.indexOf('--repo');
      server.args[idx + 1] = 'C:/some/other/repo';
    });

    const result = runClaudeMcpDoctor({
      repoRoot: f.repoRoot,
      vibecodeBinPath: f.binPath,
      claudeConfigDir: f.configDir,
      runner: okRunner,
      toolsProvider: () => ({ ok: true, tools: [...VIBECODE_MCP_TOOL_NAMES] }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks.server_binding.ok).toBe(false);
    expect(result.checks.server_binding.message).toMatch(/different repo|other\/repo|repo/i);
  });

  test('reports NOT OK when the configured server command/args are stale', () => {
    writeLocalConfig(f, (server) => {
      server.args[0] = 'D:/elsewhere/bin/vibecode.js';
    });

    const result = runClaudeMcpDoctor({
      repoRoot: f.repoRoot,
      vibecodeBinPath: f.binPath,
      claudeConfigDir: f.configDir,
      runner: okRunner,
      toolsProvider: () => ({ ok: true, tools: [...VIBECODE_MCP_TOOL_NAMES] }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks.server_binding.ok).toBe(false);
    expect(result.checks.server_binding.message).toMatch(/stale|differ|re-?run install/i);
  });

  test('uses the injected claudeConfigDir, not the real user home, to determine binding', () => {
    // Empty config dir => detection must report not-configured regardless of the
    // developer's real ~/.claude.json.
    const result = runClaudeMcpDoctor({
      repoRoot: f.repoRoot,
      vibecodeBinPath: f.binPath,
      claudeConfigDir: f.configDir,
      runner: okRunner,
      toolsProvider: () => ({ ok: true, tools: [...VIBECODE_MCP_TOOL_NAMES] }),
    });
    expect(result.checks.server_binding.ok).toBe(false);
  });
});
