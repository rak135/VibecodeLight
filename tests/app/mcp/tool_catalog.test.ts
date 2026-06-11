import { describe, expect, test } from 'vitest';

import {
  MCP_TOOL_CONTRACTS,
  getMcpToolCatalog,
  getMcpToolDetail,
} from '../../../src/app/mcp/tool_catalog.js';
import {
  buildVibecodeMcpTools,
  VIBECODE_MCP_TOOL_NAMES,
} from '../../../src/app/mcp/index.js';
import { listToolProfiles } from '../../../src/core/agent_guidance/tool_profiles.js';

/**
 * Phase 4C catalog contract.
 *
 * What breaks if removed:
 *   - the desktop catalog could drift from the live MCP registry;
 *   - agents/users could lose the input/output/safety contract for a tool;
 *   - the UI could silently reintroduce a hardcoded renderer-side tool list.
 */

describe('MCP tool catalog', () => {
  test('catalog tool_count, names, and order are derived from the actual registry', () => {
    const registryTools = buildVibecodeMcpTools();
    const catalog = getMcpToolCatalog();

    expect(catalog.generated_from).toEqual({ registry: true, schemas: true, profiles: true });
    expect(catalog.tool_count).toBe(registryTools.length);
    expect(catalog.tool_count).toBe(VIBECODE_MCP_TOOL_NAMES.length);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(registryTools.map((tool) => tool.name));
  });

  test('metadata map is in lockstep with the registry', () => {
    const registryNames = buildVibecodeMcpTools().map((tool) => tool.name).sort();
    const metadataNames = Object.keys(MCP_TOOL_CONTRACTS).sort();

    expect(metadataNames).toEqual(registryNames);
  });

  test('every catalog item exposes input schema, side effect, output summary, safety, and source/test pointers', () => {
    const catalog = getMcpToolCatalog();

    for (const tool of catalog.tools) {
      expect(tool.name).toMatch(/^vibecode_/);
      expect(tool.title.trim().length).toBeGreaterThan(0);
      expect(tool.group.trim().length).toBeGreaterThan(0);
      expect(tool.summary.trim().length).toBeGreaterThan(0);
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(['read_only', 'coordination_write', 'git_mutation', 'generated_state_write', 'unknown']).toContain(tool.side_effect);
      expect(tool.input_schema).toBeTruthy();
      expect(tool.output_contract.summary.trim().length).toBeGreaterThan(0);
      expect(tool.safety_notes.length).toBeGreaterThan(0);
      expect(tool.source_files.length).toBeGreaterThan(0);
      expect(tool.test_files.length).toBeGreaterThan(0);
      for (const command of tool.cli_equivalents) {
        expect(command.startsWith('vibecode ')).toBe(true);
      }
    }
  });

  test('profiles listed in the catalog match actual tool profile references', () => {
    const expectedByTool = new Map<string, string[]>();
    for (const profile of listToolProfiles()) {
      for (const tool of profile.mcp_tools) {
        const list = expectedByTool.get(tool.name) ?? [];
        list.push(profile.profile_id);
        expectedByTool.set(tool.name, list);
      }
    }

    const catalog = getMcpToolCatalog();
    for (const tool of catalog.tools) {
      expect(tool.profiles).toEqual(expectedByTool.get(tool.name) ?? []);
    }
  });

  test('handoff tools are read-only and describe visibility without ownership transfer', () => {
    const prepare = getMcpToolDetail('vibecode_handoff_prepare');
    const guide = getMcpToolDetail('vibecode_handoff_guide');

    expect(prepare?.side_effect).toBe('read_only');
    expect(guide?.side_effect).toBe('read_only');
    expect([
      prepare?.summary,
      prepare?.description,
      prepare?.output_contract.summary,
      ...(prepare?.safety_notes ?? []),
    ].join(' ').toLowerCase()).toMatch(/read-only|read only/);
    expect([
      guide?.summary,
      guide?.description,
      guide?.output_contract.summary,
      ...(guide?.safety_notes ?? []),
    ].join(' ').toLowerCase()).toMatch(/no ownership transfer|never transfers ownership|does not transfer/);
  });

  test('commit guard is not exposed as an MCP catalog tool', () => {
    const catalog = getMcpToolCatalog();
    expect(catalog.tools.map((tool) => tool.name)).not.toContain('vibecode_commit_guard');
    expect(getMcpToolDetail('vibecode_commit_guard')).toBeNull();
  });

  test('catalog is bounded and deterministic', () => {
    const first = getMcpToolCatalog();
    const second = getMcpToolCatalog();

    expect(second).toEqual(first);
    expect(JSON.stringify(first).length).toBeLessThan(180_000);
    expect(first.groups.flatMap((group) => group.tool_names)).toEqual(first.tools.map((tool) => tool.name));
    expect(first.warnings).toEqual([]);
  });
});
