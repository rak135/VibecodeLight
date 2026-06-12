import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildMcpGuidanceTool } from '../../../src/app/mcp/tools/mcp_guidance.js';
import { buildWorkspaceInfoTool } from '../../../src/app/mcp/tools/workspace_info.js';
import { getAgentGuidanceConfigPath } from '../../../src/core/config/agent_guidance_config.js';
import type { CodeGraphStatusResult } from '../../../src/adapters/codegraph/codegraph_actions.js';

const STATUS: CodeGraphStatusResult = {
  ok: true,
  available: true,
  initialized: true,
  version: '0.9.4',
  warnings: [],
};

function fixture(): { repoRoot: string; appData: string; env: Record<string, string>; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-guidance-repo-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-guidance-app-'));
  return {
    repoRoot,
    appData,
    env: { LOCALAPPDATA: appData },
    cleanup: () => {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(appData, { recursive: true, force: true });
    },
  };
}

function writeGuidance(env: Record<string, string>, yaml: string): string {
  const configPath = getAgentGuidanceConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, yaml, 'utf8');
  return configPath;
}

describe('vibecode_mcp_guidance dynamic output', () => {
  test('returns effective configured guidance with path, source, hash, fallback, and approval boundary', async () => {
    const f = fixture();
    try {
      const configPath = writeGuidance(f.env, [
        'schema_version: 1',
        'enabled: true',
        'apply_to_terminal_agents: true',
        'scope: global',
        'default_guidance: "CUSTOM_MCP_GUIDANCE"',
        'per_tool_notes:',
        '  vibecode_workspace_snapshot: "CUSTOM_WORKSPACE_NOTE"',
        '',
      ].join('\n'));
      const tool = buildMcpGuidanceTool({ env: f.env });
      const result = await tool.handler({ context: { repoRoot: f.repoRoot }, arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        enabled: boolean;
        config_path: string;
        source: string;
        guidance_hash: string;
        general_guidance: string;
        per_tool_notes: Record<string, string>;
        fallback_guidance: string;
        approval_boundary: string;
      };
      expect(data.enabled).toBe(true);
      expect(data.config_path).toBe(configPath);
      expect(data.source).toBe('file');
      expect(data.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(data.general_guidance).toBe('CUSTOM_MCP_GUIDANCE');
      expect(data.per_tool_notes.vibecode_workspace_snapshot).toBe('CUSTOM_WORKSPACE_NOTE');
      expect(data.fallback_guidance).toMatch(/Vibecode CLI/);
      expect(data.approval_boundary).toMatch(/does not manage.*approval/i);
      expect(result.content[0]?.text ?? '').toMatch(/CUSTOM_MCP_GUIDANCE/);
    } finally {
      f.cleanup();
    }
  });

  test('missing config uses defaults', async () => {
    const f = fixture();
    try {
      const tool = buildMcpGuidanceTool({ env: f.env });
      const result = await tool.handler({ context: { repoRoot: f.repoRoot }, arguments: {}, requestId: null });
      const data = result.structuredContent.data as { source: string; general_guidance: string };
      expect(result.isError).toBe(false);
      expect(data.source).toBe('defaults');
      expect(data.general_guidance).toMatch(/VibecodeMCP/);
    } finally {
      f.cleanup();
    }
  });

  test('invalid config does not crash and returns warning with defaults', async () => {
    const f = fixture();
    try {
      writeGuidance(f.env, ': not valid yaml: : :::\n');
      const tool = buildMcpGuidanceTool({ env: f.env });
      const result = await tool.handler({ context: { repoRoot: f.repoRoot }, arguments: {}, requestId: null });
      const data = result.structuredContent.data as { source: string; warnings: string[]; general_guidance: string };
      expect(result.isError).toBe(false);
      expect(data.source).toBe('invalid_file_with_defaults');
      expect(data.warnings.join('\n')).toMatch(/AGENT_GUIDANCE_CONFIG_PARSE_ERROR/);
      expect(data.general_guidance).toMatch(/VibecodeMCP/);
    } finally {
      f.cleanup();
    }
  });

  test('disabled config returns short disabled message and omits large guidance', async () => {
    const f = fixture();
    try {
      writeGuidance(f.env, [
        'schema_version: 1',
        'enabled: false',
        'apply_to_terminal_agents: false',
        'scope: global',
        'default_guidance: "DISABLED_TEXT_SHOULD_NOT_SURFACE"',
        '',
      ].join('\n'));
      const tool = buildMcpGuidanceTool({ env: f.env });
      const result = await tool.handler({ context: { repoRoot: f.repoRoot }, arguments: {}, requestId: null });
      const blob = JSON.stringify(result);
      const data = result.structuredContent.data as { enabled: boolean; disabled_message: string; config_path: string };
      expect(data.enabled).toBe(false);
      expect(data.disabled_message).toMatch(/disabled/i);
      expect(data.config_path).toMatch(/agent-guidance-config\.yaml$/);
      expect(blob).not.toContain('DISABLED_TEXT_SHOULD_NOT_SURFACE');
    } finally {
      f.cleanup();
    }
  });

  test('tool output is bounded and does not include secret-looking env values', async () => {
    const f = fixture();
    try {
      writeGuidance(f.env, [
        'schema_version: 1',
        'enabled: true',
        `default_guidance: "${'long '.repeat(2000)}"`,
        '',
      ].join('\n'));
      const tool = buildMcpGuidanceTool({ env: { ...f.env, OPENROUTER_API_KEY: 'sk-mcp-secret' } });
      const result = await tool.handler({ context: { repoRoot: f.repoRoot }, arguments: {}, requestId: null });
      const blob = JSON.stringify(result);
      expect(blob.length).toBeLessThan(20000);
      expect(blob).not.toContain('sk-mcp-secret');
    } finally {
      f.cleanup();
    }
  });
});

describe('workspace guidance summary', () => {
  test('workspace_info includes compact guidance status and points to vibecode_mcp_guidance', async () => {
    const f = fixture();
    try {
      writeGuidance(f.env, 'schema_version: 1\ndefault_guidance: "workspace summary guidance"\n');
      const tool = buildWorkspaceInfoTool({
        env: f.env,
        codegraphStatus: async () => STATUS,
      });
      const result = await tool.handler({ context: { repoRoot: f.repoRoot }, arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        guidance_status: {
          enabled: boolean;
          source: string;
          guidance_hash: string;
          config_path: string;
          recommendation: string;
        };
      };
      expect(data.guidance_status.enabled).toBe(true);
      expect(data.guidance_status.source).toBe('file');
      expect(data.guidance_status.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(data.guidance_status.config_path).toMatch(/agent-guidance-config\.yaml$/);
      expect(data.guidance_status.recommendation).toMatch(/vibecode_mcp_guidance/);
      expect(result.content[0]?.text ?? '').toMatch(/vibecode_mcp_guidance/);
    } finally {
      f.cleanup();
    }
  });
});
