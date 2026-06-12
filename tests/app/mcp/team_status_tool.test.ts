import { describe, expect, test } from 'vitest';

import {
  buildVibecodeMcpTools,
  VIBECODE_MCP_TOOL_NAMES,
} from '../../../src/app/mcp/index.js';

/**
 * VibecodeMCP v1 removes vibecode_team_status from the public surface.
 *
 * What breaks if removed:
 *   - the old public team overview tool could reappear after the v1 cleanup;
 *   - tests could silently drift back to the old 45-tool public surface.
 */

describe('vibecode_team_status public MCP removal', () => {
  test('old team_status tool is not registered in the canonical tool list', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).not.toContain('vibecode_team_status');
  });

  test('v1 public tool count is 14', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).toHaveLength(14);
  });

  test('handoff is the public v1 visibility tool', () => {
    const tools = buildVibecodeMcpTools();
    const tool = tools.find((t) => t.name === 'vibecode_handoff');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('handoff');
    expect(tool!.description).toContain('no ownership transfer');
  });

  test('handoff input schema accepts mode and agent fields', () => {
    const tools = buildVibecodeMcpTools();
    const tool = tools.find((t) => t.name === 'vibecode_handoff')!;
    const schema = tool.inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toBeDefined();
    expect(schema.properties!.mode).toBeDefined();
    expect(schema.properties!.agent_id).toBeDefined();
    expect(schema.properties!.max_items).toBeDefined();
  });
});
