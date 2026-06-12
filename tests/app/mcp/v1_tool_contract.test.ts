import fs from 'fs';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createVibecodeMcpServer,
  VIBECODE_MCP_TOOL_NAMES,
} from '../../../src/app/mcp/index.js';
import {
  MCP_TOOL_CONTRACTS,
  getMcpToolCatalog,
} from '../../../src/app/mcp/tool_catalog.js';

/**
 * VibecodeMCP Tool Contract v1.
 *
 * What breaks if removed:
 *   - the public MCP surface can drift back to the old large tool list;
 *   - legacy public aliases can reappear in tools/list or catalog metadata;
 *   - old tool names can remain callable after the breaking contract cleanup.
 */

export const V1_PUBLIC_TOOLS = [
  'vibecode_session_start',
  'vibecode_workspace_snapshot',
  'vibecode_project_instructions',
  'vibecode_run_status',
  'vibecode_artifact_read',
  'vibecode_changes',
  'vibecode_codegraph_search',
  'vibecode_codegraph_explore',
  'vibecode_codegraph_callers',
  'vibecode_codegraph_impact',
  'vibecode_build_start',
  'vibecode_build_scope',
  'vibecode_build_finish',
  'vibecode_handoff',
] as const;

const OLD_PUBLIC_TOOLS = [
  'vibecode_session_bootstrap',
  'vibecode_workspace_info',
  'vibecode_workspace_status',
  'vibecode_mcp_guidance',
  'vibecode_git_changes',
  'vibecode_finalize_check',
  'vibecode_claims_add_bulk',
  'vibecode_claim_intents_list',
  'vibecode_handoff_prepare',
  'vibecode_handoff_guide',
  'vibecode_agent_heartbeat',
  'vibecode_scan_artifact_read',
] as const;

async function connectClient(repoRoot: string) {
  const handle = createVibecodeMcpServer({
    context: { repoRoot },
    logLevel: 'silent',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.connect(serverTransport);
  const client = new Client({ name: 'vibecode-mcp-v1-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { handle, client };
}

describe('VibecodeMCP Tool Contract v1 public surface', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-v1-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('registry constants expose exactly the 14 v1 public tools', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).toEqual(V1_PUBLIC_TOOLS);
  });

  test('tools/list returns exactly the 14 v1 public tools and no old public names', async () => {
    const { handle, client } = await connectClient(repoRoot);
    try {
      const listed = await client.listTools();
      const names = (listed.tools ?? []).map((tool) => tool.name);

      expect(names).toEqual(V1_PUBLIC_TOOLS);
      for (const oldName of OLD_PUBLIC_TOOLS) {
        expect(names).not.toContain(oldName);
      }
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test('old public MCP names fail as unsupported tools across every tool category', async () => {
    const { handle, client } = await connectClient(repoRoot);
    // One representative per removed category: session/bootstrap, heartbeat,
    // claims, finalize, renamed CodeGraph, handoff, guidance, evidence, scan.
    const representatives = [
      'vibecode_session_bootstrap',
      'vibecode_agent_heartbeat',
      'vibecode_claims_add_bulk',
      'vibecode_claim_add',
      'vibecode_finalize_check',
      'vibecode_codegraph_context',
      'vibecode_handoff_prepare',
      'vibecode_handoff_guide',
      'vibecode_mcp_guidance',
      'vibecode_evidence_scan',
      'vibecode_scan_artifact_read',
      'vibecode_tool_profile',
    ];
    try {
      for (const name of representatives) {
        const result = (await client.callTool({
          name,
          arguments: {},
        })) as { isError?: boolean; structuredContent?: { error?: { code?: string } } };

        expect(result.isError, `${name} must not be callable`).toBe(true);
        expect(result.structuredContent?.error?.code, `${name} must fail structured`).toBe('UNSUPPORTED_TOOL');
      }
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test('tool catalog contains v1 metadata only', () => {
    const catalog = getMcpToolCatalog();
    const names = catalog.tools.map((tool) => tool.name);

    expect(names).toEqual(V1_PUBLIC_TOOLS);
    expect(Object.keys(MCP_TOOL_CONTRACTS)).toEqual(V1_PUBLIC_TOOLS);
    expect(catalog.warnings).toEqual([]);
    for (const tool of catalog.tools) {
      expect(tool.summary.trim()).not.toBe('');
      expect(tool.description.trim()).not.toBe('');
      expect(tool.input_schema).toBeTruthy();
      expect(tool.output_contract.summary.trim()).not.toBe('');
      expect(tool.safety_notes.length).toBeGreaterThan(0);
      expect(tool.source_files.length).toBeGreaterThan(0);
      expect(tool.test_files.length).toBeGreaterThan(0);
    }
    for (const oldName of OLD_PUBLIC_TOOLS) {
      expect(names).not.toContain(oldName);
      expect(MCP_TOOL_CONTRACTS).not.toHaveProperty(oldName);
    }
  });
});
