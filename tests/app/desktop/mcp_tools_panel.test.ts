import { describe, expect, test } from 'vitest';

import McpToolsPanel from '../../../src/app/desktop/renderer/mcp_tools_panel.js';
import type { McpToolCatalog } from '../../../src/app/desktop/renderer/mcp_tools_panel.js';

const sampleCatalog: McpToolCatalog = {
  tool_count: 3,
  generated_from: { registry: true, schemas: true, profiles: true },
  groups: [
    { id: 'workspace_orientation', title: 'Workspace orientation', tool_names: ['vibecode_session_bootstrap'] },
    { id: 'coordination', title: 'Coordination', tool_names: ['vibecode_claim_add', 'vibecode_handoff_prepare'] },
  ],
  warnings: [],
  tools: [
    {
      name: 'vibecode_session_bootstrap',
      title: 'Session bootstrap',
      group: 'workspace_orientation',
      summary: 'Orient/register an agent and return runtime guidance.',
      description: 'One-call repo, git, agent, claims, runtime, and recovery orientation.',
      side_effect: 'generated_state_write',
      input_schema: { type: 'object', properties: { register: { type: 'boolean' } } },
      output_contract: {
        summary: 'Returns repo/session/git/claims/conflicts/runtime awareness and recovery guidance.',
        important_fields: ['repo', 'server_identity', 'runtime_awareness'],
      },
      cli_equivalents: ['vibecode session bootstrap --json'],
      profiles: ['read_only_orientation', 'runtime_preflight'],
      safety_notes: ['May register or heartbeat an agent when asked.'],
      source_files: ['src/app/mcp/tools/session_bootstrap.ts'],
      test_files: ['tests/app/mcp/session_bootstrap_tool.test.ts'],
    },
    {
      name: 'vibecode_claim_add',
      title: 'Claim add',
      group: 'coordination',
      summary: 'Create an advisory claim.',
      description: 'Claims one explicit repo-relative file for an active build agent.',
      side_effect: 'coordination_write',
      input_schema: { type: 'object', required: ['agent_id', 'path'] },
      output_contract: { summary: 'Returns created claim detail or conflict diagnostics.' },
      cli_equivalents: ['vibecode claims add --json'],
      profiles: ['build_pre_edit'],
      safety_notes: ['Writes generated coordination state only.'],
      source_files: ['src/app/mcp/tools/claims.ts'],
      test_files: ['tests/app/mcp/claim_tools.test.ts'],
    },
    {
      name: 'vibecode_handoff_prepare',
      title: 'Handoff prepare',
      group: 'coordination',
      summary: 'Read-only handoff packet; no transfer.',
      description: 'Builds visibility for a stopping agent.',
      side_effect: 'read_only',
      input_schema: { type: 'object', required: ['agent_id'] },
      output_contract: { summary: 'Returns handoff_state, owned work, blockers, safe commands, and do_not_do.' },
      cli_equivalents: ['vibecode handoff prepare --json'],
      profiles: ['team_handoff'],
      safety_notes: ['Does not transfer ownership.'],
      source_files: ['src/app/mcp/tools/handoff_prepare.ts'],
      test_files: ['tests/app/mcp/handoff_tool.test.ts'],
    },
  ],
};

describe('desktop MCP tool catalog renderer', () => {
  test('renders header, search/filter controls, grouped tools, and total count from data', () => {
    const html = McpToolsPanel.renderCatalogHtml(sampleCatalog, { selectedName: 'vibecode_session_bootstrap' });

    expect(html).toContain('MCP Tools');
    expect(html).toContain('3 tools');
    expect(html).toContain('loaded from registry');
    expect(html).toContain('type="search"');
    expect(html).toContain('data-filter="group"');
    expect(html).toContain('data-filter="side-effect"');
    expect(html).toContain('data-filter="profile"');
    expect(html).toContain('Workspace orientation');
    expect(html).toContain('Coordination');
    expect(html).toContain('vibecode_session_bootstrap');
  });

  test('filters by search, side effect, group, and profile', () => {
    const html = McpToolsPanel.renderCatalogHtml(sampleCatalog, {
      query: 'handoff',
      group: 'coordination',
      sideEffect: 'read_only',
      profile: 'team_handoff',
      selectedName: 'vibecode_handoff_prepare',
    });

    expect(html).toContain('vibecode_handoff_prepare');
    expect(html).not.toContain('vibecode_session_bootstrap');
    expect(html).not.toContain('vibecode_claim_add');
  });

  test('selecting a tool renders schema and output contract detail', () => {
    const html = McpToolsPanel.renderCatalogHtml(sampleCatalog, { selectedName: 'vibecode_session_bootstrap' });

    expect(html).toContain('Session bootstrap');
    expect(html).toContain('When to use');
    expect(html).toContain('Inputs');
    expect(html).toContain('What the agent receives');
    expect(html).toContain('runtime_awareness');
    expect(html).toContain('vibecode session bootstrap --json');
    expect(html).toContain('read_only_orientation');
    expect(html).toContain('src/app/mcp/tools/session_bootstrap.ts');
  });

  test('renders side-effect badges and safe empty state', () => {
    const html = McpToolsPanel.renderCatalogHtml(sampleCatalog, { selectedName: 'vibecode_claim_add' });
    const empty = McpToolsPanel.renderCatalogHtml(null);

    expect(html).toContain('coordination write');
    expect(html).toContain('generated state write');
    expect(empty).toContain('MCP tool catalog is unavailable');
  });

  test('never renders a tool execution button or mutation action', () => {
    const html = McpToolsPanel.renderCatalogHtml(sampleCatalog, { selectedName: 'vibecode_claim_add' });

    expect(html).not.toMatch(/Run tool|Execute tool|Call tool/i);
    expect(html).not.toMatch(/data-action="run|data-action="execute|data-action="call/i);
  });
});
