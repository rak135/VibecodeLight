import AgentGuidanceSettings from '../../../src/app/desktop/renderer/agent_guidance_settings.js';
import type { AgentGuidanceConfigView } from '../../../src/app/desktop/renderer/agent_guidance_settings.js';

const DEFAULT_CONFIG: AgentGuidanceConfigView = {
  schema_version: 1,
  enabled: true,
  apply_to_terminal_agents: true,
  scope: 'global',
  default_guidance: 'When VibecodeMCP tools are available, use them first.\nVibecode does not manage approvals.',
  per_tool_notes: {
    vibecode_workspace_info: 'Start here when entering a repo.',
  },
};

function makeApi(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: { setCalls: unknown[][]; resetCount: number } = { setCalls: [], resetCount: 0 };
  const api = {
    getAgentGuidanceConfig: vi.fn(async () => ({
      ok: true,
      config: structuredClone(DEFAULT_CONFIG),
      source: 'default' as const,
      exists: false,
      configPath: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
      warnings: [] as string[],
    })),
    setAgentGuidanceConfig: vi.fn(async (config: AgentGuidanceConfigView) => {
      calls.setCalls.push([config]);
      return {
        ok: true,
        config,
        configPath: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
        warnings: [] as string[],
      };
    }),
    resetAgentGuidanceConfig: vi.fn(async () => {
      calls.resetCount += 1;
      return {
        ok: true,
        config: structuredClone(DEFAULT_CONFIG),
        configPath: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
        warnings: [],
      };
    }),
    getAgentGuidanceDefaults: vi.fn(async () => ({ ok: true, config: structuredClone(DEFAULT_CONFIG) })),
    getAgentGuidanceConfigPath: vi.fn(async () => ({
      ok: true,
      configPath: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
      filename: 'agent-guidance-config.yaml',
    })),
    getAgentGuidanceMcpTools: vi.fn(async () => ({
      ok: true,
      tools: [
        {
          name: 'vibecode_workspace_info',
          group: 'workspace_orientation' as const,
          description: 'Start here when entering a repo.',
        },
        {
          name: 'vibecode_codegraph_search',
          group: 'codegraph' as const,
          description: 'Search the indexed repo.',
        },
        {
          name: 'vibecode_artifact_read',
          group: 'runs_artifacts' as const,
          description: 'Read one allowlisted run artifact.',
        },
      ],
    })),
    ...overrides,
  };
  return { api, calls };
}

interface ViewSpy {
  setConfig: ReturnType<typeof vi.fn>;
  setPath: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  setMcpTools: ReturnType<typeof vi.fn>;
  setEffectiveGuidance: ReturnType<typeof vi.fn>;
}

function makeView(): ViewSpy {
  return {
    setConfig: vi.fn(),
    setPath: vi.fn(),
    setStatus: vi.fn(),
    setMcpTools: vi.fn(),
    setEffectiveGuidance: vi.fn(),
  };
}

describe('agent guidance settings — effective preview', () => {
  test('buildEffectivePreviewText reflects enabled state and includes approval boundary', () => {
    const text = AgentGuidanceSettings.buildEffectivePreviewText({
      config: DEFAULT_CONFIG,
      mcpTools: [
        { name: 'vibecode_workspace_info', group: 'workspace_orientation', description: 'd' },
      ],
    });
    expect(text).toMatch(/Status: enabled/);
    expect(text).toMatch(/Vibecode does not manage/i);
  });

  test('buildEffectivePreviewText marks guidance as disabled when enabled is false', () => {
    const text = AgentGuidanceSettings.buildEffectivePreviewText({
      config: { ...DEFAULT_CONFIG, enabled: false },
      mcpTools: [],
    });
    expect(text).toMatch(/disabled/i);
  });

  test('per-tool notes only render for known MCP tools', () => {
    const text = AgentGuidanceSettings.buildEffectivePreviewText({
      config: {
        ...DEFAULT_CONFIG,
        per_tool_notes: {
          vibecode_workspace_info: 'KNOWN_NOTE',
          vibecode_unknown_tool: 'UNKNOWN_NOTE',
        },
      },
      mcpTools: [
        { name: 'vibecode_workspace_info', group: 'workspace_orientation', description: 'd' },
      ],
    });
    expect(text).toContain('KNOWN_NOTE');
    expect(text).not.toContain('UNKNOWN_NOTE');
  });
});

