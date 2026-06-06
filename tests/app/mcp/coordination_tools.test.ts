import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildCoordinationStatusTool } from '../../../src/app/mcp/tools/coordination_status.js';
import { getCoordinationStatus } from '../../../src/core/coordination/status.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('vibecode_coordination_status MCP tool', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-coord-mcp-');
  });
  afterEach(() => repo.cleanup());

  test('returns an empty coordination status equivalent to the core service', async () => {
    const tool = buildCoordinationStatusTool();
    expect(tool.name).toBe('vibecode_coordination_status');

    const result = await tool.handler({ context: ctx(repo.repoRoot), arguments: {}, requestId: null });
    expect(result.isError).toBe(false);

    const data = result.structuredContent.data as {
      workspace_root: string;
      state_file_exists: boolean;
      version: number;
      summary: { agents: number; claims: number; conflicts: number; handoffs: number };
    };
    const core = getCoordinationStatus(repo.repoRoot);

    // MCP tool returns equivalent core data.
    expect(data.workspace_root).toBe(core.workspace_root);
    expect(data.state_file_exists).toBe(core.state_file_exists);
    expect(data.version).toBe(core.version);
    expect(data.summary).toEqual(core.summary);
    expect(result.structuredContent.repo_root).toBe(repo.repoRoot);

    // Read-only: the tool must not initialize state.
    expect(fs.existsSync(path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json'))).toBe(false);
  });

  test('does not accept a repo path argument (additionalProperties=false, rejects "repo")', async () => {
    const tool = buildCoordinationStatusTool();
    // The schema must forbid extra keys and never declare a repo property.
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties ?? {}).not.toHaveProperty('repo');

    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { repo: '/some/other/repo' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('does not shell out to the CLI (no child_process primitives in the tool source)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../src/app/mcp/tools/coordination_status.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bspawn\s*\(|\bexec\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|\bexeca\s*\(/);
    // It must call the shared core service, not the CLI.
    expect(source).toMatch(/core\/coordination\/status/);
  });
});
