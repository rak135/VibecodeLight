import fs from 'fs';
import os from 'os';
import path from 'path';

import { getAgentGuidanceConfigPath } from '../../../src/core/config/agent_guidance_config.js';
import {
  runTerminalAgentPreflight,
  type TerminalAgentPreflightApplyProvider,
  type TerminalAgentPreflightStatusProvider,
} from '../../../src/core/agent_guidance/terminal_agent_preflight.js';

function makeFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-preflight-repo-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-preflight-app-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-preflight-codex-'));
  const env: Record<string, string> = { LOCALAPPDATA: appData, CODEX_HOME: codexHome };
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  return {
    repoRoot,
    appData,
    codexHome,
    env,
    cleanup: () => {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(appData, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    },
  };
}

function writeGuidance(env: Record<string, string>, body: string): string {
  const configPath = getAgentGuidanceConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, body, 'utf8');
  return configPath;
}

function yaml(mode = 'check_only', claude = true, codex = true): string {
  return [
    'schema_version: 1',
    'enabled: true',
    'apply_to_terminal_agents: true',
    'scope: global',
    'default_guidance: "TEST_GUIDANCE_SHOULD_NOT_BE_IN_PREFLIGHT_RESULT"',
    'per_tool_notes: {}',
    'terminal_preflight:',
    '  enabled: true',
    `  mode: ${mode}`,
    '  supported_agents:',
    `    claude: ${claude}`,
    `    codex: ${codex}`,
    '  repair:',
    '    create_backup: true',
    '    require_valid_guidance_config: true',
    '',
  ].join('\n');
}

function statusProvider(statuses: Record<string, { configured: boolean; up_to_date: boolean }>): TerminalAgentPreflightStatusProvider {
  return vi.fn((options) => {
    const status = statuses[options.agent] ?? { configured: false, up_to_date: false };
    const mcpStatus: 'up_to_date' | 'stale' | 'not_configured' =
      status.up_to_date ? 'up_to_date' : status.configured ? 'stale' : 'not_configured';
    return {
      ok: true,
      agent: options.agent,
      repo_root: options.repoRoot,
      configured: status.configured,
      up_to_date: status.up_to_date,
      guidance: {
        config_valid: true,
        enabled: true,
        source: 'file',
        guidance_hash: 'a'.repeat(64),
        config_path: getAgentGuidanceConfigPath(options.env),
        warnings: [],
      },
      mcp: {
        expected_tool_count: 17,
        configured: status.configured,
        up_to_date: status.up_to_date,
        status: mcpStatus,
      },
      restart_required: true,
      warnings: [],
    };
  });
}

