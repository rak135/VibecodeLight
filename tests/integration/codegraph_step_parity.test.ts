import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import type { CodeGraphMcpContextRunner } from '../../src/adapters/codegraph/codegraph_mcp.js';
import { runPromptPipeline } from '../../src/core/prompting/pipeline.js';
import { performContextBuildPhase } from '../../src/core/runs/context_build_phase.js';

const CODEGRAPH_SURFACE = [
  'scan/codegraph_usage.json',
  'scan/codegraph_context.md',
  'scan/codegraph_repo_atlas.md',
  'scan/codegraph_repo_atlas.json',
  'scan/repo_atlas.md',
  'scan/repo_atlas.json',
] as const;

function makeRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# CodeGraph step parity fixture\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export function main() { return "ok"; }\n', 'utf8');
  return repoRoot;
}

function existingSurface(runDir: string): string[] {
  return CODEGRAPH_SURFACE.filter((relativePath) => fs.existsSync(path.join(runDir, relativePath)));
}

function toRelativeArtifacts(runDir: string, artifacts: string[] = []): string[] {
  return artifacts.map((artifact) => path.relative(runDir, artifact).replace(/\\/g, '/'));
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

describe('CodeGraph step parity between prompt pipeline and context-build', () => {
  test('use-existing mcp success writes the same disk surface while result artifact lists preserve current legacy delta', async () => {
    const pipelineRepo = makeRepo('vibecode-cg-parity-pipeline-');
    const contextRepo = makeRepo('vibecode-cg-parity-context-');
    try {
      const task = 'characterize CodeGraph step parity';
      const pipeline = await runPromptPipeline({
        task,
        repoRoot: pipelineRepo,
        mock: true,
        codegraphMode: 'use-existing',
        codegraphTransport: 'mcp',
        codegraphMcpRunner: mcpSuccessRunner,
      });
      const contextBuild = await performContextBuildPhase({
        task,
        repoRoot: contextRepo,
        codegraphMode: 'use-existing',
        codegraphTransport: 'mcp',
        codegraphMcpRunner: mcpSuccessRunner,
      });

      expect(pipeline.ok).toBe(true);
      expect(contextBuild.status).toBe('ok');
      if (!pipeline.ok) throw new Error(pipeline.error.message);
      if (contextBuild.status !== 'ok') throw new Error(contextBuild.diagnostic);

      expect(existingSurface(pipeline.runDir)).toEqual([...CODEGRAPH_SURFACE]);
      expect(existingSurface(contextBuild.runDir)).toEqual([...CODEGRAPH_SURFACE]);

      const pipelineArtifacts = toRelativeArtifacts(pipeline.runDir, pipeline.artifacts);
      const contextArtifacts = toRelativeArtifacts(contextBuild.runDir, contextBuild.artifacts);
      expect(pipelineArtifacts).toEqual(expect.arrayContaining([
        'scan/codegraph_usage.json',
        'scan/codegraph_context.md',
        'scan/codegraph_repo_atlas.md',
        'scan/codegraph_repo_atlas.json',
      ]));
      expect(contextArtifacts).toEqual(expect.arrayContaining([...CODEGRAPH_SURFACE]));

      expect(pipelineArtifacts).not.toContain('scan/repo_atlas.md');
      expect(pipelineArtifacts).not.toContain('scan/repo_atlas.json');
      expect(contextArtifacts).toContain('scan/repo_atlas.md');
      expect(contextArtifacts).toContain('scan/repo_atlas.json');
    } finally {
      fs.rmSync(pipelineRepo, { recursive: true, force: true });
      fs.rmSync(contextRepo, { recursive: true, force: true });
    }
  });
});
