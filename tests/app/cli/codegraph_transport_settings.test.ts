import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import YAML from 'yaml';
import { afterEach, describe, expect, test } from 'vitest';

import { runContextBuild, runPromptCommand } from '../../../src/app/cli/index.js';
import type { CodeGraphContextRunner, CodeGraphReadinessProvider } from '../../../src/adapters/codegraph/codegraph_context.js';
import type { CodeGraphMcpContextRunner } from '../../../src/adapters/codegraph/codegraph_mcp.js';
import { MockFlashAdapter } from '../../../src/adapters/llm/mock_flash.js';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-transport-settings-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const main = () => 1;\n', 'utf8');
  return repo;
}

function makeAppData(initialConfig?: unknown): string {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-transport-appdata-'));
  const dir = path.join(appData, 'vibecodelight');
  fs.mkdirSync(dir, { recursive: true });
  if (initialConfig !== undefined) {
    fs.writeFileSync(path.join(dir, 'config.yaml'), YAML.stringify(initialConfig), 'utf8');
  }
  return appData;
}

function runCli(args: string[], cwd: string, localAppData: string) {
  const env = { ...process.env, LOCALAPPDATA: localAppData };
  return spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: 'utf8', timeout: 60000, env });
}

function readUsage(runDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'scan', 'codegraph_usage.json'), 'utf8')) as Record<string, unknown>;
}

const readyProvider: CodeGraphReadinessProvider = async () => ({
  ok: true,
  available: true,
  initialized: true,
  version: 'codegraph-test 1.0.0',
  warnings: [],
});

const cliSuccessRunner: CodeGraphContextRunner = (_command, args) => {
  if (args[0] === 'status') {
    return { ok: true, stdout: JSON.stringify({ pendingChanges: { added: 0, modified: 0, removed: 0 } }), stderr: '', exitCode: 0 };
  }
  if (args[0] === 'context') {
    return { ok: true, stdout: '### CLI Context\n- src/index.ts\n', stderr: '', exitCode: 0 };
  }
  return { ok: false, stdout: '', stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
};

function mcpSuccessRunner(text = '### MCP Context\n- src/index.ts\n'): CodeGraphMcpContextRunner {
  return async () => ({ ok: true, text });
}

describe('vibecode codegraph transport settings CLI', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length) {
      fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
    }
    process.exitCode = 0;
  });

  test('get --json defaults to cli without creating repo state or starting CodeGraph', () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData();
    cleanup.push(tmpRepo, appData);
    const repoFilesBefore = fs.readdirSync(tmpRepo).sort();

    const result = runCli(['codegraph', 'transport', 'get', '--json'], tmpRepo, appData);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload).toMatchObject({
      ok: true,
      data: {
        transport: 'cli',
        default: 'cli',
        source: 'default',
        global_config_exists: false,
      },
      artifacts: [],
      warnings: [],
    });
    expect(fs.readdirSync(tmpRepo).sort()).toEqual(repoFilesBefore);
    expect(fs.existsSync(path.join(appData, 'vibecodelight', 'config.yaml'))).toBe(false);
  });

  test('set mcp/auto persists to the global user config and get reports stable JSON shape', () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData({ version: 1, providers: {}, defaults: { flash: {} } });
    cleanup.push(tmpRepo, appData);

    const mcpResult = runCli(['codegraph', 'transport', 'set', 'mcp', '--json'], tmpRepo, appData);
    expect(mcpResult.status).toBe(0);
    const mcpPayload = JSON.parse(mcpResult.stdout.trim());
    expect(mcpPayload.ok).toBe(true);
    expect(mcpPayload.data.transport).toBe('mcp');
    expect(mcpPayload.artifacts).toEqual([path.join(appData, 'vibecodelight', 'config.yaml')]);

    const getMcp = runCli(['codegraph', 'transport', 'get', '--json'], tmpRepo, appData);
    expect(getMcp.status).toBe(0);
    expect(JSON.parse(getMcp.stdout.trim()).data.transport).toBe('mcp');

    const autoResult = runCli(['codegraph', 'transport', 'set', 'auto', '--json'], tmpRepo, appData);
    expect(autoResult.status).toBe(0);
    expect(JSON.parse(autoResult.stdout.trim()).data.transport).toBe('auto');

    const saved = YAML.parse(fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ defaults: { codegraph: { transport: 'auto' } } });
  });

  test('invalid set fails with structured diagnostic and does not write transport', () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData();
    cleanup.push(tmpRepo, appData);

    const result = runCli(['codegraph', 'transport', 'set', 'socket', '--json'], tmpRepo, appData);

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('INVALID_CODEGRAPH_TRANSPORT');
    expect(payload.error.details).toContain('Expected one of: cli, mcp, auto.');
    expect(fs.existsSync(path.join(appData, 'vibecodelight', 'config.yaml'))).toBe(false);
  });

  test('reset removes the persisted transport and returns to cli', () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData({ version: 1, defaults: { codegraph: { transport: 'mcp' }, flash: {} }, providers: {} });
    cleanup.push(tmpRepo, appData);

    const reset = runCli(['codegraph', 'transport', 'reset', '--json'], tmpRepo, appData);
    expect(reset.status).toBe(0);
    expect(JSON.parse(reset.stdout.trim()).data.transport).toBe('cli');

    const get = runCli(['codegraph', 'transport', 'get', '--json'], tmpRepo, appData);
    expect(JSON.parse(get.stdout.trim()).data).toMatchObject({ transport: 'cli', source: 'default' });
  });
});

