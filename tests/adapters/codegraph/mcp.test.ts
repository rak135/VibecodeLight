import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import {
  buildCodeGraphMcpAgentConfig,
  CODEGRAPH_MCP_SERVER_ARGS,
  REQUIRED_CODEGRAPH_MCP_TOOLS,
  detectCodeGraphMcpCapability,
  runCodeGraphMcpSelfTest,
  type CodeGraphMcpCapability,
  type CodeGraphMcpSelfTestRunner,
} from '../../../src/adapters/codegraph/codegraph_mcp.js';

function tempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-mcp-'));
}

function fakeCapability(overrides: Partial<CodeGraphMcpCapability> = {}): CodeGraphMcpCapability {
  return {
    binaryAvailable: true,
    binaryVersion: 'v1.2.3',
    repoRoot: overrides.repoRoot ?? '/repo',
    repoRootExists: true,
    repoRootIsDirectory: true,
    codegraphDirPresent: true,
    serverCommand: 'codegraph',
    serverArgs: [...CODEGRAPH_MCP_SERVER_ARGS],
    warnings: [],
    ...overrides,
  };
}

describe('detectCodeGraphMcpCapability', () => {
  test('binary unavailable produces warning and binaryAvailable=false', () => {
    const repoRoot = tempRepo();
    try {
      const capability = detectCodeGraphMcpCapability(repoRoot, {
        versionProbe: () => ({ found: false, warning: 'not on PATH' }),
      });
      expect(capability.binaryAvailable).toBe(false);
      expect(capability.repoRootExists).toBe(true);
      expect(capability.repoRootIsDirectory).toBe(true);
      expect(capability.codegraphDirPresent).toBe(false);
      expect(capability.serverCommand).toBe('codegraph');
      expect(capability.serverArgs).toEqual(['serve', '--mcp']);
      expect(capability.warnings.join('\n')).toContain('CODEGRAPH_NOT_FOUND');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('repo path that does not exist becomes a warning, not an error', () => {
    const missing = path.join(os.tmpdir(), `vibecode-missing-${Date.now()}`);
    const capability = detectCodeGraphMcpCapability(missing, {
      versionProbe: () => ({ found: true, version: 'v1.2.3' }),
    });
    expect(capability.repoRootExists).toBe(false);
    expect(capability.repoRootIsDirectory).toBe(false);
    expect(capability.warnings.join('\n')).toContain('CODEGRAPH_REPO_NOT_FOUND');
  });

  test('repo path that is a file (not directory) is rejected', () => {
    const file = path.join(os.tmpdir(), `vibecode-file-${Date.now()}.tmp`);
    fs.writeFileSync(file, 'not a dir', 'utf8');
    try {
      const capability = detectCodeGraphMcpCapability(file, {
        versionProbe: () => ({ found: true, version: 'v1.2.3' }),
      });
      expect(capability.repoRootExists).toBe(true);
      expect(capability.repoRootIsDirectory).toBe(false);
      expect(capability.warnings.join('\n')).toContain('CODEGRAPH_REPO_NOT_DIRECTORY');
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('reports codegraphDirPresent=true when .codegraph/ exists', () => {
    const repoRoot = tempRepo();
    try {
      fs.mkdirSync(path.join(repoRoot, '.codegraph'));
      const capability = detectCodeGraphMcpCapability(repoRoot, {
        versionProbe: () => ({ found: true, version: 'v1.2.3' }),
      });
      expect(capability.codegraphDirPresent).toBe(true);
      expect(capability.binaryAvailable).toBe(true);
      expect(capability.binaryVersion).toBe('v1.2.3');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runCodeGraphMcpSelfTest', () => {
  test('returns ok when injected runner reports expected tools', async () => {
    const repoRoot = tempRepo();
    try {
      const runner: CodeGraphMcpSelfTestRunner = async (input) => {
        expect(input.command).toBe('codegraph');
        expect(input.args).toEqual(['serve', '--mcp']);
        expect(input.cwd).toBe(repoRoot);
        return {
          ok: true,
          tools: [
            'codegraph_status',
            'codegraph_context',
            'codegraph_search',
            'codegraph_files',
            'codegraph_trace',
          ],
        };
      };

      const result = await runCodeGraphMcpSelfTest({
        repoRoot,
        runner,
        detectCapability: (root) => fakeCapability({ repoRoot: root }),
      });

      expect(result.ok).toBe(true);
      expect(result.transport).toBe('stdio');
      expect(result.serverCommand).toBe('codegraph');
      expect(result.serverArgs).toEqual(['serve', '--mcp']);
      expect(result.expectedToolsPresent).toBe(true);
      expect(result.missingTools).toEqual([]);
      expect(result.tools).toContain('codegraph_status');
      expect(result.tools).toContain('codegraph_trace');
      expect(result.error).toBeUndefined();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('returns ok=false with CODEGRAPH_MCP_TOOLS_MISSING when an expected tool is absent', async () => {
    const repoRoot = tempRepo();
    try {
      const runner: CodeGraphMcpSelfTestRunner = async () => ({
        ok: true,
        tools: ['codegraph_status', 'codegraph_search', 'codegraph_files'],
      });

      const result = await runCodeGraphMcpSelfTest({
        repoRoot,
        runner,
        detectCapability: (root) => fakeCapability({ repoRoot: root }),
      });

      expect(result.ok).toBe(false);
      expect(result.expectedToolsPresent).toBe(false);
      expect(result.missingTools).toEqual(['codegraph_context']);
      expect(result.error?.code).toBe('CODEGRAPH_MCP_TOOLS_MISSING');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('returns structured diagnostic when server fails to start', async () => {
    const repoRoot = tempRepo();
    try {
      const runner: CodeGraphMcpSelfTestRunner = async () => ({
        ok: false,
        code: 'CODEGRAPH_MCP_CONNECTION_FAILED',
        message: 'spawn codegraph ENOENT',
      });

      const result = await runCodeGraphMcpSelfTest({
        repoRoot,
        runner,
        detectCapability: (root) => fakeCapability({ repoRoot: root }),
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('CODEGRAPH_MCP_CONNECTION_FAILED');
      expect(result.tools).toEqual([]);
      expect(result.missingTools).toEqual([...REQUIRED_CODEGRAPH_MCP_TOOLS]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('thrown errors in the runner are converted to a structured failure', async () => {
    const repoRoot = tempRepo();
    try {
      const runner: CodeGraphMcpSelfTestRunner = async () => {
        throw new Error('boom');
      };

      const result = await runCodeGraphMcpSelfTest({
        repoRoot,
        runner,
        detectCapability: (root) => fakeCapability({ repoRoot: root }),
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('CODEGRAPH_MCP_SELF_TEST_FAILED');
      expect(result.error?.message).toContain('boom');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('does not invoke runner when the codegraph binary is unavailable', async () => {
    const repoRoot = tempRepo();
    try {
      let runnerCalls = 0;
      const runner: CodeGraphMcpSelfTestRunner = async () => {
        runnerCalls += 1;
        return { ok: true, tools: [] };
      };

      const result = await runCodeGraphMcpSelfTest({
        repoRoot,
        runner,
        detectCapability: (root) =>
          fakeCapability({ repoRoot: root, binaryAvailable: false, warnings: ['CODEGRAPH_NOT_FOUND: x'] }),
      });

      expect(runnerCalls).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('CODEGRAPH_BINARY_NOT_FOUND');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('does not invoke runner when the repo path is invalid', async () => {
    const missing = path.join(os.tmpdir(), `vibecode-missing-${Date.now()}`);
    let runnerCalls = 0;
    const runner: CodeGraphMcpSelfTestRunner = async () => {
      runnerCalls += 1;
      return { ok: true, tools: [] };
    };

    const result = await runCodeGraphMcpSelfTest({
      repoRoot: missing,
      runner,
      detectCapability: (root) =>
        fakeCapability({
          repoRoot: root,
          repoRootExists: false,
          repoRootIsDirectory: false,
          warnings: [`CODEGRAPH_REPO_NOT_FOUND: repo path does not exist: ${root}`],
        }),
    });

    expect(runnerCalls).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CODEGRAPH_MCP_REPO_INVALID');
  });
});

describe('buildCodeGraphMcpAgentConfig', () => {
  test('claude produces a stdio config snippet pointing at codegraph serve --mcp', () => {
    const result = buildCodeGraphMcpAgentConfig('claude');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent).toBe('claude');
    expect(result.format).toBe('json');
    expect(JSON.parse(result.snippet)).toEqual({
      mcpServers: {
        codegraph: {
          type: 'stdio',
          command: 'codegraph',
          args: ['serve', '--mcp'],
        },
      },
    });
  });

  test('claude lookup is case-insensitive and ignores surrounding whitespace', () => {
    const result = buildCodeGraphMcpAgentConfig('  Claude  ');
    expect(result.ok).toBe(true);
  });

  test('known-but-unimplemented agents return AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED', () => {
    for (const agent of ['codex', 'opencode', 'hermes']) {
      const result = buildCodeGraphMcpAgentConfig(agent);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED');
      expect(result.error.message).toContain(agent);
    }
  });

  test('unknown agents return UNKNOWN_AGENT', () => {
    const result = buildCodeGraphMcpAgentConfig('cursor');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNKNOWN_AGENT');
  });
});
