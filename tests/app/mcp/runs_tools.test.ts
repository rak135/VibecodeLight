import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildRunsListTool } from '../../../src/app/mcp/tools/runs_list.js';
import { buildCurrentRunTool } from '../../../src/app/mcp/tools/current_run.js';
import { buildRunGetTool } from '../../../src/app/mcp/tools/run_get.js';
import { buildArtifactReadTool } from '../../../src/app/mcp/tools/artifact_read.js';
import { buildCodeGraphUsageTool } from '../../../src/app/mcp/tools/codegraph_usage.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

interface RunFixture {
  runId: string;
  task: string;
  createdAt: string;
  artifacts?: Record<string, string | object>;
  codegraphUsage?: object;
}

function makeRepoWithRuns(prefix: string, runs: RunFixture[], currentRunId?: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const vibecode = path.join(repoRoot, '.vibecode');
  fs.mkdirSync(path.join(vibecode, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(vibecode, 'current'), { recursive: true });

  for (const run of runs) {
    const runDir = path.join(vibecode, 'runs', run.runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'run_manifest.json'),
      JSON.stringify({ run_id: run.runId, created_at: run.createdAt, task: run.task, status: 'done', repo_root: repoRoot }, null, 2),
      'utf8',
    );
    fs.writeFileSync(path.join(runDir, 'scanner_config.json'), JSON.stringify({ task: run.task, repo_root: repoRoot }), 'utf8');
    for (const [rel, content] of Object.entries(run.artifacts ?? {})) {
      const abs = path.join(runDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
    }
    if (run.codegraphUsage) {
      const scanDir = path.join(runDir, 'scan');
      fs.mkdirSync(scanDir, { recursive: true });
      fs.writeFileSync(path.join(scanDir, 'codegraph_usage.json'), JSON.stringify(run.codegraphUsage), 'utf8');
    }
  }

  if (currentRunId) {
    fs.writeFileSync(
      path.join(vibecode, 'current', 'run_manifest.json'),
      JSON.stringify({ run_id: currentRunId, created_at: runs.find((r) => r.runId === currentRunId)?.createdAt ?? '', task: '' }, null, 2),
      'utf8',
    );
  }
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

// ---------------------------------------------------------------------------
// vibecode_runs_list
// ---------------------------------------------------------------------------
describe('vibecode_runs_list', () => {
  test('lists runs newest first using existing core listRuns service', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns('vibecode-mcp2-runs-list-', [
      { runId: '2026-06-01_001', task: 'old', createdAt: '2026-06-01T00:00:00Z' },
      { runId: '2026-06-05_001', task: 'newer', createdAt: '2026-06-05T00:00:00Z' },
    ]);
    try {
      const tool = buildRunsListTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { runs: Array<{ run_id: string; task: string }> };
      expect(data.runs.length).toBe(2);
      expect(data.runs[0].run_id).toBe('2026-06-05_001');
      expect(data.runs[0].task).toBe('newer');
      expect(data.runs[1].run_id).toBe('2026-06-01_001');
    } finally {
      cleanup();
    }
  });

  test('respects the limit argument', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns('vibecode-mcp2-runs-list-limit-', [
      { runId: 'a', task: 'A', createdAt: '2026-01-01T00:00:00Z' },
      { runId: 'b', task: 'B', createdAt: '2026-01-02T00:00:00Z' },
      { runId: 'c', task: 'C', createdAt: '2026-01-03T00:00:00Z' },
    ]);
    try {
      const tool = buildRunsListTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: { limit: 2 }, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { runs: Array<{ run_id: string }> };
      expect(data.runs.length).toBe(2);
      expect(data.runs.map((r) => r.run_id)).toEqual(['c', 'b']);
    } finally {
      cleanup();
    }
  });

  test('returns an empty list when no runs exist (no crash)', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns('vibecode-mcp2-runs-list-empty-', []);
    try {
      const tool = buildRunsListTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { runs: unknown[] };
      expect(data.runs).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('rejects unknown argument keys with INVALID_ARGUMENT', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns('vibecode-mcp2-runs-list-bad-', []);
    try {
      const tool = buildRunsListTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { repo: '/etc' } as Record<string, unknown>,
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });

  test('rejects negative limit with INVALID_ARGUMENT', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns('vibecode-mcp2-runs-list-neg-', []);
    try {
      const tool = buildRunsListTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { limit: -1 },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// vibecode_current_run
// ---------------------------------------------------------------------------
describe('vibecode_current_run', () => {
  test('resolves the latest run pointer and surfaces artifact availability', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-current-',
      [
        {
          runId: '2026-06-05_001',
          task: 'cur',
          createdAt: '2026-06-05T00:00:00Z',
          artifacts: { 'output/final_prompt.md': 'PROMPT' },
        },
      ],
      '2026-06-05_001',
    );
    try {
      const tool = buildCurrentRunTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        run_id: string;
        run_dir: string;
        has_final_prompt: boolean;
        has_context_pack: boolean;
        has_selected_skills: boolean;
        has_send_metadata: boolean;
        has_codegraph_usage: boolean;
      };
      expect(data.run_id).toBe('2026-06-05_001');
      expect(data.run_dir).toContain('2026-06-05_001');
      expect(data.has_final_prompt).toBe(true);
      expect(data.has_context_pack).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('returns RUN_NOT_FOUND when no .vibecode/current pointer exists', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns('vibecode-mcp2-current-none-', []);
    try {
      const tool = buildCurrentRunTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('RUN_NOT_FOUND');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// vibecode_run_get
// ---------------------------------------------------------------------------
describe('vibecode_run_get', () => {
  test('returns structured run info for an explicit run id', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-run-get-',
      [{ runId: 'r1', task: 'do thing', createdAt: '2026-06-01T00:00:00Z' }],
    );
    try {
      const tool = buildRunGetTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { run_id: string; task: string };
      expect(data.run_id).toBe('r1');
      expect(data.task).toBe('do thing');
    } finally {
      cleanup();
    }
  });

  test('supports "latest" and "current" aliases identically', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-run-get-aliases-',
      [{ runId: 'rX', task: 't', createdAt: '2026-06-05T00:00:00Z' }],
      'rX',
    );
    try {
      const tool = buildRunGetTool();
      const a = await tool.handler({ context: ctx(repoRoot), arguments: { run_id: 'latest' }, requestId: null });
      const b = await tool.handler({ context: ctx(repoRoot), arguments: { run_id: 'current' }, requestId: null });
      expect(a.isError).toBe(false);
      expect(b.isError).toBe(false);
      expect((a.structuredContent.data as { run_id: string }).run_id).toBe('rX');
      expect((b.structuredContent.data as { run_id: string }).run_id).toBe('rX');
    } finally {
      cleanup();
    }
  });

  test('returns RUN_NOT_FOUND for an unknown run id', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns('vibecode-mcp2-run-get-unknown-', []);
    try {
      const tool = buildRunGetTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'nope' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('RUN_NOT_FOUND');
    } finally {
      cleanup();
    }
  });

  test('rejects path-traversal run ids with RUN_NOT_FOUND (no escape)', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns('vibecode-mcp2-run-get-escape-', []);
    try {
      const tool = buildRunGetTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: '../../etc' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('RUN_NOT_FOUND');
    } finally {
      cleanup();
    }
  });

  test('rejects missing run_id (required) with INVALID_ARGUMENT', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns('vibecode-mcp2-run-get-missing-', []);
    try {
      const tool = buildRunGetTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// vibecode_artifact_read
// ---------------------------------------------------------------------------
describe('vibecode_artifact_read', () => {
  test('reads allowlisted artifact via the shared core resolver', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-art-read-',
      [{ runId: 'r1', task: 't', createdAt: '2026-06-05T00:00:00Z', artifacts: { 'output/final_prompt.md': '# final\n' } }],
    );
    try {
      const tool = buildArtifactReadTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1', artifact: 'final_prompt' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { content: string; relative_path: string; bytes_read: number; truncated: boolean };
      expect(data.content).toBe('# final\n');
      expect(data.relative_path).toBe('output/final_prompt.md');
      expect(data.truncated).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('accepts CLI aliases (codegraph, task-intent, etc.)', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-art-read-alias-',
      [{
        runId: 'r1',
        task: 't',
        createdAt: '2026-06-05T00:00:00Z',
        codegraphUsage: { mode: 'detect-only' },
      }],
    );
    try {
      const tool = buildArtifactReadTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1', artifact: 'codegraph' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { relative_path: string };
      expect(data.relative_path).toBe('scan/codegraph_usage.json');
    } finally {
      cleanup();
    }
  });

  test('respects max_bytes and surfaces truncated=true', async () => {
    const big = 'x'.repeat(2048);
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-art-read-trunc-',
      [{ runId: 'r1', task: 't', createdAt: '2026-06-05T00:00:00Z', artifacts: { 'output/final_prompt.md': big } }],
    );
    try {
      const tool = buildArtifactReadTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1', artifact: 'final_prompt', max_bytes: 16 },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      // Phase 1B-1 contract: bytes_read is the bytes actually returned in this
      // chunk; total_bytes is the full file size; truncated mirrors has_more.
      const data = result.structuredContent.data as {
        content: string;
        bytes_read: number;
        total_bytes: number;
        truncated: boolean;
        has_more: boolean;
        next_byte_offset: number | null;
      };
      expect(data.content).toBe('x'.repeat(16));
      expect(data.truncated).toBe(true);
      expect(data.has_more).toBe(true);
      expect(data.bytes_read).toBe(16);
      expect(data.total_bytes).toBe(2048);
      expect(data.next_byte_offset).toBe(16);
    } finally {
      cleanup();
    }
  });

  test('rejects unknown artifact name with ARTIFACT_NOT_ALLOWED and includes allowlist details', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-art-read-bad-',
      [{ runId: 'r1', task: 't', createdAt: '2026-06-05T00:00:00Z' }],
    );
    try {
      const tool = buildArtifactReadTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1', artifact: '../../etc/passwd' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('ARTIFACT_NOT_ALLOWED');
    } finally {
      cleanup();
    }
  });

  test('rejects path-traversal artifact (after normalization) with ARTIFACT_NOT_ALLOWED', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-art-read-traverse-',
      [{ runId: 'r1', task: 't', createdAt: '2026-06-05T00:00:00Z' }],
    );
    try {
      const tool = buildArtifactReadTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1', artifact: '..\\etc\\hosts' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('ARTIFACT_NOT_ALLOWED');
    } finally {
      cleanup();
    }
  });

  test('returns ARTIFACT_NOT_FOUND when allowlisted artifact does not exist on disk', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-art-read-missing-',
      [{ runId: 'r1', task: 't', createdAt: '2026-06-05T00:00:00Z' }],
    );
    try {
      const tool = buildArtifactReadTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1', artifact: 'final_prompt' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('ARTIFACT_NOT_FOUND');
    } finally {
      cleanup();
    }
  });

  test('returns RUN_NOT_FOUND when run id does not exist', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns('vibecode-mcp2-art-read-norun-', []);
    try {
      const tool = buildArtifactReadTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'nope', artifact: 'final_prompt' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('RUN_NOT_FOUND');
    } finally {
      cleanup();
    }
  });

  test('does not allow reading source repo files (artifact must be inside the run dir)', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-art-read-src-',
      [{ runId: 'r1', task: 't', createdAt: '2026-06-05T00:00:00Z' }],
    );
    try {
      // Write a sibling repo file that an agent might be curious about.
      fs.writeFileSync(path.join(repoRoot, 'README.md'), 'SECRET-SIBLING', 'utf8');
      const tool = buildArtifactReadTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1', artifact: '../../README.md' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      // Either the allowlist rejects it, or the escape guard does. Both are fine.
      expect(['ARTIFACT_NOT_ALLOWED', 'ARTIFACT_NOT_FOUND']).toContain(result.structuredContent.error?.code);
      // The structured content must not include the sibling file content.
      const text = result.content[0]?.text ?? '';
      expect(text).not.toContain('SECRET-SIBLING');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// vibecode_codegraph_usage
// ---------------------------------------------------------------------------
describe('vibecode_codegraph_usage', () => {
  test('parses codegraph_usage.json and returns structured transport fields', async () => {
    const usage = {
      mode: 'use-existing',
      used: true,
      used_for_context: true,
      transport_requested: 'auto',
      transport_used: 'cli',
      mcp_attempted: true,
      fallback_used: true,
      fallback_reason: 'MCP failed',
      reason: 'EXISTING_INDEX',
      warnings: ['CodeGraph MCP failed; fell back to CLI.'],
      context_artifact: 'scan/codegraph_context.md',
      artifact: 'scan/codegraph_context.md',
    };
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-cg-usage-',
      [{ runId: 'r1', task: 't', createdAt: '2026-06-05T00:00:00Z', codegraphUsage: usage }],
    );
    try {
      const tool = buildCodeGraphUsageTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as Record<string, unknown>;
      expect(data.mode).toBe('use-existing');
      expect(data.used_for_context).toBe(true);
      expect(data.transport_requested).toBe('auto');
      expect(data.transport_used).toBe('cli');
      expect(data.fallback_used).toBe(true);
      expect(data.fallback_reason).toBe('MCP failed');
      expect(data.context_artifact).toBe('scan/codegraph_context.md');
    } finally {
      cleanup();
    }
  });

  test('defaults to latest/current run when no run_id is provided', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-cg-usage-latest-',
      [{
        runId: 'rcur',
        task: 't',
        createdAt: '2026-06-05T00:00:00Z',
        codegraphUsage: { mode: 'detect-only', used: false },
      }],
      'rcur',
    );
    try {
      const tool = buildCodeGraphUsageTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { mode: string };
      expect(data.mode).toBe('detect-only');
    } finally {
      cleanup();
    }
  });

  test('returns ARTIFACT_NOT_FOUND when codegraph_usage.json is missing for the run', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-cg-usage-missing-',
      [{ runId: 'r1', task: 't', createdAt: '2026-06-05T00:00:00Z' }],
    );
    try {
      const tool = buildCodeGraphUsageTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('ARTIFACT_NOT_FOUND');
    } finally {
      cleanup();
    }
  });

  test('returns VIBECODE_ARTIFACT_READ_FAILED when codegraph_usage.json is not valid JSON', async () => {
    const { repoRoot, cleanup } = makeRepoWithRuns(
      'vibecode-mcp2-cg-usage-bad-',
      [{ runId: 'r1', task: 't', createdAt: '2026-06-05T00:00:00Z' }],
    );
    try {
      // Replace usage artifact with garbage.
      const scanDir = path.join(repoRoot, '.vibecode', 'runs', 'r1', 'scan');
      fs.mkdirSync(scanDir, { recursive: true });
      fs.writeFileSync(path.join(scanDir, 'codegraph_usage.json'), 'not json', 'utf8');
      const tool = buildCodeGraphUsageTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('VIBECODE_ARTIFACT_READ_FAILED');
    } finally {
      cleanup();
    }
  });
});
