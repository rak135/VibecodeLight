import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';
import { afterEach, describe, expect, test } from 'vitest';

import type { CodeGraphMcpContextRunner } from '../../../src/adapters/codegraph/codegraph_mcp.js';
import { runPromptPipeline } from '../../../src/core/prompting/pipeline.js';
import type { PipelineEvent } from '../../../src/core/prompting/pipeline_events.js';

/**
 * TEMPORARY: Pins CodeGraph artifact surface from the prompt pipeline
 * perspective. Should be consolidated into codegraph_step_parity.test.ts
 * as the single canonical CodeGraph artifact test. Remove artifact-list
 * assertions when codegraph_step_parity.test.ts is the sole canonical test.
 * Do not add new assertions here.
 */

function makeRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# CodeGraph characterization fixture\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export function main() { return "ok"; }\n', 'utf8');
  return repoRoot;
}

function makeAppDataWithTransport(transport: 'cli' | 'mcp' | 'auto'): string {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-pipeline-cg-appdata-'));
  const dir = path.join(appData, 'vibecodelight');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    YAML.stringify({ version: 1, defaults: { codegraph: { transport }, flash: {} }, providers: {} }),
    'utf8',
  );
  return appData;
}

function toRelativeArtifacts(runDir: string, artifacts: string[]): string[] {
  return artifacts.map((artifact) => path.relative(runDir, artifact).replace(/\\/g, '/'));
}

function readUsage(runDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'scan', 'codegraph_usage.json'), 'utf8')) as Record<string, unknown>;
}

const mcpSuccessRunner: CodeGraphMcpContextRunner = async () => ({
  ok: true,
  text: [
    '### Entry Points',
    '- src/index.ts: main:1',
    '',
    '### Related Symbols',
    '- **main** (function) - src/index.ts:1',
  ].join('\n'),
});

const mcpFailureRunner: CodeGraphMcpContextRunner = async () => ({
  ok: false,
  code: 'CODEGRAPH_MCP_CONTEXT_FAILED',
  message: 'connection refused for characterization',
});

describe('prompt pipeline CodeGraph characterization', () => {
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const cleanup: string[] = [];

  afterEach(() => {
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  test('use-existing mcp success reports canonical CodeGraph artifacts but omits legacy repo_atlas artifacts from result.artifacts', async () => {
    const repoRoot = makeRepo('vibecode-pipeline-cg-artifacts-');
    cleanup.push(repoRoot);

    const result = await runPromptPipeline({
      task: 'characterize prompt pipeline CodeGraph artifacts',
      repoRoot,
      mock: true,
      codegraphMode: 'use-existing',
      codegraphTransport: 'mcp',
      codegraphMcpRunner: mcpSuccessRunner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    const relativeArtifacts = toRelativeArtifacts(result.runDir, result.artifacts);
    expect(relativeArtifacts).toEqual(expect.arrayContaining([
      'scan/codegraph_usage.json',
      'scan/codegraph_context.md',
      'scan/codegraph_repo_atlas.md',
      'scan/codegraph_repo_atlas.json',
    ]));
    expect(relativeArtifacts).not.toContain('scan/repo_atlas.md');
    expect(relativeArtifacts).not.toContain('scan/repo_atlas.json');

    // Current adapter ownership still writes legacy duplicates on disk. This test
    // only pins the prompt pipeline result artifact list, not a cleanup.
    for (const relativePath of [
      'scan/codegraph_usage.json',
      'scan/codegraph_context.md',
      'scan/codegraph_repo_atlas.md',
      'scan/codegraph_repo_atlas.json',
      'scan/repo_atlas.md',
      'scan/repo_atlas.json',
    ]) {
      expect(fs.existsSync(path.join(result.runDir, relativePath)), relativePath).toBe(true);
    }
  });

  test('detect-only and use-existing runs emit the current stable CodeGraph progress phases', async () => {
    const detectRepo = makeRepo('vibecode-pipeline-cg-detect-progress-');
    const useRepo = makeRepo('vibecode-pipeline-cg-use-progress-');
    cleanup.push(detectRepo, useRepo);
    const detectEvents: PipelineEvent[] = [];
    const useEvents: PipelineEvent[] = [];

    const detect = await runPromptPipeline({
      task: 'characterize detect-only CodeGraph progress',
      repoRoot: detectRepo,
      mock: true,
      codegraphMode: 'detect-only',
      onProgress: (event) => detectEvents.push(event),
    });
    const used = await runPromptPipeline({
      task: 'characterize use-existing CodeGraph progress',
      repoRoot: useRepo,
      mock: true,
      codegraphMode: 'use-existing',
      codegraphTransport: 'mcp',
      codegraphMcpRunner: mcpSuccessRunner,
      onProgress: (event) => useEvents.push(event),
    });

    expect(detect.ok).toBe(true);
    expect(used.ok).toBe(true);
    const detectPhases = detectEvents.map((event) => event.phase);
    expect(detectPhases).toEqual(expect.arrayContaining([
      'codegraph_detect_started',
      'codegraph_detect_completed',
      'codegraph_detect_only',
    ]));
    expect(detectPhases.indexOf('codegraph_detect_started')).toBeLessThan(detectPhases.indexOf('codegraph_detect_completed'));
    expect(detectPhases.indexOf('codegraph_detect_completed')).toBeLessThan(detectPhases.indexOf('codegraph_detect_only'));

    const usePhases = useEvents.map((event) => event.phase);
    expect(usePhases).toEqual(expect.arrayContaining([
      'codegraph_use_existing_started',
      'codegraph_context_completed',
    ]));
    expect(usePhases.indexOf('codegraph_use_existing_started')).toBeLessThan(usePhases.indexOf('codegraph_context_completed'));
  });

  test('CodeGraph warnings surface as pipeline_warning events labeled CodeGraph', async () => {
    const repoRoot = makeRepo('vibecode-pipeline-cg-warning-');
    cleanup.push(repoRoot);
    const events: PipelineEvent[] = [];

    const result = await runPromptPipeline({
      task: 'characterize prompt pipeline CodeGraph warning labels',
      repoRoot,
      mock: true,
      codegraphMode: 'use-existing',
      codegraphTransport: 'mcp',
      codegraphMcpRunner: mcpFailureRunner,
      onProgress: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.warnings.join('\n')).toContain('CODEGRAPH_MCP_CONTEXT_FAILED');
    expect(events.find((event) => event.phase === 'codegraph_context_failed')).toMatchObject({
      status: 'warning',
      label: 'CodeGraph',
    });
    expect(events.find((event) => event.phase === 'pipeline_warning' && event.message.includes('CODEGRAPH_MCP_CONTEXT_FAILED'))).toMatchObject({
      status: 'warning',
      label: 'CodeGraph',
    });
  });

  test('omitted codegraphTransport uses DEFAULT_CODEGRAPH_TRANSPORT instead of persisted transport config', async () => {
    const repoRoot = makeRepo('vibecode-pipeline-cg-default-');
    const appData = makeAppDataWithTransport('mcp');
    cleanup.push(repoRoot, appData);
    process.env.LOCALAPPDATA = appData;

    const result = await runPromptPipeline({
      task: 'characterize prompt pipeline transport default',
      repoRoot,
      mock: true,
      codegraphMode: 'detect-only',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(readUsage(result.runDir)).toMatchObject({
      mode: 'detect-only',
      transport_requested: 'cli',
      transport_used: 'none',
    });
  });
});