describe('Terminal Agent Preflight core service', () => {
  test('check_only reports status for supported agents and performs no writes', async () => {
    const f = makeFixture();
    try {
      writeGuidance(f.env, yaml('check_only'));
      const status = statusProvider({
        claude: { configured: false, up_to_date: false },
        codex: { configured: true, up_to_date: false },
      });
      const apply = vi.fn<TerminalAgentPreflightApplyProvider>();

      const result = await runTerminalAgentPreflight({
        repoRoot: f.repoRoot,
        env: f.env,
        statusProvider: status,
        applyProvider: apply,
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('check_only');
      expect(result.guidance_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.no_pty_injection).toBe(true);
      expect(result.agents.map((a) => a.agent).sort()).toEqual(['claude', 'codex']);
      expect(result.agents.find((a) => a.agent === 'codex')).toMatchObject({
        configured: true,
        stale: true,
        repaired: false,
      });
      expect(apply).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(f.codexHome, 'config.toml'))).toBe(false);
      expect(JSON.stringify(result)).not.toContain('TEST_GUIDANCE_SHOULD_NOT_BE_IN_PREFLIGHT_RESULT');
    } finally {
      f.cleanup();
    }
  });

  test('auto_repair invokes safe apply for enabled agents only', async () => {
    const f = makeFixture();
    try {
      writeGuidance(f.env, yaml('auto_repair', false, true));
      const status = statusProvider({
        claude: { configured: false, up_to_date: false },
        codex: { configured: false, up_to_date: false },
      });
      const apply = vi.fn<TerminalAgentPreflightApplyProvider>(() => ({
        ok: true,
        agent: 'codex',
        repo_root: f.repoRoot,
        dry_run: false,
        guidance_hash: 'a'.repeat(64),
        guidance_config_path: getAgentGuidanceConfigPath(f.env),
        planned_action: 'Update Codex VibecodeMCP config',
        warnings: [],
        restart_required: true,
      }));

      const result = await runTerminalAgentPreflight({
        repoRoot: f.repoRoot,
        env: f.env,
        statusProvider: status,
        applyProvider: apply,
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('auto_repair');
      expect(status).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls[0][0]).toMatchObject({ agent: 'codex', repoRoot: f.repoRoot, yes: true });
      expect(result.agents).toEqual([
        expect.objectContaining({ agent: 'codex', repaired: true }),
      ]);
    } finally {
      f.cleanup();
    }
  });

  test('disabled preflight returns a skipped status', async () => {
    const f = makeFixture();
    try {
      writeGuidance(f.env, yaml('check_only').replace('  enabled: true', '  enabled: false'));
      const result = await runTerminalAgentPreflight({
        repoRoot: f.repoRoot,
        env: f.env,
        statusProvider: statusProvider({}),
        applyProvider: vi.fn(),
      });
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.agents).toEqual([]);
      expect(result.no_pty_injection).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test('invalid guidance config warns and does not auto repair', async () => {
    const f = makeFixture();
    try {
      writeGuidance(f.env, ': not valid yaml: : :::\n');
      const apply = vi.fn<TerminalAgentPreflightApplyProvider>();
      const result = await runTerminalAgentPreflight({
        repoRoot: f.repoRoot,
        env: f.env,
        modeOverride: 'auto_repair',
        statusProvider: statusProvider({ codex: { configured: false, up_to_date: false } }),
        applyProvider: apply,
      });
      expect(result.ok).toBe(false);
      expect(result.warnings.join('\n')).toMatch(/AGENT_GUIDANCE_CONFIG_PARSE_ERROR|invalid/i);
      expect(result.errors.join('\n')).toMatch(/auto repair/i);
      expect(apply).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  test('root config.yaml, .vibecode/config.yaml, AGENTS.md, and CLAUDE.md are not used or written', async () => {
    const f = makeFixture();
    try {
      fs.writeFileSync(path.join(f.repoRoot, 'config.yaml'), 'terminal_preflight:\n  mode: auto_repair\n', 'utf8');
      fs.mkdirSync(path.join(f.repoRoot, '.vibecode'), { recursive: true });
      fs.writeFileSync(path.join(f.repoRoot, '.vibecode', 'config.yaml'), 'terminal_preflight:\n  mode: auto_repair\n', 'utf8');
      const status = statusProvider({ codex: { configured: false, up_to_date: false } });
      const apply = vi.fn<TerminalAgentPreflightApplyProvider>();

      const result = await runTerminalAgentPreflight({
        repoRoot: f.repoRoot,
        env: f.env,
        statusProvider: status,
        applyProvider: apply,
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('check_only');
      expect(result.config_path).toBe(getAgentGuidanceConfigPath(f.env));
      expect(apply).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(f.repoRoot, 'AGENTS.md'))).toBe(false);
      expect(fs.existsSync(path.join(f.repoRoot, 'CLAUDE.md'))).toBe(false);
      expect(fs.readFileSync(path.join(f.repoRoot, 'config.yaml'), 'utf8')).toContain('auto_repair');
      expect(fs.readFileSync(path.join(f.repoRoot, '.vibecode', 'config.yaml'), 'utf8')).toContain('auto_repair');
    } finally {
      f.cleanup();
    }
  });
});
