import fs from 'fs';
import os from 'os';
import path from 'path';

import { getRunInfo, listRuns } from '../../../src/core/runs/run_display.js';
import { getWorkspacePaths } from '../../../src/core/workspace/paths.js';
import { buildRunsListTool } from '../../../src/app/mcp/tools/runs_list.js';
import { buildRunGetTool } from '../../../src/app/mcp/tools/run_get.js';
import { buildArtifactReadTool } from '../../../src/app/mcp/tools/artifact_read.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

function makeRepo(prefix: string) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const v = path.join(repoRoot, '.vibecode');
  fs.mkdirSync(path.join(v, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(v, 'current'), { recursive: true });
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function writeRun(repoRoot: string, runId: string, task: string, createdAt: string, files: Record<string, string> = {}): void {
  const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({ run_id: runId, created_at: createdAt, task, status: 'done', repo_root: repoRoot }, null, 2),
    'utf8',
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(runDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

describe('Phase MCP-2 / CLI parity', () => {
  test('vibecode_runs_list matches core listRuns ordering and run_ids', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp2-parity-list-');
    try {
      writeRun(repoRoot, 'r1', 'first', '2026-06-01T00:00:00Z');
      writeRun(repoRoot, 'r2', 'second', '2026-06-02T00:00:00Z');
      const corePaths = getWorkspacePaths(repoRoot);
      const coreRuns = listRuns(corePaths.vibecode, corePaths.runs);
      const tool = buildRunsListTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { runs: Array<{ run_id: string }> };
      expect(data.runs.map((r) => r.run_id)).toEqual(coreRuns.map((r) => r.run_id));
    } finally {
      cleanup();
    }
  });

  test('vibecode_run_get matches core getRunInfo for the same runDir', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp2-parity-get-');
    try {
      writeRun(repoRoot, 'r1', 'task one', '2026-06-05T00:00:00Z', { 'output/final_prompt.md': '# fp' });
      const runDir = path.join(repoRoot, '.vibecode', 'runs', 'r1');
      const core = getRunInfo(runDir);
      const tool = buildRunGetTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        run_id: string;
        task: string;
        has_final_prompt: boolean;
      };
      expect(data.run_id).toBe(core.run_id);
      expect(data.task).toBe(core.task);
      expect(data.has_final_prompt).toBe(core.has_final_prompt);
    } finally {
      cleanup();
    }
  });

  test('vibecode_artifact_read returns the same content as CLI runs show --artifact final_prompt', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp2-parity-artifact-');
    try {
      writeRun(repoRoot, 'r1', 't', '2026-06-05T00:00:00Z', { 'output/final_prompt.md': '# final prompt content\nbody' });
      // The CLI artifact path (final_prompt → output/final_prompt.md) is read from disk
      // the same way readRunArtifactText does; we just compare disk bytes against MCP output.
      const expected = fs.readFileSync(path.join(repoRoot, '.vibecode', 'runs', 'r1', 'output', 'final_prompt.md'), 'utf8');
      const tool = buildArtifactReadTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1', artifact: 'final_prompt' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { content: string };
      expect(data.content).toBe(expected);
    } finally {
      cleanup();
    }
  });
});
