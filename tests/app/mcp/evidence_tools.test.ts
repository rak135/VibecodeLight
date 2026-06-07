import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildEvidenceListTool,
  buildEvidenceScanTool,
} from '../../../src/app/mcp/tools/evidence.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import { getEvidenceLogPath } from '../../../src/core/coordination/watcher_events.js';
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
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repoRoot);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repoRoot);
  return { repoRoot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('VibecodeMCP evidence tools', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-evidence-mcp-');
  });
  afterEach(() => repo.cleanup());

  test('both tools are in the canonical name list with the expected names', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).toContain('vibecode_evidence_list');
    expect(VIBECODE_MCP_TOOL_NAMES).toContain('vibecode_evidence_scan');
    expect(buildEvidenceListTool().name).toBe('vibecode_evidence_list');
    expect(buildEvidenceScanTool().name).toBe('vibecode_evidence_scan');
  });

  test('input schemas are additionalProperties=false and never accept a repo key', () => {
    for (const tool of [buildEvidenceListTool(), buildEvidenceScanTool()]) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
        expect(['repo', 'repoRoot', 'repo_path']).not.toContain(key);
      }
    }
  });

  test('scan records evidence for the dirty tree and writes only the generated log', async () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'claude' }, { agentId: 'agent-a' });
    fs.writeFileSync(path.join(repo.repoRoot, 'a.ts'), 'x\n', 'utf8');
    const headBefore = git(['rev-parse', 'HEAD'], repo.repoRoot).stdout.trim();
    const statusBefore = git(['status', '--porcelain=v1'], repo.repoRoot).stdout;

    const tool = buildEvidenceScanTool();
    const result = await tool.handler({ context: ctx(repo.repoRoot), arguments: { agent_id: 'agent-a' }, requestId: null });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { events: Array<{ path: string; classification: string }> };
    expect(data.events.find((e) => e.path === 'a.ts')?.classification).toBe('unclaimed');

    // No git mutation; only the generated evidence log is written.
    expect(git(['rev-parse', 'HEAD'], repo.repoRoot).stdout.trim()).toBe(headBefore);
    expect(git(['status', '--porcelain=v1'], repo.repoRoot).stdout).toBe(statusBefore);
    expect(fs.existsSync(getEvidenceLogPath(repo.repoRoot))).toBe(true);
  });

  test('list returns events recorded by a prior scan', async () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'claude' }, { agentId: 'agent-a' });
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'a.ts', mode: 'exclusive' });
    fs.writeFileSync(path.join(repo.repoRoot, 'a.ts'), 'x\n', 'utf8');
    await buildEvidenceScanTool().handler({ context: ctx(repo.repoRoot), arguments: { agent_id: 'agent-a' }, requestId: null });

    const result = await buildEvidenceListTool().handler({ context: ctx(repo.repoRoot), arguments: {}, requestId: null });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { events: Array<{ path: string; classification: string }> };
    expect(data.events.find((e) => e.path === 'a.ts')?.classification).toBe('claimed_by_agent');
  });

  test('both tools reject a stray repo argument with INVALID_ARGUMENT', async () => {
    for (const tool of [buildEvidenceListTool(), buildEvidenceScanTool()]) {
      const result = await tool.handler({ context: ctx(repo.repoRoot), arguments: { repo: '/etc/passwd' }, requestId: null });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    }
  });
});
