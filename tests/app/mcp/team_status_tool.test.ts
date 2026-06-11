import { describe, expect, test } from 'vitest';

import {
  buildVibecodeMcpTools,
  VIBECODE_MCP_TOOL_NAMES,
} from '../../../src/app/mcp/index.js';

/**
 * Phase 4C — vibecode_team_status MCP tool.
 *
 * What breaks if removed:
 *   - agents lose the read-only team overview MCP tool;
 *   - MCP/CLI parity breaks (CLI has `vibecode team status` but MCP has no tool);
 *   - tool count lockstep tests fail.
 */

describe('vibecode_team_status MCP tool', () => {
  test('tool is registered in the canonical tool list', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).toContain('vibecode_team_status');
  });

  test('tool count includes team_status (45)', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).toHaveLength(45);
  });

  test('tool definition has correct name and description', () => {
    const tools = buildVibecodeMcpTools();
    const tool = tools.find((t) => t.name === 'vibecode_team_status');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('vibecode_team_status');
    expect(tool!.description).toContain('team');
    expect(tool!.description).toContain('Read-only');
    expect(tool!.description).toContain('never assigns');
  });

  test('tool input schema accepts optional max_agents and max_items', () => {
    const tools = buildVibecodeMcpTools();
    const tool = tools.find((t) => t.name === 'vibecode_team_status')!;
    const schema = tool.inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toBeDefined();
    expect(schema.properties!.max_agents).toBeDefined();
    expect(schema.properties!.max_items).toBeDefined();
  });
});
