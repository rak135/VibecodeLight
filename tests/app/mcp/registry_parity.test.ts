import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  buildVibecodeMcpTools,
  VIBECODE_MCP_TOOL_NAMES,
} from '../../../src/app/mcp/index.js';
import { AGENT_GUIDANCE_MCP_TOOL_GROUPS } from '../../../src/core/config/agent_guidance_mcp_tools.js';

/**
 * Characterization tests proving the MCP tool registry
 * (src/app/mcp/tool_registry.ts) is the single source of truth shared by:
 *   - the live MCP server's tools/list (via buildVibecodeMcpTools),
 *   - the `vibecode mcp tools --json` CLI fallback,
 *   - the Agent Guidance MCP tool groups shown in Settings.
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

describe('MCP tool registry parity', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  test('buildVibecodeMcpTools() emits the canonical names in the canonical order', () => {
    const tools = buildVibecodeMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual([...VIBECODE_MCP_TOOL_NAMES]);
  });

  test('vibecode mcp tools --json returns exactly VIBECODE_MCP_TOOL_NAMES in stable order', async () => {
    const result = await runCli(['mcp', 'tools', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.logs).toHaveLength(1);

    const envelope = JSON.parse(result.logs[0]) as {
      ok: boolean;
      data: { tools: string[] };
      artifacts: unknown[];
      warnings: unknown[];
    };
    expect(envelope.ok).toBe(true);
    // Exact order, not just set equality: the CLI fallback must mirror the live
    // tools/list order so agents see one stable contract.
    expect(envelope.data.tools).toEqual([...VIBECODE_MCP_TOOL_NAMES]);
  });

  test('Agent Guidance MCP tool groups union EQUALS the canonical registry (no orphan/missing tools)', () => {
    // Product intent: the Settings UI groups every shipped MCP tool. The group
    // mapping is a display grouping, but its union must stay in lockstep with the
    // registry so the Settings view neither hides a real tool nor lists a phantom.
    const grouped = Object.values(AGENT_GUIDANCE_MCP_TOOL_GROUPS).flatMap((names) => [...names]);

    // No duplicates across groups.
    expect(new Set(grouped).size).toBe(grouped.length);
    // Set equality against the canonical registry.
    expect([...grouped].sort()).toEqual([...VIBECODE_MCP_TOOL_NAMES].sort());
  });
});
