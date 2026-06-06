import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-ag-repo-'));
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

describe('vibecode agent-guidance CLI commands', () => {
  let repoRoot: string;
  let appData: string;
  let codexHome: string;

  beforeEach(() => {
    vi.resetModules();
    repoRoot = makeRepo();
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-ag-app-'));
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-ag-codex-'));
    process.env.LOCALAPPDATA = appData;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    delete process.env.LOCALAPPDATA;
    delete process.env.CODEX_HOME;
    vi.resetModules();
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(appData, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  test('status --json reports guidance hash and does not mutate approvals', async () => {
    const result = await runCli(['agent-guidance', 'status', '--agent', 'codex', '--repo', repoRoot, '--json']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.agent).toBe('codex');
    expect(payload.guidance.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.guidance.config_path).toBe(path.join(appData, 'vibecodelight', 'agent-guidance-config.yaml'));
    expect(payload.mcp.expected_tool_count).toBe(17);
    expect(JSON.stringify(payload)).not.toMatch(/allowedTools|deniedTools|hooks|permission profile/i);
  });

  test('apply --dry-run --json previews without writing', async () => {
    const result = await runCli(['agent-guidance', 'apply', '--agent', 'codex', '--repo', repoRoot, '--dry-run', '--json']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.dry_run).toBe(true);
    expect(payload.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.planned_action).toMatch(/VibecodeMCP/i);
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
  });

  test('apply without --yes refuses with structured error', async () => {
    const result = await runCli(['agent-guidance', 'apply', '--agent', 'codex', '--repo', repoRoot, '--json']);
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toMatch(/--yes|--dry-run/);
  });

  test('apply --yes uses the safe Codex MCP installer path and includes guidance_hash', async () => {
    const result = await runCli(['agent-guidance', 'apply', '--agent', 'codex', '--repo', repoRoot, '--yes', '--json']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toContain('mcp_servers.vibecode');
    expect(fs.existsSync(path.join(repoRoot, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'config.yaml'))).toBe(false);
  });

  test('invalid agent returns structured error', async () => {
    const result = await runCli(['agent-guidance', 'status', '--agent', 'cursor', '--repo', repoRoot, '--json']);
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('INVALID_AGENT');
  });

  test('Claude dry-run is available and does not write repo guidance files', async () => {
    const result = await runCli(['agent-guidance', 'apply', '--agent', 'claude', '--repo', repoRoot, '--dry-run', '--json']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.agent).toBe('claude');
    expect(payload.planned_action).toMatch(/claude mcp add-json/i);
    expect(fs.existsSync(path.join(repoRoot, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'CLAUDE.md'))).toBe(false);
    expect(JSON.stringify(payload)).not.toMatch(/allowedTools|deniedTools|hooks/);
  });

  test('preflight --terminal --json runs check-only by default and writes no agent config', async () => {
    const result = await runCli(['agent-guidance', 'preflight', '--repo', repoRoot, '--terminal', '--json']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe('check_only');
    expect(payload.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.no_pty_injection).toBe(true);
    expect(payload.agents.map((a: { agent: string }) => a.agent).sort()).toEqual(['claude', 'codex']);
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
  });

  test('preflight --mode check_only performs no writes even when Codex is missing config', async () => {
    const result = await runCli(['agent-guidance', 'preflight', '--repo', repoRoot, '--terminal', '--mode', 'check_only', '--json']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe('check_only');
    expect(payload.agents.find((a: { agent: string }) => a.agent === 'codex')).toMatchObject({
      configured: false,
      repaired: false,
    });
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
  });

  test('preflight --mode auto_repair uses safe apply for enabled agents only', async () => {
    const configPath = path.join(appData, 'vibecodelight', 'agent-guidance-config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, [
      'schema_version: 1',
      'enabled: true',
      'apply_to_terminal_agents: true',
      'scope: global',
      'default_guidance: "CLI preflight fixture"',
      'per_tool_notes: {}',
      'terminal_preflight:',
      '  enabled: true',
      '  mode: check_only',
      '  supported_agents:',
      '    claude: false',
      '    codex: true',
      '',
    ].join('\n'), 'utf8');

    const result = await runCli(['agent-guidance', 'preflight', '--repo', repoRoot, '--terminal', '--mode', 'auto_repair', '--json']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe('auto_repair');
    expect(payload.agents).toEqual([expect.objectContaining({ agent: 'codex', repaired: true })]);
    expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toContain('mcp_servers.vibecode');
    expect(fs.existsSync(path.join(repoRoot, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'CLAUDE.md'))).toBe(false);
  });

  test('preflight rejects invalid mode with a structured error', async () => {
    const result = await runCli(['agent-guidance', 'preflight', '--repo', repoRoot, '--terminal', '--mode', 'repair_all', '--json']);
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('INVALID_TERMINAL_PREFLIGHT_MODE');
  });

  test('preflight command does not spawn a terminal process or inject text', async () => {
    const result = await runCli(['agent-guidance', 'preflight', '--repo', repoRoot, '--terminal', '--mode', 'check_only', '--json']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.no_pty_injection).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/terminal:start|terminal:input|Start Codex|Start Claude/i);
  });
});
