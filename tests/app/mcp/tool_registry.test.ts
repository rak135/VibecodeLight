import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildVibecodeMcpTools,
  VIBECODE_MCP_TOOL_NAMES,
} from '../../../src/app/mcp/index.js';
import { buildAgentGuidanceMcpTools } from '../../../src/core/config/agent_guidance_mcp_tools.js';
import { getAgentGuidanceConfigPath } from '../../../src/core/config/agent_guidance_config.js';

function fixture(): { appData: string; env: Record<string, string>; cleanup: () => void } {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-tool-registry-ag-'));
  return {
    appData,
    env: { LOCALAPPDATA: appData },
    cleanup: () => fs.rmSync(appData, { recursive: true, force: true }),
  };
}

function writeGuidance(env: Record<string, string>, yaml: string): void {
  const configPath = getAgentGuidanceConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, yaml, 'utf8');
}

describe('VibecodeMCP tool registry guidance metadata', () => {
  test('canonical descriptions are still present when dynamic guidance is appended', () => {
    const f = fixture();
    try {
      writeGuidance(f.env, [
        'schema_version: 1',
        'enabled: true',
        'default_guidance: "short"',
        'per_tool_notes:',
        '  vibecode_workspace_info: "Start with this configured note."',
        '',
      ].join('\n'));
      const tools = buildVibecodeMcpTools({ agentGuidanceEnv: f.env });
      const workspaceInfo = tools.find((tool) => tool.name === 'vibecode_workspace_info');
      expect(workspaceInfo?.description).toMatch(/^Workspace identity and MCP capability summary/);
      expect(workspaceInfo?.description).toMatch(/User guidance: Start with this configured note\./);
    } finally {
      f.cleanup();
    }
  });

  test('long per-tool notes are truncated in tools/list descriptions', () => {
    const f = fixture();
    try {
      writeGuidance(f.env, [
        'schema_version: 1',
        'enabled: true',
        'default_guidance: "short"',
        'per_tool_notes:',
        `  vibecode_workspace_info: "${'long-note '.repeat(120)}"`,
        '',
      ].join('\n'));
      const tools = buildVibecodeMcpTools({ agentGuidanceEnv: f.env });
      const desc = tools.find((tool) => tool.name === 'vibecode_workspace_info')?.description ?? '';
      expect(desc).toMatch(/User guidance:/);
      expect(desc).toMatch(/truncated/i);
      expect(desc.length).toBeLessThan(500);
    } finally {
      f.cleanup();
    }
  });

  test('disabled guidance keeps dynamic descriptions off', () => {
    const f = fixture();
    try {
      writeGuidance(f.env, [
        'schema_version: 1',
        'enabled: false',
        'default_guidance: "short"',
        'per_tool_notes:',
        '  vibecode_workspace_info: "SHOULD_NOT_APPEND"',
        '',
      ].join('\n'));
      const tools = buildVibecodeMcpTools({ agentGuidanceEnv: f.env });
      const desc = tools.find((tool) => tool.name === 'vibecode_workspace_info')?.description ?? '';
      expect(desc).not.toContain('SHOULD_NOT_APPEND');
      expect(desc).not.toMatch(/User guidance:/);
    } finally {
      f.cleanup();
    }
  });

  test('dynamic descriptions do not break schemas or tool count', () => {
    const f = fixture();
    try {
      writeGuidance(f.env, 'schema_version: 1\ndefault_guidance: "short"\n');
      const tools = buildVibecodeMcpTools({ agentGuidanceEnv: f.env });
      expect(tools).toHaveLength(29);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.additionalProperties).toBe(false);
      }
    } finally {
      f.cleanup();
    }
  });

  test('Settings MCP inventory stays in parity with the canonical registry', () => {
    const settingsNames = buildAgentGuidanceMcpTools().map((tool) => tool.name).sort();
    expect(settingsNames).toEqual([...VIBECODE_MCP_TOOL_NAMES].sort());
    expect(settingsNames).toHaveLength(29);
  });
});
