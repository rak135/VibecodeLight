import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerDesktopMcpIpcHandlers } from '../../../src/app/desktop/mcp_bridge.js';

interface Handler {
  (event: unknown, ...args: unknown[]): unknown;
}

class FakeIpcMain {
  handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler) {
    this.handlers.set(channel, listener);
  }
  invoke(channel: string, ...args: unknown[]) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  }
}

describe('desktop MCP bridge', () => {
  let repoRoot: string;
  let appData: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-bridge-repo-'));
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-bridge-appdata-'));
    process.env.LOCALAPPDATA = appData;
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(appData, { recursive: true, force: true });
  });

  function register() {
    const ipc = new FakeIpcMain();
    registerDesktopMcpIpcHandlers(ipc, { getRepoPath: () => repoRoot });
    return ipc;
  }

  test('mcp:getOverview returns all three agents and repo metadata', async () => {
    const ipc = register();
    const result = (await ipc.invoke('mcp:getOverview')) as {
      ok: boolean;
      repo_root: string;
      server_name: string;
      tools_count: number;
      tools: string[];
      agents: Array<{ agent: string; status: string; warnings: string[] }>;
    };

    expect(result.ok).toBe(true);
    expect(result.repo_root).toBe(repoRoot);
    expect(result.server_name).toBe('vibecode');
    expect(result.tools_count).toBeGreaterThan(0);
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.agents.map((a) => a.agent).sort()).toEqual(['claude', 'codex', 'opencode']);
  });

  test('mcp:doctor returns structured status for each agent', async () => {
    const ipc = register();
    const claude = (await ipc.invoke('mcp:doctor', 'claude')) as { ok: boolean; agent: string };
    const codex = (await ipc.invoke('mcp:doctor', 'codex')) as { ok: boolean; agent: string };
    const opencode = (await ipc.invoke('mcp:doctor', 'opencode')) as { ok: boolean; agent: string };
    const invalid = (await ipc.invoke('mcp:doctor', 'cursor')) as { ok: boolean; error?: { code: string } };

    expect(claude.ok).toBe(true);
    expect(claude.agent).toBe('claude');
    expect(codex.ok).toBe(true);
    expect(codex.agent).toBe('codex');
    expect(opencode.ok).toBe(true);
    expect(opencode.agent).toBe('opencode');
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe('INVALID_AGENT');
  });

  test('mcp:installDryRun is read-only and does not write config', async () => {
    const ipc = register();
    const result = (await ipc.invoke('mcp:installDryRun', 'codex')) as {
      ok: boolean;
      dry_run: boolean;
      agent: string;
    };

    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.agent).toBe('codex');
    expect(fs.existsSync(path.join(repoRoot, 'config.toml'))).toBe(false);
  });

  test('mcp:install requires explicit confirmation', async () => {
    const ipc = register();
    const refused = (await ipc.invoke('mcp:install', 'codex', false)) as {
      ok: boolean;
      error?: { code: string; message: string };
    };

    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(fs.existsSync(path.join(repoRoot, 'config.toml'))).toBe(false);
  });

  test('mcp:getTools returns the canonical tool list', async () => {
    const ipc = register();
    const result = (await ipc.invoke('mcp:getTools')) as {
      ok: boolean;
      tools: Array<{ name: string; group: string; description: string }>;
    };

    expect(result.ok).toBe(true);
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools[0].name).toMatch(/^vibecode_/);
  });

  test('mcp:getToolCatalog returns registry-derived catalog detail', async () => {
    const ipc = register();
    const result = (await ipc.invoke('mcp:getToolCatalog')) as {
      tool_count: number;
      generated_from: { registry: boolean; schemas: boolean; profiles: boolean };
      tools: Array<{ name: string; input_schema: unknown; output_contract: { summary: string } }>;
    };

    expect(result.generated_from).toEqual({ registry: true, schemas: true, profiles: true });
    expect(result.tool_count).toBe(result.tools.length);
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools[0].input_schema).toBeTruthy();
    expect(result.tools[0].output_contract.summary.length).toBeGreaterThan(0);
  });

  test('mcp:getToolDetail returns one tool and safely returns null for invalid names', async () => {
    const ipc = register();
    const known = (await ipc.invoke('mcp:getToolDetail', 'vibecode_session_bootstrap')) as {
      name: string;
      output_contract: { summary: string };
    } | null;
    const missing = (await ipc.invoke('mcp:getToolDetail', 'vibecode_commit_guard')) as unknown;
    const invalid = (await ipc.invoke('mcp:getToolDetail', 42)) as unknown;

    expect(known?.name).toBe('vibecode_session_bootstrap');
    expect(known?.output_contract.summary).toMatch(/repo|session|runtime|recovery/i);
    expect(missing).toBeNull();
    expect(invalid).toBeNull();
  });

  test('mcp:install supports OpenCode', async () => {
    const ipc = register();
    const dryRun = (await ipc.invoke('mcp:installDryRun', 'opencode')) as {
      ok: boolean;
      dry_run: boolean;
      agent: string;
    };

    expect(dryRun.ok).toBe(true);
    expect(dryRun.agent).toBe('opencode');
  });

  test('mcp bridge exposes no terminal write or arbitrary path input', async () => {
    const ipc = register();
    expect(ipc.handlers.has('terminal:input')).toBe(false);
    expect(ipc.handlers.has('mcp:writeArbitraryPath')).toBe(false);
    expect(ipc.handlers.has('mcp:runTool')).toBe(false);
    expect(ipc.handlers.has('mcp:executeTool')).toBe(false);
  });
});
