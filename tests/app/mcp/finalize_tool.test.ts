import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildFinalizeCheckTool } from '../../../src/app/mcp/tools/finalize_check.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';
import { getFinalizeCheck } from '../../../src/core/coordination/finalize_check.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  git(['init', '-q'], repoRoot);
  git(['config', 'user.email', 't@example.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  git(['config', 'commit.gpgsign', 'false'], repoRoot);
  git(['config', 'core.autocrlf', 'false'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repoRoot);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repoRoot);
  return { repoRoot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('VibecodeMCP finalize check tool', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-finalize-mcp-');
  });
  afterEach(() => repo.cleanup());

  test('is registered in the canonical tool name list', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).toContain('vibecode_finalize_check');
    expect(buildFinalizeCheckTool().name).toBe('vibecode_finalize_check');
  });

  test('returns the same core data as a direct core call (shared core, no shell-out)', async () => {
    const agent = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'claude' });
    fs.writeFileSync(path.join(repo.repoRoot, 'a.ts'), 'x\n', 'utf8');

    const tool = buildFinalizeCheckTool();
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent.agent_id },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { status: string; blocks: Array<{ code: string }> };

    const core = getFinalizeCheck({ repoRoot: repo.repoRoot, agent_id: agent.agent_id });
    expect(data.status).toBe(core.status);
    expect(data.status).toBe('blocked');
    expect(data.blocks.map((b) => b.code)).toEqual(core.blocks.map((b) => b.code));
  });

  test('a blocked finalize is a successful (non-error) result with status="blocked"', async () => {
    const agent = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'claude' });
    fs.writeFileSync(path.join(repo.repoRoot, 'a.ts'), 'x\n', 'utf8');
    const tool = buildFinalizeCheckTool();
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent.agent_id },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.ok).toBe(true);
    expect((result.structuredContent.data as { status: string }).status).toBe('blocked');
  });

  test('rejects a stray repo argument with INVALID_ARGUMENT', async () => {
    const tool = buildFinalizeCheckTool();
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { repo: '/etc/passwd', agent_id: 'x' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('requires agent_id or run_id', async () => {
    const tool = buildFinalizeCheckTool();
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: {},
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('input schema is additionalProperties=false and accepts no repo key', () => {
    const schema = buildFinalizeCheckTool().inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['agent_id', 'run_id']);
  });
});
