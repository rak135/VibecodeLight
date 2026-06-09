import { describe, expect, test } from 'vitest';

import { buildToolProfileTool } from '../../../src/app/mcp/tools/tool_profile.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';
import { TOOL_PROFILE_IDS } from '../../../src/core/agent_guidance/tool_profiles.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

/**
 * Phase 1B-3: `vibecode_tool_profile` MCP tool.
 *
 * Pins list/single behavior, unknown-profile + unknown-field rejection, the
 * read-only no-arg contract, and that the tool is part of the canonical registry.
 */

function ctx(): McpServerContext {
  return { repoRoot: '/tmp/whatever' };
}

describe('vibecode_tool_profile', () => {
  test('is part of the canonical MCP registry', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).toContain('vibecode_tool_profile');
  });

  test('without a profile returns the list of profile summaries', async () => {
    const tool = buildToolProfileTool();
    const result = await tool.handler({ context: ctx(), arguments: {}, requestId: null });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      mode: string;
      profiles: Array<{ profile_id: string; title: string; purpose: string }>;
      count: number;
    };
    expect(data.mode).toBe('list');
    expect(data.count).toBe(TOOL_PROFILE_IDS.length);
    expect(data.profiles.map((p) => p.profile_id)).toEqual([...TOOL_PROFILE_IDS]);
    // Compact: summaries carry no tool lists.
    for (const p of data.profiles) {
      expect(Object.keys(p).sort()).toEqual(['profile_id', 'purpose', 'title']);
    }
    // Text block is readable and lists profile ids.
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/build_pre_edit/);
    expect(text).toMatch(/conflict_resolution/);
  });

  test('with a valid profile returns the full profile', async () => {
    const tool = buildToolProfileTool();
    const result = await tool.handler({ context: ctx(), arguments: { profile: 'build_pre_edit' }, requestId: null });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      mode: string;
      profile: {
        profile_id: string;
        title: string;
        purpose: string;
        mcp_tools: Array<{ name: string; reason: string }>;
        cli_commands: Array<{ command: string; reason: string }>;
      };
    };
    expect(data.mode).toBe('profile');
    expect(data.profile.profile_id).toBe('build_pre_edit');
    expect(data.profile.mcp_tools.length).toBeGreaterThan(0);
    expect(data.profile.cli_commands.length).toBeGreaterThan(0);
    // Every recommended MCP tool name is a real registered tool.
    const registry = new Set(VIBECODE_MCP_TOOL_NAMES);
    for (const t of data.profile.mcp_tools) {
      expect(registry.has(t.name)).toBe(true);
    }
    // Text block restates the recommended tools.
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/vibecode_claim_add/);
  });

  test('unknown profile id returns INVALID_ARGUMENT', async () => {
    const tool = buildToolProfileTool();
    const result = await tool.handler({ context: ctx(), arguments: { profile: 'nope' }, requestId: null });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('unknown argument keys are rejected with INVALID_ARGUMENT', async () => {
    const tool = buildToolProfileTool();
    const result = await tool.handler({
      context: ctx(),
      arguments: { repo: '/etc', profile: 'build_pre_edit' } as Record<string, unknown>,
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('schema is additionalProperties=false and never accepts a repo key', () => {
    const tool = buildToolProfileTool();
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('repo');
  });
});
