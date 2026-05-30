import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
}

function makeRepo(): string {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-task-normalizer-'));
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Task Normalizer CLI fixture\n', 'utf8');
  fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, 'src', 'fixture.ts'), 'export const fixture = true;\n', 'utf8');
  return tmpRepo;
}

describe('CLI Task Normalizer flags', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = makeRepo();
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('prompt --task-normalizer exposes task normalizer result fields in JSON output', () => {
    const result = runCli([
      'prompt',
      'normalize this cli task',
      '--repo',
      tmpRepo,
      '--mock',
      '--json',
      '--task-normalizer',
    ], tmpRepo);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.taskNormalizerEnabled).toBe(true);
    expect(payload.data.taskNormalizerOk).toBe(false);
    expect(payload.data.taskNormalizerLanguage).toBe('unknown');
    expect(payload.data.taskIntentPath).toBe(path.join(payload.data.runDir, 'task_intent.json'));
    expect(fs.existsSync(payload.data.taskIntentPath)).toBe(true);
  });

  test('prompt --no-task-normalizer keeps the normalizer disabled in JSON output', () => {
    const result = runCli([
      'prompt',
      'leave the cli task raw',
      '--repo',
      tmpRepo,
      '--mock',
      '--json',
      '--no-task-normalizer',
    ], tmpRepo);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.taskNormalizerEnabled).toBe(false);
    expect(payload.data.taskNormalizerOk).toBe(true);
    expect(payload.data.taskNormalizerLanguage).toBe('unknown');
    expect(payload.data.taskIntentPath).toBe(path.join(payload.data.runDir, 'task_intent.json'));
  });

  test('context-build --task-normalizer writes an enabled task_intent artifact', () => {
    const result = runCli([
      'context-build',
      'expand this task before context selection',
      '--repo',
      tmpRepo,
      '--json',
      '--task-normalizer',
    ], tmpRepo);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    const taskIntentPath = path.join(payload.data.runDir, 'task_intent.json');
    expect(fs.existsSync(taskIntentPath)).toBe(true);
    const taskIntent = JSON.parse(fs.readFileSync(taskIntentPath, 'utf8')) as { enabled?: boolean };
    expect(taskIntent.enabled).toBe(true);
    expect(payload.artifacts).toContain(taskIntentPath);
  });

  test('runs show latest --json includes task_intent summary when task_intent.json exists', () => {
    const runId = '20260530-120000-TN01';
    const runDir = path.join(tmpRepo, '.vibecode', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, '.vibecode', 'current'), { recursive: true });
    const manifest = {
      run_id: runId,
      task: 'task normalizer latest run fixture',
      repo_root: tmpRepo,
      created_at: '2026-05-30T12:00:00.000Z',
      status: 'done',
    };
    fs.writeFileSync(path.join(runDir, 'run_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(tmpRepo, '.vibecode', 'current', 'run_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(runDir, 'task_intent.json'), `${JSON.stringify({
      enabled: true,
      ok: true,
      source: 'llm',
      original_language: 'cs',
      normalized_english_task: 'Fix renderer toggle behavior',
      search_hints: ['renderer', 'toggle', 'preview'],
      keyword_groups: { ui_terms: ['renderer'], test_terms: ['preview'] },
      negative_constraints: [],
      validation_hints: [],
      uncertainties: [],
      warnings: [],
    }, null, 2)}\n`, 'utf8');

    const result = runCli(['runs', 'show', 'latest', '--repo', tmpRepo, '--json'], tmpRepo);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.task_intent).toEqual(expect.objectContaining({
      enabled: true,
      ok: true,
      original_language: 'cs',
      normalized_english_task: 'Fix renderer toggle behavior',
      search_hints: ['renderer', 'toggle', 'preview'],
    }));
  });

  test('runs show latest --artifact task-intent prints task_intent.json when present', () => {
    const runId = '20260530-120000-TN02';
    const runDir = path.join(tmpRepo, '.vibecode', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, '.vibecode', 'current'), { recursive: true });
    const manifest = {
      run_id: runId,
      task: 'task normalizer artifact fixture',
      repo_root: tmpRepo,
      created_at: '2026-05-30T12:00:00.000Z',
      status: 'done',
    };
    fs.writeFileSync(path.join(runDir, 'run_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(tmpRepo, '.vibecode', 'current', 'run_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(runDir, 'task_intent.json'), '{"enabled":true,"ok":true,"search_hints":["renderer"]}\n', 'utf8');

    const result = runCli(['runs', 'show', 'latest', '--repo', tmpRepo, '--artifact', 'task-intent'], tmpRepo);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"enabled":true');
    expect(result.stdout).toContain('"search_hints":["renderer"]');
  });
});
