import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildGitChangesTool } from '../../../src/app/mcp/tools/git_changes.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';
import { getGitChangesSummary, type GitChangesSummary } from '../../../src/core/workspace/git_changes_summary.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
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

function write(repoRoot: string, rel: string, content = 'x\n'): void {
  const p = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

describe('VibecodeMCP git_changes tool', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-gitchanges-mcp-');
  });
  afterEach(() => repo.cleanup());

  test('is registered in the canonical tool name list', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).toContain('vibecode_git_changes');
    expect(buildGitChangesTool().name).toBe('vibecode_git_changes');
  });

  test('input schema is additionalProperties=false and accepts no repo key', () => {
    const schema = buildGitChangesTool().inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['agent_id', 'include_diff_stat', 'max_files']);
  });

  test('rejects an unknown field with INVALID_ARGUMENT', async () => {
    const result = await buildGitChangesTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { repo: '/etc/passwd' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('returns expected structuredContent matching the shared core call', async () => {
    const a = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo.repoRoot, { agent_id: a.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
    write(repo.repoRoot, 'src/mine.ts');
    write(repo.repoRoot, 'src/loose.ts');

    const result = await buildGitChangesTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: a.agent_id },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as GitChangesSummary;
    const core = getGitChangesSummary(repo.repoRoot, { agent_id: a.agent_id });
    expect(data.summary.claimed_by_agent).toBe(core.summary.claimed_by_agent);
    expect(data.summary.unclaimed).toBe(1);
    // No full diff is ever exposed.
    expect(JSON.stringify(data)).not.toContain('@@');
    // Unclaimed dirty source raises a HIGH warning surfaced in the envelope.
    expect(result.structuredContent.warnings.some((w) => w.includes('UNCLAIMED_DIRTY_FILES'))).toBe(true);
  });

  test('a non-git directory is a GIT_CHANGES_FAILED error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-gitchanges-nogit-'));
    try {
      const result = await buildGitChangesTool().handler({
        context: ctx(dir),
        arguments: {},
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('GIT_CHANGES_FAILED');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
