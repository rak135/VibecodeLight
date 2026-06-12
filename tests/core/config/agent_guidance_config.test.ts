import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';

import {
  AGENT_GUIDANCE_CONFIG_FILENAME,
  AGENT_GUIDANCE_SCHEMA_VERSION,
  buildEffectiveAgentGuidance,
  defaultAgentGuidanceConfig,
  getAgentGuidanceConfigPath,
  readAgentGuidanceConfig,
  resetAgentGuidanceConfig,
  writeAgentGuidanceConfig,
  type AgentGuidanceConfig,
} from '../../../src/core/config/agent_guidance_config.js';

describe('agent guidance config — path resolution', () => {
  test('AGENT_GUIDANCE_CONFIG_FILENAME is the dedicated file (not the root or .vibecode config)', () => {
    expect(AGENT_GUIDANCE_CONFIG_FILENAME).toBe('agent-guidance-config.yaml');
  });

  test('getAgentGuidanceConfigPath lives under LOCALAPPDATA/vibecodelight/', () => {
    const resolved = getAgentGuidanceConfigPath({ LOCALAPPDATA: 'D:\\Custom\\Local' });
    expect(resolved).toBe(
      path.join('D:\\Custom\\Local', 'vibecodelight', 'agent-guidance-config.yaml'),
    );
  });

  test('falls back to homedir/AppData/Local when LOCALAPPDATA is missing', () => {
    const resolved = getAgentGuidanceConfigPath({});
    expect(resolved).toBe(
      path.join(os.homedir(), 'AppData', 'Local', 'vibecodelight', 'agent-guidance-config.yaml'),
    );
  });

  test('config path never points to the root config.yaml or .vibecode/config.yaml', () => {
    const resolved = getAgentGuidanceConfigPath({ LOCALAPPDATA: 'D:\\Custom\\Local' });
    expect(path.basename(resolved)).toBe(AGENT_GUIDANCE_CONFIG_FILENAME);
    expect(path.basename(resolved)).not.toBe('config.yaml');
    expect(resolved.endsWith(path.join('.vibecode', 'config.yaml'))).toBe(false);
    expect(resolved.endsWith(path.join('vibecodelight', 'config.yaml'))).toBe(false);
  });
});

describe('agent guidance config — defaults', () => {
  test('defaultAgentGuidanceConfig has schema_version 1 and is enabled', () => {
    const defaults = defaultAgentGuidanceConfig();
    expect(defaults.schema_version).toBe(AGENT_GUIDANCE_SCHEMA_VERSION);
    expect(AGENT_GUIDANCE_SCHEMA_VERSION).toBe(1);
    expect(defaults.enabled).toBe(true);
    expect(defaults.apply_to_terminal_agents).toBe(true);
    expect(defaults.scope).toBe('global');
  });

  test('default_guidance mentions VibecodeMCP, workspace tools, CodeGraph, runs, fallback, and approval boundary', () => {
    const defaults = defaultAgentGuidanceConfig();
    expect(defaults.default_guidance).toMatch(/VibecodeMCP/);
    expect(defaults.default_guidance).toMatch(/vibecode_session_start/);
    expect(defaults.default_guidance).toMatch(/vibecode_workspace_snapshot/);
    expect(defaults.default_guidance).toMatch(/CodeGraph/);
    expect(defaults.default_guidance).toMatch(/run/i);
    expect(defaults.default_guidance).toMatch(/rg|grep/);
    expect(defaults.default_guidance).toMatch(/Vibecode CLI/);
    expect(defaults.default_guidance).toMatch(/approval/i);
  });

  test('per_tool_notes is a record with notes for key VibecodeMCP tools', () => {
    const defaults = defaultAgentGuidanceConfig();
    expect(defaults.per_tool_notes).toBeTruthy();
    expect(typeof defaults.per_tool_notes.vibecode_session_start).toBe('string');
    expect(typeof defaults.per_tool_notes.vibecode_workspace_snapshot).toBe('string');
    expect(typeof defaults.per_tool_notes.vibecode_codegraph_search).toBe('string');
    expect(typeof defaults.per_tool_notes.vibecode_artifact_read).toBe('string');
  });

  test('defaults never contain environment variable values', () => {
    const defaults = defaultAgentGuidanceConfig();
    const serialized = JSON.stringify(defaults);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(serialized).not.toMatch(/_API_KEY=/);
  });
});

