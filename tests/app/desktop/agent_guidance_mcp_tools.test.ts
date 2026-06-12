import {
  AGENT_GUIDANCE_MCP_TOOL_GROUPS,
  buildAgentGuidanceMcpTools,
} from '../../../src/core/config/agent_guidance_mcp_tools.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';

describe('agent guidance settings — MCP tool metadata', () => {
  test('buildAgentGuidanceMcpTools returns names from the canonical MCP tool registry', () => {
    const tools = buildAgentGuidanceMcpTools();
    const names = tools.map((t) => t.name);
    for (const name of names) {
      expect(VIBECODE_MCP_TOOL_NAMES).toContain(name);
    }
  });

  test('group mapping matches the documented Settings groups', () => {
    expect(AGENT_GUIDANCE_MCP_TOOL_GROUPS.workspace_orientation).toEqual(
      expect.arrayContaining([
        'vibecode_session_start',
        'vibecode_workspace_snapshot',
        'vibecode_project_instructions',
        'vibecode_changes',
      ]),
    );
    expect(AGENT_GUIDANCE_MCP_TOOL_GROUPS.codegraph).toEqual(
      expect.arrayContaining([
        'vibecode_codegraph_search',
        'vibecode_codegraph_explore',
        'vibecode_codegraph_callers',
        'vibecode_codegraph_impact',
      ]),
    );
    expect(AGENT_GUIDANCE_MCP_TOOL_GROUPS.runs_artifacts).toEqual(
      expect.arrayContaining([
        'vibecode_run_status',
        'vibecode_artifact_read',
      ]),
    );
  });

  test('every entry carries a non-empty description and a group label', () => {
    const tools = buildAgentGuidanceMcpTools();
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(['workspace_orientation', 'codegraph', 'runs_artifacts', 'coordination']).toContain(tool.group);
    }
  });

  test('tools are tolerant of MCP-2 state when workspace orientation tools are absent', () => {
    const filtered = buildAgentGuidanceMcpTools({
      availableNames: new Set([
        'vibecode_codegraph_status',
        'vibecode_codegraph_search',
        'vibecode_run_status',
        'vibecode_artifact_read',
      ]),
    });
    expect(filtered.find((t) => t.name === 'vibecode_workspace_snapshot')).toBeUndefined();
    expect(filtered.find((t) => t.group === 'codegraph')).toBeTruthy();
    expect(filtered.find((t) => t.group === 'runs_artifacts')).toBeTruthy();
  });
});
