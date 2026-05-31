import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { runContextBuild } from '../../../src/app/cli/index.js';
import type {
  CodeGraphContextRunner,
  CodeGraphReadinessProvider,
} from '../../../src/adapters/codegraph/codegraph_context.js';
import type { CodeGraphMcpContextRunner } from '../../../src/adapters/codegraph/codegraph_mcp.js';

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-transport-'));
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Transport fixture\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export const main = () => 1;\n', 'utf8');
  return repoRoot;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

const readyProvider: CodeGraphReadinessProvider = async () => ({
  ok: true,
  available: true,
  initialized: true,
  version: 'codegraph-test 1.0.0',
  warnings: [],
});

function cliSuccessRunner(): CodeGraphContextRunner {
  return (_command, args) => {
    if (args[0] === 'status') {
      return { ok: true, stdout: JSON.stringify({ pendingChanges: { added: 0, modified: 0, removed: 0 } }), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'context') {
      return {
        ok: true,
        stdout: '### Entry Points\n- src/index.ts\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { ok: false, stdout: '', stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
  };
}

function failingCliRunner(): CodeGraphContextRunner {
  return (_command, args) => {
    if (args[0] === 'status') {
      return { ok: true, stdout: JSON.stringify({ pendingChanges: { added: 0, modified: 0, removed: 0 } }), stderr: '', exitCode: 0 };
    }
    return { ok: false, stdout: '', stderr: 'cli context failed', exitCode: 1 };
  };
}

function neverCalledCliRunner(): CodeGraphContextRunner {
  return () => {
    throw new Error('CLI runner must not be invoked');
  };
}

function mcpSuccessRunner(text = '### MCP Context\n- src/index.ts\n'): CodeGraphMcpContextRunner {
  return async (input) => {
    expect(input.command).toBe('codegraph');
    expect(input.args).toEqual(['serve', '--mcp']);
    return { ok: true, text };
  };
}

function mcpFailureRunner(): CodeGraphMcpContextRunner {
  return async () => ({
    ok: false,
    code: 'CODEGRAPH_MCP_CONTEXT_FAILED',
    message: 'connection refused',
  });
}

describe('CodeGraph transport pipeline integration (Phase 1B)', () => {
  test('detect-only: mcp transport recorded but no MCP/CLI context call', async () => {
    const repoRoot = makeRepo();
    try {
      let mcpCalls = 0;
      const result = await runContextBuild({
        task: 'detect only with mcp transport',
        repoRoot,
        codegraphMode: 'detect-only',
        codegraphTransport: 'mcp',
        codegraphRunner: neverCalledCliRunner(),
        codegraphMcpRunner: async () => {
          mcpCalls += 1;
          return { ok: true, text: 'should not be called' };
        },
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      expect(mcpCalls).toBe(0);
      const usage = readJson(path.join(result.runDir, 'scan', 'codegraph_usage.json'));
      expect(usage.mode).toBe('detect-only');
      expect(usage.used).toBe(false);
      expect(usage.used_for_context).toBe(false);
      expect(usage.transport_requested).toBe('mcp');
      expect(usage.transport_used).toBe('none');
      expect(usage.mcp_attempted).toBe(false);
      expect(usage.fallback_used).toBe(false);
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_context.md'))).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('use-existing + cli: invokes CLI adapter and never starts MCP', async () => {
    const repoRoot = makeRepo();
    try {
      let mcpCalls = 0;
      const result = await runContextBuild({
        task: 'cli path',
        repoRoot,
        codegraphMode: 'use-existing',
        codegraphTransport: 'cli',
        codegraphRunner: cliSuccessRunner(),
        codegraphReadinessProvider: readyProvider,
        codegraphMcpRunner: async () => {
          mcpCalls += 1;
          return { ok: true, text: 'unused' };
        },
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      expect(mcpCalls).toBe(0);
      const usage = readJson(path.join(result.runDir, 'scan', 'codegraph_usage.json'));
      expect(usage.transport_requested).toBe('cli');
      expect(usage.transport_used).toBe('cli');
      expect(usage.mcp_attempted).toBe(false);
      expect(usage.fallback_used).toBe(false);
      expect(usage.used_for_context).toBe(true);
      expect(usage.context_artifact).toBe('scan/codegraph_context.md');
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_context.md'))).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('use-existing + mcp success: writes context artifact and records transport_used=mcp', async () => {
    const repoRoot = makeRepo();
    try {
      const result = await runContextBuild({
        task: 'mcp success path',
        repoRoot,
        codegraphMode: 'use-existing',
        codegraphTransport: 'mcp',
        codegraphRunner: neverCalledCliRunner(),
        codegraphMcpRunner: mcpSuccessRunner(),
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      const usage = readJson(path.join(result.runDir, 'scan', 'codegraph_usage.json'));
      expect(usage.transport_requested).toBe('mcp');
      expect(usage.transport_used).toBe('mcp');
      expect(usage.mcp_attempted).toBe(true);
      expect(usage.fallback_used).toBe(false);
      expect(usage.used_for_context).toBe(true);
      expect(usage.context_artifact).toBe('scan/codegraph_context.md');
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_context.md'))).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('use-existing + mcp failure: no silent CLI fallback; pipeline continues with warning', async () => {
    const repoRoot = makeRepo();
    try {
      const result = await runContextBuild({
        task: 'mcp strict failure',
        repoRoot,
        codegraphMode: 'use-existing',
        codegraphTransport: 'mcp',
        codegraphRunner: neverCalledCliRunner(),
        codegraphMcpRunner: mcpFailureRunner(),
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      const usage = readJson(path.join(result.runDir, 'scan', 'codegraph_usage.json'));
      expect(usage.transport_requested).toBe('mcp');
      expect(usage.transport_used).toBe('none');
      expect(usage.mcp_attempted).toBe(true);
      expect(usage.fallback_used).toBe(false);
      expect(usage.used_for_context).toBe(false);
      expect((result.warnings ?? []).join('\n')).toContain('CODEGRAPH_MCP_CONTEXT_FAILED');
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_context.md'))).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('use-existing + auto success: prefers MCP, no CLI fallback when MCP works', async () => {
    const repoRoot = makeRepo();
    try {
      const result = await runContextBuild({
        task: 'auto success',
        repoRoot,
        codegraphMode: 'use-existing',
        codegraphTransport: 'auto',
        codegraphRunner: neverCalledCliRunner(),
        codegraphMcpRunner: mcpSuccessRunner(),
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      const usage = readJson(path.join(result.runDir, 'scan', 'codegraph_usage.json'));
      expect(usage.transport_requested).toBe('auto');
      expect(usage.transport_used).toBe('mcp');
      expect(usage.mcp_attempted).toBe(true);
      expect(usage.fallback_used).toBe(false);
      expect(usage.used_for_context).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('use-existing + auto fallback: MCP fails → CLI runs, fallback_used=true, warning emitted, final prompt still generated', async () => {
    const repoRoot = makeRepo();
    try {
      const result = await runContextBuild({
        task: 'auto fallback',
        repoRoot,
        codegraphMode: 'use-existing',
        codegraphTransport: 'auto',
        codegraphRunner: cliSuccessRunner(),
        codegraphReadinessProvider: readyProvider,
        codegraphMcpRunner: mcpFailureRunner(),
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      const usage = readJson(path.join(result.runDir, 'scan', 'codegraph_usage.json'));
      expect(usage.transport_requested).toBe('auto');
      expect(usage.transport_used).toBe('cli');
      expect(usage.mcp_attempted).toBe(true);
      expect(usage.fallback_used).toBe(true);
      expect(typeof usage.fallback_reason).toBe('string');
      expect((usage.fallback_reason as string).length).toBeGreaterThan(0);
      expect(usage.used_for_context).toBe(true);
      const warningsJoined = (result.warnings ?? []).join('\n');
      expect(warningsJoined).toContain('CodeGraph MCP failed; fell back to CLI.');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('auto fallback to a failing CLI: fallback_used=true, used_for_context=false', async () => {
    const repoRoot = makeRepo();
    try {
      const result = await runContextBuild({
        task: 'auto fallback to broken cli',
        repoRoot,
        codegraphMode: 'use-existing',
        codegraphTransport: 'auto',
        codegraphRunner: failingCliRunner(),
        codegraphReadinessProvider: readyProvider,
        codegraphMcpRunner: mcpFailureRunner(),
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      const usage = readJson(path.join(result.runDir, 'scan', 'codegraph_usage.json'));
      expect(usage.transport_requested).toBe('auto');
      expect(usage.transport_used).toBe('none');
      expect(usage.fallback_used).toBe(true);
      expect(usage.used_for_context).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