describe('agent guidance config — read', () => {
  let appData: string;

  beforeEach(() => {
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-agc-read-'));
  });

  afterEach(() => {
    fs.rmSync(appData, { recursive: true, force: true });
  });

  function envOf() {
    return { LOCALAPPDATA: appData };
  }

  test('missing file returns defaults with source=default', () => {
    const result = readAgentGuidanceConfig({ env: envOf() });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('default');
    expect(result.config.enabled).toBe(defaultAgentGuidanceConfig().enabled);
    expect(result.config.default_guidance).toBe(defaultAgentGuidanceConfig().default_guidance);
    expect(result.configPath).toBe(getAgentGuidanceConfigPath(envOf()));
    expect(result.exists).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  test('valid YAML file is parsed and merged over defaults', () => {
    const configPath = getAgentGuidanceConfigPath(envOf());
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const userYaml = [
      'schema_version: 1',
      'enabled: false',
      'apply_to_terminal_agents: false',
      'scope: "global"',
      'default_guidance: |',
      '  Custom guidance for this user.',
      'per_tool_notes:',
      '  vibecode_workspace_info: "Custom note for workspace_info."',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, userYaml, 'utf8');

    const result = readAgentGuidanceConfig({ env: envOf() });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('file');
    expect(result.exists).toBe(true);
    expect(result.config.enabled).toBe(false);
    expect(result.config.apply_to_terminal_agents).toBe(false);
    expect(result.config.default_guidance).toContain('Custom guidance for this user.');
    expect(result.config.per_tool_notes.vibecode_workspace_info).toContain('Custom note for workspace_info.');
  });

  test('invalid YAML returns structured error and does not overwrite the file', () => {
    const configPath = getAgentGuidanceConfigPath(envOf());
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const garbage = ': not valid yaml: : :::\n';
    fs.writeFileSync(configPath, garbage, 'utf8');

    const result = readAgentGuidanceConfig({ env: envOf() });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error?.code).toBe('AGENT_GUIDANCE_CONFIG_PARSE_ERROR');
    expect(typeof result.error?.message).toBe('string');
    // Defaults still returned so renderers can show *something* safe.
    expect(result.config.enabled).toBe(defaultAgentGuidanceConfig().enabled);
    // File is preserved untouched for the user to inspect / fix manually.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(garbage);
  });

  test('invalid schema_version is reported as a warning and defaults are used for that field', () => {
    const configPath = getAgentGuidanceConfigPath(envOf());
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      ['schema_version: 999', 'enabled: true', 'default_guidance: "stub"', ''].join('\n'),
      'utf8',
    );
    const result = readAgentGuidanceConfig({ env: envOf() });
    expect(result.ok).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/schema_version/);
    expect(result.config.schema_version).toBe(AGENT_GUIDANCE_SCHEMA_VERSION);
  });
});

