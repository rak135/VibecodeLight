import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { runPromptPipeline } from '../../../src/core/prompting/pipeline.js';
import type { PipelineEvent } from '../../../src/core/prompting/pipeline_events.js';
import type { CodeGraphMcpContextRunner } from '../../../src/adapters/codegraph/codegraph_mcp.js';

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cg-transport-progress-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  return repoRoot;
}

const failingMcpRunner: CodeGraphMcpContextRunner = async () => ({
  ok: false,
  code: 'CODEGRAPH_MCP_CONTEXT_FAILED',
  message: 'connection refused',
});

describe('pipeline progress events surface CodeGraph transport (Phase 1B)', () => {
  test('detect-only run with transport=mcp shows transport requested in detect details', async () => {
    const repoRoot = makeRepo();
    const events: PipelineEvent[] = [];
    try {
      const result = await runPromptPipeline({
        task: 'progress detect-only mcp',
        repoRoot,
        mock: true,
        codegraphMode: 'detect-only',
        codegraphTransport: 'mcp',
        codegraphMcpRunner: failingMcpRunner,
        onProgress: (event) => events.push(event),
      });
      expect(result.ok).toBe(true);
      const detect = events.find((event) => event.phase === 'codegraph_detect_started');
      expect(detect?.detail ?? '').toContain('transport requested: MCP');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('use-existing run with transport=auto and failing MCP emits codegraph_transport_fallback warning', async () => {
    const repoRoot = makeRepo();
    const events: PipelineEvent[] = [];
    try {
      const result = await runPromptPipeline({
        task: 'progress auto fallback',
        repoRoot,
        mock: true,
        codegraphMode: 'use-existing',
        codegraphTransport: 'auto',
        codegraphMcpRunner: failingMcpRunner,
        onProgress: (event) => events.push(event),
      });
      expect(result.ok).toBe(true);
      const fallback = events.find((event) => event.phase === 'codegraph_transport_fallback');
      expect(fallback).toBeDefined();
      expect(fallback?.status).toBe('warning');
      expect(fallback?.message).toContain('falling back to CLI');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