describe('CLI prompt/context-build consume persisted CodeGraph transport', () => {
  const cleanup: string[] = [];
  const originalLocalAppData = process.env.LOCALAPPDATA;

  afterEach(() => {
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    while (cleanup.length) {
      fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
    }
    process.exitCode = 0;
  });

  test('context-build use-existing uses persisted mcp when no direct override exists', async () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData({ version: 1, defaults: { codegraph: { transport: 'mcp' }, flash: {} }, providers: {} });
    cleanup.push(tmpRepo, appData);
    process.env.LOCALAPPDATA = appData;

    let mcpCalls = 0;
    const result = await runContextBuild({
      task: 'persisted mcp',
      repoRoot: tmpRepo,
      codegraphMode: 'use-existing',
      codegraphRunner: () => { throw new Error('CLI runner should not be called in persisted mcp mode'); },
      codegraphMcpRunner: async () => {
        mcpCalls += 1;
        return { ok: true, text: '### MCP Context\n- src/index.ts\n' };
      },
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.diagnostic);
    expect(mcpCalls).toBe(1);
    expect(readUsage(result.runDir)).toMatchObject({
      transport_requested: 'mcp',
      transport_used: 'mcp',
      mcp_attempted: true,
      fallback_used: false,
      used_for_context: true,
    });
  });

  test('context-build use-existing with persisted cli does not call MCP', async () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData({ version: 1, defaults: { codegraph: { transport: 'cli' }, flash: {} }, providers: {} });
    cleanup.push(tmpRepo, appData);
    process.env.LOCALAPPDATA = appData;
    let mcpCalls = 0;

    const result = await runContextBuild({
      task: 'persisted cli',
      repoRoot: tmpRepo,
      codegraphMode: 'use-existing',
      codegraphRunner: cliSuccessRunner,
      codegraphReadinessProvider: readyProvider,
      codegraphMcpRunner: async () => {
        mcpCalls += 1;
        return { ok: true, text: 'unused' };
      },
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.diagnostic);
    expect(mcpCalls).toBe(0);
    expect(readUsage(result.runDir)).toMatchObject({
      transport_requested: 'cli',
      transport_used: 'cli',
      mcp_attempted: false,
    });
  });

  test('context-build use-existing with persisted auto prefers MCP and records auto behavior', async () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData({ version: 1, defaults: { codegraph: { transport: 'auto' }, flash: {} }, providers: {} });
    cleanup.push(tmpRepo, appData);
    process.env.LOCALAPPDATA = appData;

    const result = await runContextBuild({
      task: 'persisted auto',
      repoRoot: tmpRepo,
      codegraphMode: 'use-existing',
      codegraphRunner: () => { throw new Error('CLI runner should not run when persisted auto MCP succeeds'); },
      codegraphMcpRunner: mcpSuccessRunner(),
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.diagnostic);
    expect(readUsage(result.runDir)).toMatchObject({
      transport_requested: 'auto',
      transport_used: 'mcp',
      mcp_attempted: true,
      fallback_used: false,
      used_for_context: true,
    });
  });

  test('prompt --codegraph uses persisted mcp without requiring a prompt-level transport flag', async () => {
    const tmpRepo = makeRepo();
    const appData = makeAppData({ version: 1, defaults: { codegraph: { transport: 'mcp' }, flash: {} }, providers: {} });
    cleanup.push(tmpRepo, appData);
    process.env.LOCALAPPDATA = appData;

    const result = await runPromptCommand({
      task: 'prompt persisted mcp',
      repoRoot: tmpRepo,
      mock: true,
      codegraphMode: 'use-existing',
      adapter: new MockFlashAdapter(),
      codegraphMcpRunner: mcpSuccessRunner(),
      json: true,
      stdout: { write: () => true } as unknown as NodeJS.WritableStream,
      stderr: { write: () => true } as unknown as NodeJS.WritableStream,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(readUsage(result.runDir)).toMatchObject({
      transport_requested: 'mcp',
      transport_used: 'mcp',
      mcp_attempted: true,
      used_for_context: true,
    });
  });
});