describe('agent guidance settings — status messages', () => {
  test('buildStatusMessage describes the loaded source for defaults', () => {
    const status = AgentGuidanceSettings.buildStatusMessage({
      ok: true,
      source: 'default',
      exists: false,
      configPath: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
    });
    expect(status.text.toLowerCase()).toMatch(/defaults/);
    expect(status.kind).toBe('info');
  });

  test('buildStatusMessage describes loaded-from-file', () => {
    const status = AgentGuidanceSettings.buildStatusMessage({
      ok: true,
      source: 'file',
      exists: true,
      configPath: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
    });
    expect(status.text.toLowerCase()).toMatch(/loaded from file/);
    expect(status.kind).toBe('info');
  });

  test('buildStatusMessage surfaces invalid config diagnostics without overwriting', () => {
    const status = AgentGuidanceSettings.buildStatusMessage({
      ok: false,
      source: 'default',
      exists: true,
      configPath: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
      error: { code: 'AGENT_GUIDANCE_CONFIG_PARSE_ERROR', message: 'bad yaml' },
    });
    expect(status.kind).toBe('error');
    expect(status.text).toContain('AGENT_GUIDANCE_CONFIG_PARSE_ERROR');
  });
});

describe('agent guidance settings — controller', () => {
  test('refresh loads the config, path, MCP tools and renders effective guidance', async () => {
    const view = makeView();
    const { api } = makeApi();
    const controller = AgentGuidanceSettings.createController({ api, view });

    await controller.refresh();

    expect(api.getAgentGuidanceConfig).toHaveBeenCalled();
    expect(api.getAgentGuidanceConfigPath).toHaveBeenCalled();
    expect(api.getAgentGuidanceMcpTools).toHaveBeenCalled();
    expect(view.setConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(view.setPath).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: expect.stringMatching(/agent-guidance-config\.yaml$/) }),
    );
    expect(view.setMcpTools).toHaveBeenCalled();
    const previewArg = view.setEffectiveGuidance.mock.calls[0][0] as { text: string };
    expect(previewArg.text).toMatch(/Status: enabled/);
  });

  test('save sends the updated config through the bridge', async () => {
    const view = makeView();
    const { api } = makeApi();
    const controller = AgentGuidanceSettings.createController({ api, view });
    await controller.refresh();
    await controller.save({
      ...DEFAULT_CONFIG,
      enabled: false,
      default_guidance: 'new guidance',
    });
    expect(api.setAgentGuidanceConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, default_guidance: 'new guidance' }),
    );
  });

  test('reset calls resetAgentGuidanceConfig and re-renders defaults', async () => {
    const view = makeView();
    const { api } = makeApi();
    const controller = AgentGuidanceSettings.createController({ api, view });
    await controller.refresh();
    await controller.reset();
    expect(api.resetAgentGuidanceConfig).toHaveBeenCalled();
    const lastConfigCall = view.setConfig.mock.calls[view.setConfig.mock.calls.length - 1][0];
    expect(lastConfigCall.enabled).toBe(true);
  });

  test('save surfaces a structured error and preserves previous config on failure', async () => {
    const view = makeView();
    const { api } = makeApi({
      setAgentGuidanceConfig: vi.fn(async () => ({
        ok: false,
        config: DEFAULT_CONFIG,
        configPath: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
        warnings: [],
        error: { code: 'AGENT_GUIDANCE_WRITE_FAILED', message: 'disk full', details: [] },
      })),
    });
    const controller = AgentGuidanceSettings.createController({ api, view });
    await controller.refresh();
    const before = view.setConfig.mock.calls.length;
    await controller.save({ ...DEFAULT_CONFIG, enabled: false });
    const statusCalls = view.setStatus.mock.calls;
    const lastStatus = statusCalls[statusCalls.length - 1][0];
    expect(lastStatus.kind).toBe('error');
    expect(lastStatus.text).toContain('AGENT_GUIDANCE_WRITE_FAILED');
    // Config should not have been re-rendered as the failed value.
    expect(view.setConfig.mock.calls.length).toBe(before);
  });
});
