import { describe, expect, test } from 'vitest';

import {
  buildCodeGraphMcpContext,
  type CodeGraphMcpContextRunner,
} from '../../../src/adapters/codegraph/codegraph_mcp.js';

describe('buildCodeGraphMcpContext', () => {
  test('returns text from the injected runner with no warnings', async () => {
    const runner: CodeGraphMcpContextRunner = async (input) => {
      expect(input.command).toBe('codegraph');
      expect(input.args).toEqual(['serve', '--mcp']);
      expect(input.cwd).toBe('/repo');
      expect(input.task).toBe('explain the repo');
      expect(input.maxNodes).toBe(50);
      expect(input.maxCode).toBe(10);
      return { ok: true, text: '## Entry Points\n- src/index.ts\n' };
    };

    const result = await buildCodeGraphMcpContext({
      repoRoot: '/repo',
      task: 'explain the repo',
      maxNodes: 50,
      maxCode: 10,
      runner,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain('Entry Points');
    expect(result.warnings).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  test('returns structured error when runner reports ok=false', async () => {
    const runner: CodeGraphMcpContextRunner = async () => ({
      ok: false,
      code: 'CODEGRAPH_MCP_CONNECTION_FAILED',
      message: 'spawn codegraph ENOENT',
    });
    const result = await buildCodeGraphMcpContext({
      repoRoot: '/repo',
      task: 'task',
      runner,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CODEGRAPH_MCP_CONNECTION_FAILED');
    expect(result.error?.message).toContain('ENOENT');
  });

  test('thrown errors in the runner are converted to a structured failure', async () => {
    const runner: CodeGraphMcpContextRunner = async () => {
      throw new Error('boom');
    };
    const result = await buildCodeGraphMcpContext({
      repoRoot: '/repo',
      task: 'task',
      runner,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CODEGRAPH_MCP_CONTEXT_FAILED');
    expect(result.error?.message).toContain('boom');
  });

  test('propagates warnings from the runner', async () => {
    const runner: CodeGraphMcpContextRunner = async () => ({
      ok: true,
      text: 'context',
      warnings: ['STDERR: nothing to worry about'],
    });
    const result = await buildCodeGraphMcpContext({
      repoRoot: '/repo',
      task: 'task',
      runner,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(['STDERR: nothing to worry about']);
  });
});
