import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildToolProfileTool } from '../../../src/app/mcp/tools/tool_profile.js';
import { TOOL_PROFILE_IDS } from '../../../src/core/agent_guidance/tool_profiles.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

/**
 * Phase 1B-3: `vibecode tools profile` CLI command.
 *
 * Pins the canonical envelope, list/single behavior, structured errors, that the
 * non-JSON output is readable, and field-level parity with the MCP
 * `vibecode_tool_profile` tool. Also guards that the new `tools` command does not
 * break the existing `vibecode mcp tools --json`.
 */

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

function ctx(): McpServerContext {
  return { repoRoot: '/tmp/whatever' };
}

describe('vibecode tools profile', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  test('--json with no --profile returns the profile list envelope', async () => {
    const cli = await runCli(['tools', 'profile', '--json']);
    expect(cli.exitCode).toBe(0);
    expect(cli.errors).toEqual([]);
    const envelope = JSON.parse(cli.logs[0]) as {
      ok: boolean;
      data: { mode: string; profiles: Array<{ profile_id: string }>; count: number };
      artifacts: unknown[];
      warnings: unknown[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.mode).toBe('list');
    expect(envelope.data.count).toBe(TOOL_PROFILE_IDS.length);
    expect(envelope.data.profiles.map((p) => p.profile_id)).toEqual([...TOOL_PROFILE_IDS]);
    expect(envelope.artifacts).toEqual([]);
  });

  test('--json --profile <id> returns the full profile envelope', async () => {
    const cli = await runCli(['tools', 'profile', '--profile', 'build_pre_edit', '--json']);
    expect(cli.exitCode).toBe(0);
    const envelope = JSON.parse(cli.logs[0]) as {
      ok: boolean;
      data: { mode: string; profile: { profile_id: string; mcp_tools: unknown[]; cli_commands: unknown[] } };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.mode).toBe('profile');
    expect(envelope.data.profile.profile_id).toBe('build_pre_edit');
    expect(envelope.data.profile.mcp_tools.length).toBeGreaterThan(0);
    expect(envelope.data.profile.cli_commands.length).toBeGreaterThan(0);
  });

  test('an unknown profile is a structured INVALID_ARGUMENT error', async () => {
    const cli = await runCli(['tools', 'profile', '--profile', 'nope', '--json']);
    expect(cli.exitCode).toBe(1);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_ARGUMENT');
  });

  test('non-JSON output is human-readable', async () => {
    const list = await runCli(['tools', 'profile']);
    expect(list.exitCode).toBe(0);
    expect(list.logs.join('\n')).toMatch(/tool profiles:/);
    expect(list.logs.join('\n')).toMatch(/build_pre_edit/);

    const single = await runCli(['tools', 'profile', '--profile', 'safe_commit']);
    expect(single.exitCode).toBe(0);
    expect(single.logs.join('\n')).toMatch(/profile: safe_commit/);
    expect(single.logs.join('\n')).toMatch(/mcp_tools:/);
  });

  // A3: the non-JSON list should make clear that --json is the agent-readable form.
  test('non-JSON list output steers agents to --json', async () => {
    const list = await runCli(['tools', 'profile']);
    expect(list.exitCode).toBe(0);
    expect(list.logs.join('\n')).toMatch(/--json/);
    expect(list.logs.join('\n').toLowerCase()).toMatch(/agent-readable|machine-readable/);
  });

  test('CLI / MCP field parity for a single profile', async () => {
    const cli = await runCli(['tools', 'profile', '--profile', 'conflict_resolution', '--json']);
    const cliProfile = (JSON.parse(cli.logs[0]) as { data: { profile: Record<string, unknown> } }).data.profile;

    const tool = buildToolProfileTool();
    const mcp = await tool.handler({ context: ctx(), arguments: { profile: 'conflict_resolution' }, requestId: null });
    const mcpProfile = (mcp.structuredContent.data as { profile: Record<string, unknown> }).profile;

    expect(JSON.stringify(cliProfile)).toBe(JSON.stringify(mcpProfile));
  });

  test('existing `vibecode mcp tools --json` still works (no parser regression)', async () => {
    const cli = await runCli(['mcp', 'tools', '--json']);
    expect(cli.exitCode).toBe(0);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; data: { tools: string[] } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.tools).toContain('vibecode_session_start');
    expect(envelope.data.tools).not.toContain('vibecode_tool_profile');
  });
});