describe('agent guidance config — write/reset', () => {
  let appData: string;

  beforeEach(() => {
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-agc-write-'));
  });

  afterEach(() => {
    fs.rmSync(appData, { recursive: true, force: true });
  });

  function envOf() {
    return { LOCALAPPDATA: appData };
  }

  test('writeAgentGuidanceConfig persists YAML at the dedicated path', () => {
    const next: AgentGuidanceConfig = {
      ...defaultAgentGuidanceConfig(),
      enabled: false,
      default_guidance: 'Hello custom guidance.',
      per_tool_notes: { vibecode_workspace_info: 'Custom note' },
    };
    const result = writeAgentGuidanceConfig({ env: envOf(), config: next });
    expect(result.ok).toBe(true);
    expect(result.configPath).toBe(getAgentGuidanceConfigPath(envOf()));
    expect(fs.existsSync(result.configPath)).toBe(true);
    const parsed = YAML.parse(fs.readFileSync(result.configPath, 'utf8'));
    expect(parsed.schema_version).toBe(AGENT_GUIDANCE_SCHEMA_VERSION);
    expect(parsed.enabled).toBe(false);
    expect(parsed.default_guidance).toContain('Hello custom guidance.');
    expect(parsed.per_tool_notes.vibecode_workspace_info).toBe('Custom note');
  });

  test('roundtrip preserves per_tool_notes', () => {
    const notes = {
      vibecode_workspace_info: 'note A',
      vibecode_codegraph_search: 'note B',
      vibecode_artifact_read: 'note C',
    };
    writeAgentGuidanceConfig({
      env: envOf(),
      config: { ...defaultAgentGuidanceConfig(), per_tool_notes: notes },
    });
    const re = readAgentGuidanceConfig({ env: envOf() });
    expect(re.ok).toBe(true);
    expect(re.config.per_tool_notes).toEqual(notes);
  });

  test('resetAgentGuidanceConfig restores defaults and rewrites the file', () => {
    writeAgentGuidanceConfig({
      env: envOf(),
      config: { ...defaultAgentGuidanceConfig(), enabled: false, default_guidance: 'custom' },
    });
    const reset = resetAgentGuidanceConfig({ env: envOf() });
    expect(reset.ok).toBe(true);
    expect(reset.config.enabled).toBe(defaultAgentGuidanceConfig().enabled);
    expect(reset.config.default_guidance).toBe(defaultAgentGuidanceConfig().default_guidance);
    const re = readAgentGuidanceConfig({ env: envOf() });
    expect(re.config.enabled).toBe(defaultAgentGuidanceConfig().enabled);
    expect(re.config.default_guidance).toBe(defaultAgentGuidanceConfig().default_guidance);
  });

  test('agent guidance file is isolated from root config.yaml and .vibecode/config.yaml', () => {
    // Pre-populate a root-style and a .vibecode-style YAML in the appdata dir.
    const profileDir = path.join(appData, 'vibecodelight');
    fs.mkdirSync(profileDir, { recursive: true });
    const rootConfig = path.join(profileDir, 'config.yaml');
    fs.writeFileSync(rootConfig, 'version: 1\nproviders: {}\n', 'utf8');
    writeAgentGuidanceConfig({
      env: envOf(),
      config: { ...defaultAgentGuidanceConfig(), enabled: false },
    });
    // The dedicated file exists and is separate from config.yaml.
    expect(fs.existsSync(getAgentGuidanceConfigPath(envOf()))).toBe(true);
    expect(fs.readFileSync(rootConfig, 'utf8')).toBe('version: 1\nproviders: {}\n');
  });
});

describe('agent guidance config — effective guidance preview', () => {
  test('disabled config produces an effective preview marked as disabled and no instruction block', () => {
    const config: AgentGuidanceConfig = { ...defaultAgentGuidanceConfig(), enabled: false };
    const effective = buildEffectiveAgentGuidance({
      config,
      mcpTools: [
        { name: 'vibecode_workspace_info', group: 'workspace_orientation', description: 'desc' },
      ],
    });
    expect(effective.enabled).toBe(false);
    expect(effective.text).toMatch(/Agent guidance is disabled/i);
    expect(effective.toolNotes).toEqual([]);
  });

  test('enabled config produces a preview containing the guidance and per-tool notes for known tools', () => {
    const config: AgentGuidanceConfig = {
      ...defaultAgentGuidanceConfig(),
      per_tool_notes: {
        vibecode_workspace_info: 'CUSTOM_NOTE_WORKSPACE_INFO',
        vibecode_codegraph_search: 'CUSTOM_NOTE_CG_SEARCH',
        unknown_tool: 'IGNORED_FOR_UNKNOWN_TOOLS',
      },
    };
    const effective = buildEffectiveAgentGuidance({
      config,
      mcpTools: [
        { name: 'vibecode_workspace_info', group: 'workspace_orientation', description: 'd1' },
        { name: 'vibecode_codegraph_search', group: 'codegraph', description: 'd2' },
      ],
    });
    expect(effective.enabled).toBe(true);
    expect(effective.text).toContain(config.default_guidance.trim().split('\n')[0]);
    expect(effective.text).toContain('CUSTOM_NOTE_WORKSPACE_INFO');
    expect(effective.text).toContain('CUSTOM_NOTE_CG_SEARCH');
    expect(effective.text).not.toContain('IGNORED_FOR_UNKNOWN_TOOLS');
    // Approval boundary must always be present so the preview never claims agent
    // approvals are managed.
    expect(effective.text).toMatch(/Vibecode does not manage.*approval/i);
    // Fallback statement must always be present.
    expect(effective.text).toMatch(/Vibecode CLI/);
  });

  test('preview text never claims guidance has been applied to a real agent', () => {
    const effective = buildEffectiveAgentGuidance({
      config: defaultAgentGuidanceConfig(),
      mcpTools: [],
    });
    expect(effective.text.toLowerCase()).not.toMatch(/installed into claude/);
    expect(effective.text.toLowerCase()).not.toMatch(/applied to codex/);
    expect(effective.text.toLowerCase()).not.toMatch(/written to claude\.md/);
  });
});
