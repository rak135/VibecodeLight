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
  terminal_preflight: {
    enabled: true,
    mode: 'check_only',
    supported_agents: { codex: true, claude: true },
    repair: { create_backup: true, require_valid_guidance_config: true },
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
    getAgentGuidanceRuntimeStatus: vi.fn(async () => ({
      ok: true,
      enabled: true,
      source: 'defaults' as const,
      guidance_hash: 'a'.repeat(64),
      config_path: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
      expected_tool_count: 17,
      warnings: [],
    })),
    getAgentGuidanceIntegrationStatus: vi.fn(async (agent: 'claude' | 'codex') => ({
      ok: true,
      agent,
      configured: false,
      up_to_date: false,
      guidance: {
        config_valid: true,
        enabled: true,
        source: 'defaults',
        guidance_hash: 'a'.repeat(64),
        config_path: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
        warnings: [],
      },
      mcp: { expected_tool_count: 17, configured: false, up_to_date: false, status: 'not_configured' },
      restart_required: true,
      warnings: [],
    })),
    getAgentGuidanceTerminalPreflightConfig: vi.fn(async () => ({
      ok: true,
      terminal_preflight: structuredClone(DEFAULT_CONFIG.terminal_preflight),
      configPath: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
      guidance_hash: 'a'.repeat(64),
      last_result: {
        checked_at: '2026-06-06T12:00:00.000Z',
        guidance_hash: 'a'.repeat(64),
        agents: [
          { agent: 'codex', configured: true, stale: false, repaired: false },
          { agent: 'claude', configured: false, stale: false, repaired: false },
        ],
      },
      warnings: [],
    })),
    setAgentGuidanceTerminalPreflightConfig: vi.fn(async (terminalPreflight: AgentGuidanceConfigView['terminal_preflight']) => ({
      ok: true,
      terminal_preflight: terminalPreflight,
      configPath: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
      guidance_hash: 'a'.repeat(64),
      warnings: [],
    })),
    dryRunAgentGuidanceIntegration: vi.fn(async (agent: 'claude' | 'codex') => ({
      ok: true,
      agent,
      dry_run: true,
      guidance_hash: 'a'.repeat(64),
      planned_action: agent + ' mcp install dry-run',
      warnings: [],
      restart_required: true,
    })),
    applyAgentGuidanceIntegration: vi.fn(async (agent: 'claude' | 'codex', confirmed: boolean) => ({
      ok: confirmed,
      agent,
      dry_run: false,
      guidance_hash: 'a'.repeat(64),
      planned_action: agent + ' mcp install',
      warnings: [],
      restart_required: true,
      error: confirmed ? undefined : { code: 'CONFIRMATION_REQUIRED', message: 'confirmation required' },
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
  setIntegrationStatus: ReturnType<typeof vi.fn>;
  setIntegrationPlan: ReturnType<typeof vi.fn>;
}

function makeView(): ViewSpy {
  return {
    setConfig: vi.fn(),
    setPath: vi.fn(),
    setStatus: vi.fn(),
    setMcpTools: vi.fn(),
    setEffectiveGuidance: vi.fn(),
    setIntegrationStatus: vi.fn(),
    setIntegrationPlan: vi.fn(),
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

  test('buildTerminalPreflightView renders section controls, safe copy, and status rows', () => {
    const view = AgentGuidanceSettings.buildTerminalPreflightView({
      terminal_preflight: DEFAULT_CONFIG.terminal_preflight,
      last_result: {
        checked_at: '2026-06-06T12:00:00.000Z',
        guidance_hash: 'b'.repeat(64),
        agents: [
          { agent: 'codex', configured: true, stale: false, repaired: false },
          { agent: 'claude', configured: false, stale: true, repaired: false },
        ],
      },
    });

    expect(view.title).toBe('Terminal Agent Preflight');
    expect(view.copy).toMatch(/opening new Vibecode terminals/i);
    expect(view.copy).toMatch(/does not start agents/i);
    expect(view.copy).toMatch(/does not send text into the terminal/i);
    expect(view.modeOptions.map((o: { value: string }) => o.value)).toEqual(['check_only', 'auto_repair']);
    expect(view.agentToggles).toEqual([
      { agent: 'codex', enabled: true },
      { agent: 'claude', enabled: true },
    ]);
    expect(view.statusRows.map((r: { label: string }) => r.label)).toEqual([
      'last checked at',
      'guidance hash',
      'Codex',
      'Claude',
    ]);
    expect(JSON.stringify(view)).not.toMatch(/Start Codex|Start Claude/);
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
    expect(api.getAgentGuidanceRuntimeStatus).toHaveBeenCalled();
    expect(api.getAgentGuidanceTerminalPreflightConfig).toHaveBeenCalled();
    expect(api.getAgentGuidanceIntegrationStatus).toHaveBeenCalledWith('claude');
    expect(api.getAgentGuidanceIntegrationStatus).toHaveBeenCalledWith('codex');
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

  test('save sends terminal preflight settings through the dedicated bridge method', async () => {
    const view = makeView();
    const { api } = makeApi();
    const controller = AgentGuidanceSettings.createController({ api, view });
    await controller.refresh();
    await controller.save({
      ...DEFAULT_CONFIG,
      terminal_preflight: {
        enabled: true,
        mode: 'auto_repair',
        supported_agents: { codex: true, claude: false },
        repair: { create_backup: false, require_valid_guidance_config: true },
      },
    });
    expect(api.setAgentGuidanceTerminalPreflightConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        mode: 'auto_repair',
        supported_agents: { codex: true, claude: false },
      }),
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

  test('Agent Integrations status renders Claude and Codex rows with hash and restart notice', async () => {
    const view = makeView();
    const { api } = makeApi();
    const controller = AgentGuidanceSettings.createController({ api, view });
    await controller.refresh();
    expect(view.setIntegrationStatus).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        text: expect.stringMatching(/restart|reconnect/i),
        hash: 'a'.repeat(64),
        expectedToolCount: 17,
      }),
    );
    expect(view.setIntegrationStatus).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        text: expect.stringMatching(/restart|reconnect/i),
        hash: 'a'.repeat(64),
        expectedToolCount: 17,
      }),
    );
  });

  test('Claude integration row displays the detected project-scoped MCP config source', async () => {
    const view = makeView();
    const { api } = makeApi({
      getAgentGuidanceIntegrationStatus: vi.fn(async (agent: 'claude' | 'codex') => ({
        ok: true,
        agent,
        configured: true,
        up_to_date: true,
        guidance: {
          config_valid: true,
          enabled: true,
          source: 'defaults',
          guidance_hash: 'a'.repeat(64),
          config_path: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
          warnings: [],
        },
        mcp: {
          expected_tool_count: 17,
          configured: true,
          up_to_date: true,
          status: 'up_to_date',
          source: agent === 'claude' ? 'local' : undefined,
          source_path: agent === 'claude' ? 'C:/Users/dev/.claude.json' : undefined,
        },
        restart_required: true,
        warnings: [],
      })),
    });
    const controller = AgentGuidanceSettings.createController({ api, view });
    await controller.refresh();
    expect(view.setIntegrationStatus).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        text: expect.stringMatching(/MCP config source=local/),
        mcpSource: 'local',
      }),
    );
  });

  test('dry-run apply displays planned action and apply requires confirmation', async () => {
    const view = makeView();
    const { api } = makeApi();
    const controller = AgentGuidanceSettings.createController({ api, view });
    await controller.refresh();
    await controller.dryRunApply('claude');
    expect(api.dryRunAgentGuidanceIntegration).toHaveBeenCalledWith('claude');
    expect(view.setIntegrationPlan).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ text: expect.stringMatching(/dry-run/i), hash: 'a'.repeat(64) }),
    );

    await controller.apply('codex', false);
    expect(api.applyAgentGuidanceIntegration).not.toHaveBeenCalled();
    expect(view.setIntegrationStatus).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ kind: 'error', text: expect.stringMatching(/confirmation/i) }),
    );
  });

  test('confirmed apply calls bridge and never exposes terminal injection path', async () => {
    const view = makeView();
    const { api } = makeApi();
    const controller = AgentGuidanceSettings.createController({ api, view });
    await controller.apply('codex', true);
    expect(api.applyAgentGuidanceIntegration).toHaveBeenCalledWith('codex', true);
    expect(Object.keys(api).join('\n')).not.toMatch(/pty|stdin|prompt|writeTerminal|startCodex|startClaude/i);
  });

  test('Terminal Agent Preflight copy states no agent launcher and no PTY injection', () => {
    expect(AgentGuidanceSettings.TERMINAL_PREFLIGHT_COPY).toMatch(/does not start agents/i);
    expect(AgentGuidanceSettings.TERMINAL_PREFLIGHT_COPY).toMatch(/does not send text into the terminal/i);
    expect(AgentGuidanceSettings.TERMINAL_PREFLIGHT_COPY).not.toMatch(/Start Codex button|Start Claude button/i);
  });
});
