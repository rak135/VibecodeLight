/**
 * Tests for CLI --include-terminal-context flag.
 *
 * Verifies that:
 * - --include-terminal-context writes terminal_context.json with included:true when a previous
 *   run with terminal_excerpt_after.md exists.
 * - Without --include-terminal-context, terminal_context.json says included:false.
 * - flash_input.md includes terminal context when requested.
 * - flash_input.md says not included when not requested.
 * - final_prompt.md is always created.
 * - no after/ artifacts are created.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { runPromptPipeline } from '../../../src/core/prompting/pipeline.js';

const EXCERPT = 'npm test\n> 5 tests passed\n> Done in 0.5s\n';

function makeTmpRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-tc-'));
  fs.writeFileSync(path.join(tmp, 'README.md'), '# test repo\n', 'utf8');
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  return tmp;
}

/**
 * Create a "previous run" with a terminal excerpt artifact so
 * --include-terminal-context has something to read.
 */
function makePrevRunWithExcerpt(repoRoot: string): { runId: string; runDir: string } {
  const vibecodePath = path.join(repoRoot, '.vibecode');
  const runId = '20250101-000000-PREV';
  const runDir = path.join(vibecodePath, 'runs', runId);
  const terminalDir = path.join(runDir, 'terminal');
  fs.mkdirSync(terminalDir, { recursive: true });
  fs.writeFileSync(
    path.join(terminalDir, 'terminal_excerpt_after.md'),
    EXCERPT,
    'utf8',
  );
  // write a run_manifest.json so it can be found by previous run summary
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({ run_id: runId, created_at: '2025-01-01T00:00:00.000Z', task: 'prev task', status: 'done' }),
    'utf8',
  );
  return { runId, runDir };
}

describe('runPromptPipeline --include-terminal-context', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = makeTmpRepo();
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('without --include-terminal-context, terminal_context.json says included:false', async () => {
    const result = await runPromptPipeline({
      task: 'test without terminal ctx',
      repoRoot: tmpRepo,
      mock: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tcPath = path.join(result.runDir, 'terminal_context.json');
    expect(fs.existsSync(tcPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(tcPath, 'utf8'));
    expect(data.included).toBe(false);
  });

  test('flash_input.md says not included when --include-terminal-context is not set', async () => {
    const result = await runPromptPipeline({
      task: 'test no terminal ctx flash',
      repoRoot: tmpRepo,
      mock: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const flashInputPath = path.join(result.runDir, 'flash', 'flash_input.md');
    expect(fs.existsSync(flashInputPath)).toBe(true);
    const content = fs.readFileSync(flashInputPath, 'utf8');
    expect(content).toContain('# Terminal Context');
    expect(content).toContain('not included');
  });

  test('with --include-terminal-context, terminal_context.json says included:true when excerpt available', async () => {
    const { runId: prevRunId } = makePrevRunWithExcerpt(tmpRepo);

    const result = await runPromptPipeline({
      task: 'test with terminal ctx',
      repoRoot: tmpRepo,
      mock: true,
      includeTerminalContext: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tcPath = path.join(result.runDir, 'terminal_context.json');
    expect(fs.existsSync(tcPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(tcPath, 'utf8'));
    expect(data.included).toBe(true);
    expect(data.source_run_id).toBe(prevRunId);
    expect(data.excerpt).toContain('5 tests passed');
  });

  test('with --include-terminal-context, flash_input.md includes terminal excerpt', async () => {
    makePrevRunWithExcerpt(tmpRepo);

    const result = await runPromptPipeline({
      task: 'test flash includes excerpt',
      repoRoot: tmpRepo,
      mock: true,
      includeTerminalContext: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const flashInputPath = path.join(result.runDir, 'flash', 'flash_input.md');
    const content = fs.readFileSync(flashInputPath, 'utf8');
    expect(content).toContain('# Terminal Context');
    expect(content).toContain('5 tests passed');
  });

  test('--include-terminal-context still creates final_prompt.md', async () => {
    makePrevRunWithExcerpt(tmpRepo);

    const result = await runPromptPipeline({
      task: 'test final prompt with ctx',
      repoRoot: tmpRepo,
      mock: true,
      includeTerminalContext: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fs.existsSync(result.finalPromptPath)).toBe(true);
  });

  test('no after/ artifacts are created', async () => {
    makePrevRunWithExcerpt(tmpRepo);

    const result = await runPromptPipeline({
      task: 'test no after dir',
      repoRoot: tmpRepo,
      mock: true,
      includeTerminalContext: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fs.existsSync(path.join(result.runDir, 'after'))).toBe(false);
  });

  test('source_path in terminal_context.json points to terminal_excerpt_after.md', async () => {
    makePrevRunWithExcerpt(tmpRepo);

    const result = await runPromptPipeline({
      task: 'test source path',
      repoRoot: tmpRepo,
      mock: true,
      includeTerminalContext: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = JSON.parse(fs.readFileSync(path.join(result.runDir, 'terminal_context.json'), 'utf8'));
    expect(data.source_path).toContain('terminal_excerpt_after.md');
  });
});
