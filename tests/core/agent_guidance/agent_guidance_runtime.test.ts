import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildAgentGuidanceRuntime,
  buildMcpServerInstructions,
  appendAgentGuidanceToToolDescription,
} from '../../../src/core/agent_guidance/agent_guidance_runtime.js';
import { getAgentGuidanceConfigPath } from '../../../src/core/config/agent_guidance_config.js';

function makeAppData(): { appData: string; env: Record<string, string> } {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-ag-runtime-'));
  return { appData, env: { LOCALAPPDATA: appData } };
}

function writeGuidance(env: Record<string, string>, yaml: string): string {
  const configPath = getAgentGuidanceConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, yaml, 'utf8');
  return configPath;
}

const TOOLS = [
  { name: 'vibecode_workspace_info', group: 'workspace_orientation' as const, description: 'Workspace info.' },
  { name: 'vibecode_mcp_guidance', group: 'workspace_orientation' as const, description: 'Guidance.' },
  { name: 'vibecode_codegraph_search', group: 'codegraph' as const, description: 'Search.' },
];

describe('agent guidance runtime', () => {
  test('builds effective runtime guidance from defaults', () => {
    const { appData, env } = makeAppData();
    try {
      const runtime = buildAgentGuidanceRuntime({ env, mcpTools: TOOLS });
      expect(runtime.enabled).toBe(true);
      expect(runtime.apply_to_terminal_agents).toBe(true);
      expect(runtime.source).toBe('defaults');
      expect(runtime.config_path).toBe(getAgentGuidanceConfigPath(env));
      expect(runtime.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(runtime.general_guidance).toMatch(/VibecodeMCP/);
      expect(runtime.fallback_guidance).toMatch(/Vibecode CLI/);
      expect(runtime.approval_boundary).toMatch(/does not manage.*approval/i);
      expect(runtime.mcp_tool_groups.workspace_orientation).toContain('vibecode_mcp_guidance');
      expect(path.basename(runtime.config_path)).toBe('agent-guidance-config.yaml');
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  test('builds effective runtime guidance from file config and changes hash when text changes', () => {
    const { appData, env } = makeAppData();
    try {
      writeGuidance(env, [
        'schema_version: 1',
        'enabled: true',
        'apply_to_terminal_agents: true',
        'scope: global',
        'default_guidance: "CUSTOM_GUIDANCE_A"',
        'per_tool_notes:',
        '  vibecode_workspace_info: "CUSTOM_NOTE_A"',
        '',
      ].join('\n'));
      const first = buildAgentGuidanceRuntime({ env, mcpTools: TOOLS });
      expect(first.source).toBe('file');
      expect(first.general_guidance).toBe('CUSTOM_GUIDANCE_A');
      expect(first.per_tool_notes.vibecode_workspace_info).toBe('CUSTOM_NOTE_A');

      writeGuidance(env, [
        'schema_version: 1',
        'enabled: true',
        'apply_to_terminal_agents: true',
        'scope: global',
        'default_guidance: "CUSTOM_GUIDANCE_B"',
        '',
      ].join('\n'));
      const second = buildAgentGuidanceRuntime({ env, mcpTools: TOOLS });
      expect(second.guidance_hash).not.toBe(first.guidance_hash);
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  test('disabled config returns a compact disabled payload without large guidance text', () => {
    const { appData, env } = makeAppData();
    try {
      writeGuidance(env, [
        'schema_version: 1',
        'enabled: false',
        'apply_to_terminal_agents: false',
        'scope: global',
        'default_guidance: "SHOULD_NOT_BE_RETURNED_WHEN_DISABLED"',
        '',
      ].join('\n'));
      const runtime = buildAgentGuidanceRuntime({ env, mcpTools: TOOLS });
      expect(runtime.enabled).toBe(false);
      expect(runtime.disabled_message).toMatch(/disabled/i);
      expect(runtime.general_guidance).toBe('');
      expect(JSON.stringify(runtime)).not.toContain('SHOULD_NOT_BE_RETURNED_WHEN_DISABLED');
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  test('invalid config returns warning and default runtime payload without crashing', () => {
    const { appData, env } = makeAppData();
    try {
      writeGuidance(env, ': not valid yaml: : :::\n');
      const runtime = buildAgentGuidanceRuntime({ env, mcpTools: TOOLS });
      expect(runtime.enabled).toBe(true);
      expect(runtime.source).toBe('invalid_file_with_defaults');
      expect(runtime.warnings.join('\n')).toMatch(/AGENT_GUIDANCE_CONFIG_PARSE_ERROR/);
      expect(runtime.general_guidance).toMatch(/VibecodeMCP/);
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  test('per-tool notes are bounded and unknown tool notes are dropped', () => {
    const { appData, env } = makeAppData();
    try {
      writeGuidance(env, [
        'schema_version: 1',
        'enabled: true',
        'default_guidance: "short"',
        'per_tool_notes:',
        `  vibecode_workspace_info: "${'x'.repeat(900)}"`,
        '  unknown_tool: "must not surface"',
        '',
      ].join('\n'));
      const runtime = buildAgentGuidanceRuntime({ env, mcpTools: TOOLS, maxPerToolNoteChars: 120 });
      expect(runtime.per_tool_notes.vibecode_workspace_info.length).toBeLessThanOrEqual(160);
      expect(runtime.per_tool_notes.vibecode_workspace_info).toMatch(/truncated/i);
      expect(runtime.per_tool_notes).not.toHaveProperty('unknown_tool');
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  test('does not include secret-looking env values or root/.vibecode config paths', () => {
    const { appData, env } = makeAppData();
    try {
      const secretEnv = { ...env, OPENROUTER_API_KEY: 'sk-runtime-secret' };
      const runtime = buildAgentGuidanceRuntime({ env: secretEnv, mcpTools: TOOLS });
      const blob = JSON.stringify(runtime);
      expect(blob).not.toContain('sk-runtime-secret');
      expect(blob).not.toContain(path.join('.vibecode', 'config.yaml'));
      expect(runtime.config_path.endsWith(path.join('vibecodelight', 'config.yaml'))).toBe(false);
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  test('buildMcpServerInstructions is short and recommends only v1 public tools', () => {
    const { appData, env } = makeAppData();
    try {
      const runtime = buildAgentGuidanceRuntime({ env, mcpTools: TOOLS });
      const instructions = buildMcpServerInstructions(runtime);
      expect(instructions).not.toMatch(/vibecode_mcp_guidance/);
      expect(instructions).toMatch(/vibecode_session_start/);
      expect(instructions).toMatch(/vibecode_workspace_snapshot/);
      expect(instructions).toMatch(runtime.guidance_hash.slice(0, 12));
      expect(instructions.length).toBeLessThan(900);
      expect(instructions).not.toContain(runtime.general_guidance.trim());
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  test('appendAgentGuidanceToToolDescription appends bounded user guidance only when enabled', () => {
    const { appData, env } = makeAppData();
    try {
      writeGuidance(env, [
        'schema_version: 1',
        'enabled: true',
        'default_guidance: "short"',
        'per_tool_notes:',
        `  vibecode_workspace_info: "${'note '.repeat(100)}"`,
        '',
      ].join('\n'));
      const runtime = buildAgentGuidanceRuntime({ env, mcpTools: TOOLS, maxDescriptionNoteChars: 80 });
      const desc = appendAgentGuidanceToToolDescription('Canonical description.', 'vibecode_workspace_info', runtime);
      expect(desc).toMatch(/^Canonical description\./);
      expect(desc).toMatch(/User guidance:/);
      expect(desc).toMatch(/truncated/i);
      expect(desc.length).toBeLessThan(220);

      const disabled = { ...runtime, enabled: false };
      expect(appendAgentGuidanceToToolDescription('Canonical description.', 'vibecode_workspace_info', disabled))
        .toBe('Canonical description.');
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });
});
