import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-codex-mcp-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  return repo;
}

async function runCli(args: string[]): Promise<{ logs: string[]; errors: string[]; exitCode: number }> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    process.exitCode = 0;
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', ...args]);
    return {
      logs: logSpy.mock.calls.map((call) => String(call[0])),
      errors: errorSpy.mock.calls.map((call) => String(call[0])),
      exitCode: Number(process.exitCode ?? 0),
    };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
  }
}

describe('vibecode mcp config/install/doctor for Codex', () => {
  let repoRoot: string;
  let codexHome: string;

  beforeEach(() => {
    vi.resetModules();
    repoRoot = makeRepo();
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-codex-home-'));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
    vi.resetModules();
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  test('mcp config --print prints only the Codex TOML snippet', async () => {
    const result = await runCli(['mcp', 'config', '--agent', 'codex', '--repo', repoRoot, '--print']);

    const output = result.logs.join('\n');
    expect(result.exitCode).toBe(0);
    expect(output.trim().startsWith('[mcp_servers.vibecode]')).toBe(true);
    expect(output).toContain('command = "node"');
    expect(output).not.toContain('"ok"');
    // Vibecode must not manage approval policy by default.
    expect(output).not.toContain('default_tools_approval_mode');
    expect(result.errors).toEqual([]);
  });

  test('mcp config --json returns stable envelope', async () => {
    const result = await runCli(['mcp', 'config', '--agent', 'codex', '--repo', repoRoot, '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.logs[0]);
    expect(payload).toMatchObject({
      ok: true,
      agent: 'codex',
      scope: 'user',
      server_name: 'vibecode',
      command: 'node',
    });
    expect(payload.config_path).toBe(path.join(codexHome, 'config.toml').replace(/\\/g, '/'));
    // 7 MCP-1 CodeGraph + 5 MCP-2 run/artifact + 5 MCP-3 workspace + 1 Coordination-1 + 4 Coordination-2 = 22.
    expect(payload.enabled_tools).toHaveLength(22);
    expect(payload.enabled_tools).toEqual(expect.arrayContaining([
      'vibecode_codegraph_status',
      'vibecode_runs_list',
      'vibecode_artifact_read',
      'vibecode_codegraph_usage',
      'vibecode_workspace_info',
      'vibecode_workspace_status',
      'vibecode_mcp_guidance',
      'vibecode_project_instructions',
      'vibecode_artifacts_list',
    ]));
    expect(payload.toml_snippet).toContain('[mcp_servers.vibecode]');
  });

  test('install without --yes refuses to write and suggests --dry-run or --yes', async () => {
    const result = await runCli(['mcp', 'install', '--agent', 'codex', '--repo', repoRoot, '--json']);

    const payload = JSON.parse(result.logs[0]);
    expect(result.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('CODEX_CONFIG_WRITE_FAILED');
    expect(payload.error.message).toMatch(/--dry-run|--yes/);
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
  });

  test('install --dry-run writes nothing and reports planned create/update', async () => {
    const result = await runCli(['mcp', 'install', '--agent', 'codex', '--repo', repoRoot, '--dry-run', '--json']);

    const payload = JSON.parse(result.logs[0]);
    expect(result.exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.dry_run).toBe(true);
    expect(payload.action).toBe('create');
    expect(payload.existing_server).toBe(false);
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
  });

  test('install --yes writes config and backup for existing config', async () => {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.5"\n', 'utf8');
    const result = await runCli(['mcp', 'install', '--agent', 'codex', '--repo', repoRoot, '--yes', '--json']);

    const payload = JSON.parse(result.logs[0]);
    expect(result.exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.backup_path).toBeTruthy();
    expect(fs.existsSync(payload.backup_path)).toBe(true);
    const written = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    expect(written).toContain('[mcp_servers.vibecode]');
    expect(written).not.toContain('default_tools_approval_mode');
    expect(payload.restart_required).toBe(true);
  });

  test('invalid agent and invalid scope fail cleanly', async () => {
    const badAgent = await runCli(['mcp', 'config', '--agent', 'cursor', '--repo', repoRoot, '--json']);
    expect(JSON.parse(badAgent.logs[0]).error.code).toBe('INVALID_AGENT');
    expect(badAgent.exitCode).toBe(1);

    const badScope = await runCli(['mcp', 'config', '--agent', 'codex', '--repo', repoRoot, '--scope', 'team', '--json']);
    expect(JSON.parse(badScope.logs[0]).error.code).toBe('INVALID_SCOPE');
    expect(badScope.exitCode).toBe(1);
  });

  test('doctor --json reports successful inspection and restart guidance', async () => {
    await runCli(['mcp', 'install', '--agent', 'codex', '--repo', repoRoot, '--yes', '--json']);
    const result = await runCli(['mcp', 'doctor', '--agent', 'codex', '--repo', repoRoot, '--json']);

    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.suggestions.some((s: string) => /\/mcp/i.test(s))).toBe(true);
  });
});
