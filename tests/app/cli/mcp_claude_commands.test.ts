import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-claude-mcp-'));
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

describe('vibecode mcp config/install/doctor for Claude Code', () => {
  let repoRoot: string;

  beforeEach(() => {
    vi.resetModules();
    repoRoot = makeRepo();
  });

  afterEach(() => {
    vi.doUnmock('../../../src/core/mcp/claude_config.js');
    vi.resetModules();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('mcp config --agent claude --print prints server JSON and equivalent add-json command', async () => {
    const result = await runCli(['mcp', 'config', '--agent', 'claude', '--repo', repoRoot, '--print']);

    const output = result.logs.join('\n');
    expect(result.exitCode).toBe(0);
    expect(output).toContain('"type": "stdio"');
    expect(output).toContain('"command": "node"');
    expect(output).toContain('claude mcp add-json vibecode');
    expect(output).toContain('--scope local');
    expect(output).not.toContain('allowedTools');
    expect(output).not.toContain('default_tools_approval_mode');
    expect(result.errors).toEqual([]);
  });

  test('mcp config --agent claude --json returns stable envelope', async () => {
    const result = await runCli(['mcp', 'config', '--agent', 'claude', '--repo', repoRoot, '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.logs[0]);
    expect(payload).toMatchObject({
      ok: true,
      data: {
        agent: 'claude',
        scope: 'local',
        server_name: 'vibecode',
        claude_command: 'claude',
        warnings: [],
      },
    });
    expect(payload.data.server_config).toMatchObject({
      type: 'stdio',
      command: 'node',
      env: {},
    });
    expect(payload.data.claude_args.slice(0, 3)).toEqual(['mcp', 'add-json', 'vibecode']);
  });

  test('install --dry-run --json writes nothing and reports planned command', async () => {
    const filesBefore = fs.readdirSync(repoRoot).sort();
    const result = await runCli(['mcp', 'install', '--agent', 'claude', '--repo', repoRoot, '--dry-run', '--json']);

    const payload = JSON.parse(result.logs[0]);
    expect(result.exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.dry_run).toBe(true);
    expect(payload.planned_command).toContain('claude mcp add-json vibecode');
    expect(fs.readdirSync(repoRoot).sort()).toEqual(filesBefore);
  });

  test('install without --yes and without --dry-run refuses to write', async () => {
    const result = await runCli(['mcp', 'install', '--agent', 'claude', '--repo', repoRoot, '--json']);

    const payload = JSON.parse(result.logs[0]);
    expect(result.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('CLAUDE_MCP_INSTALL_FAILED');
    expect(payload.error.message).toMatch(/--dry-run|--yes/);
  });

  test('invalid Claude scope fails cleanly', async () => {
    const result = await runCli(['mcp', 'config', '--agent', 'claude', '--repo', repoRoot, '--scope', 'team', '--json']);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.error.code).toBe('INVALID_SCOPE');
    expect(payload.error.details.join(' ')).toContain('local');
  });

  test('doctor --agent claude delegates to core doctor and preserves JSON output', async () => {
    vi.doMock('../../../src/core/mcp/claude_config.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/core/mcp/claude_config.js')>(
        '../../../src/core/mcp/claude_config.js',
      );
      return {
        ...actual,
        runClaudeMcpDoctor: vi.fn().mockReturnValue({
          ok: true,
          agent: 'claude',
          scope: 'local',
          server_name: 'vibecode',
          checks: {
            claude_cli: { ok: true, message: 'Claude CLI is available.' },
          },
          warnings: ['Vibecode does not manage Claude MCP approvals. Claude Code applies its own permission/trust settings.'],
          suggestions: ['Restart Claude Code or run /mcp to inspect connected servers.'],
        }),
      };
    });

    const result = await runCli(['mcp', 'doctor', '--agent', 'claude', '--repo', repoRoot, '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.agent).toBe('claude');
    expect(payload.suggestions.some((suggestion: string) => /\/mcp/i.test(suggestion))).toBe(true);
  });
});
