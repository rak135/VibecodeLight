import fs from 'fs';
import os from 'os';
import path from 'path';

import { runContextBuild } from '../../src/app/cli/index.js';
import { runPromptPipeline } from '../../src/core/prompting/pipeline.js';

const EARLY_PHASE_ARTIFACTS = [
  'scanner_config.json',
  'scan/config_snapshot.json',
  'scan/commands.json',
  'scan/repo_instructions.json',
  'scan/docs.json',
  'scan/architecture_docs.json',
  'scan/symbols.json',
  'scan/imports.json',
  'scan/entrypoints.json',
  'scan/tests.json',
  'scan/tooling.json',
  'scan/schemas.json',
  'scan/keyword_hits.json',
  'skills/skills_catalog.json',
  'flash/flash_input_manifest.json',
] as const;

function makeFixtureRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-stage0-drift-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Drift fixture\n\nStable fixture repository.\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), `${JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { commander: '^12.1.0' } }, null, 2)}\n`, 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export function answer(): number {\n  return 42;\n}\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'tests', 'index.test.ts'), 'import { answer } from "../src/index";\ntest("answer", () => expect(answer()).toBe(42));\n', 'utf8');
  return repoRoot;
}

function readJson(runDir: string, relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(runDir, relativePath), 'utf8')) as unknown;
}

function pathVariants(value: string): string[] {
  return [...new Set([value, value.replace(/\\/g, '/'), value.replace(/\//g, '\\')])].filter(Boolean);
}

function replacementNeedles(input: {
  contextRepo: string;
  contextRunId: string;
  contextRunDir: string;
  pipelineRepo: string;
  pipelineRunId: string;
  pipelineRunDir: string;
}): string[] {
  return [
    ...pathVariants(input.contextRunDir),
    ...pathVariants(input.pipelineRunDir),
    ...pathVariants(input.contextRepo),
    ...pathVariants(input.pipelineRepo),
    input.contextRunId,
    input.pipelineRunId,
  ].sort((a, b) => b.length - a.length);
}

function normalizeString(value: string, needles: string[]): string {
  let normalized = value;
  for (const needle of needles) {
    if (!needle) continue;
    const replacement = needle.includes('.vibecode') ? '<RUN_DIR>' : '<DYNAMIC>';
    normalized = normalized.split(needle).join(replacement);
  }
  return normalized;
}

function normalizeValue(value: unknown, needles: string[], keyName = ''): unknown {
  if (typeof value === 'string') {
    if (/^(run_id|created_at|updated_at|generated_at|timestamp|git_head|head_sha)$/i.test(keyName)) return '<DYNAMIC>';
    return normalizeString(value, needles);
  }
  if (typeof value === 'number' && /(timestamp|duration|elapsed)_?ms/i.test(keyName)) return 0;
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, needles));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = normalizeValue(child, needles, key);
    }
    return output;
  }
  return value;
}

describe('CLI context-build vs prompt pipeline early-phase drift', () => {
  let contextRepo: string;
  let pipelineRepo: string;

  beforeEach(() => {
    contextRepo = makeFixtureRepo();
    pipelineRepo = makeFixtureRepo();
  });

  afterEach(() => {
    fs.rmSync(contextRepo, { recursive: true, force: true });
    fs.rmSync(pipelineRepo, { recursive: true, force: true });
  });

  test('context-build and mock prompt pipeline produce matching deterministic early artifacts', async () => {
    const task = 'characterize early artifact drift before prompt pipeline refactor';
    const contextBuild = await runContextBuild({ task, repoRoot: contextRepo, codegraphMode: 'detect-only' });
    const pipeline = await runPromptPipeline({ task, repoRoot: pipelineRepo, mock: true, codegraphMode: 'detect-only' });

    expect(contextBuild.status).toBe('ok');
    expect(pipeline.ok).toBe(true);
    if (contextBuild.status !== 'ok' || !pipeline.ok) return;

    const needles = replacementNeedles({
      contextRepo,
      contextRunId: contextBuild.run_id,
      contextRunDir: contextBuild.runDir,
      pipelineRepo,
      pipelineRunId: pipeline.run_id,
      pipelineRunDir: pipeline.runDir,
    });

    for (const relativePath of EARLY_PHASE_ARTIFACTS) {
      expect(fs.existsSync(path.join(contextBuild.runDir, relativePath)), `${relativePath} missing from context-build run`).toBe(true);
      expect(fs.existsSync(path.join(pipeline.runDir, relativePath)), `${relativePath} missing from prompt pipeline run`).toBe(true);

      // Stage 0 characterizes current production behavior. Byte equality is too strict
      // for these generated JSON artifacts because they contain run ids, timestamps,
      // absolute temp paths, and environment-specific paths; compare normalized JSON
      // shape and deterministic key fields instead.
      expect(normalizeValue(readJson(pipeline.runDir, relativePath), needles), relativePath).toEqual(
        normalizeValue(readJson(contextBuild.runDir, relativePath), needles),
      );
    }
  });
});
