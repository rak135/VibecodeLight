import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { finalizeContext, ContextFinalizeError } from '../../../src/core/context/context_finalize';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
}

function flashOutput(selectedSkills = '- alpha'): string {
  return [
    '# Task Summary',
    'Task summary body.',
    '',
    '# Relevant Files',
    '- README.md',
    '',
    '# Files To Read With Tools',
    '- README.md',
    '',
    '# Relevant Tests',
    '- pnpm test',
    '',
    '# Commands To Run',
    '- pnpm test',
    '',
    '# Selected Skills',
    selectedSkills,
    '',
    '# Cautions',
    '- Be careful.',
    '',
    '# Context Pack',
    'Finalized context body.',
    '',
  ].join('\n');
}

function makeRepoWithRun(opts: { flashOutput?: string | null; invalidFlashOutput?: boolean } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-context-finalize-'));
  const runId = '20260101-000000-finalize';
  const runDir = path.join(repo, '.vibecode', 'runs', runId);
  const skillDir = path.join(repo, 'SKILLS', 'alpha');
  fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.vibecode', 'current'), { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Alpha\n\nAlpha instructions.\n', 'utf8');
  const manifest = {
    run_id: runId,
    created_at: '2026-01-01T00:00:00.000Z',
    task: 'finalize test task',
    status: 'done',
  };
  fs.writeFileSync(path.join(runDir, 'run_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(repo, '.vibecode', 'current', 'run_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(runDir, 'skills', 'skills_catalog.json'), `${JSON.stringify({
    generated_at: '2026-01-01T00:00:00.000Z',
    warnings: [],
    skills: [{
      id: 'alpha',
      title: 'Alpha',
      summary: 'Alpha summary',
      tags: [],
      source: 'project',
      scope: 'project',
      path: skillDir,
      has_skill_md: true,
      has_skill_yaml: false,
      warnings: [],
    }],
  }, null, 2)}\n`, 'utf8');

  if (opts.invalidFlashOutput) {
    fs.writeFileSync(path.join(runDir, 'flash', 'flash_output.md'), '# Task Summary\nOnly one section.\n', 'utf8');
  } else if (opts.flashOutput !== null) {
    fs.writeFileSync(path.join(runDir, 'flash', 'flash_output.md'), opts.flashOutput ?? flashOutput(), 'utf8');
  }

  return { repo, runId, runDir, skillDir };
}

describe('context finalize', () => {
  test('context finalize writes all three artifacts', () => {
    const { repo, runDir } = makeRepoWithRun();

    const result = finalizeContext(runDir);

    expect(fs.existsSync(path.join(runDir, 'output', 'context_pack.md'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'skills', 'selected_skills.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'skills', 'selected_skill_contents.md'))).toBe(true);
    expect(result.artifacts.map((artifact) => path.basename(artifact))).toEqual([
      'context_pack.md',
      'selected_skills.json',
      'selected_skill_contents.md',
    ]);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('context finalize latest --json returns canonical success envelope', () => {
    const { repo, runId } = makeRepoWithRun();

    const result = runCli(['context', 'finalize', 'latest', '--repo', repo, '--json'], repo);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload).toMatchObject({
      ok: true,
      data: { run_id: runId },
      warnings: [],
    });
    expect(Array.isArray(payload.artifacts)).toBe(true);
    expect(payload.artifacts.map((artifact: string) => path.basename(artifact))).toEqual([
      'context_pack.md',
      'selected_skills.json',
      'selected_skill_contents.md',
    ]);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('context finalize failure returns canonical error envelope', () => {
    const { repo } = makeRepoWithRun({ invalidFlashOutput: true });

    const result = runCli(['context', 'finalize', 'latest', '--repo', repo, '--json'], repo);

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'FLASH_OUTPUT_INVALID',
        message: expect.any(String),
        path: expect.stringContaining(path.join('flash', 'flash_output.md')),
        details: expect.any(Array),
      }),
    });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('final_prompt.md is NOT created by context finalize', () => {
    const { repo, runDir } = makeRepoWithRun();

    finalizeContext(runDir);

    expect(fs.existsSync(path.join(runDir, 'output', 'final_prompt.md'))).toBe(false);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('missing flash_output.md fails with structured error', () => {
    const { repo, runDir } = makeRepoWithRun({ flashOutput: null });

    expect(() => finalizeContext(runDir)).toThrow(ContextFinalizeError);
    try {
      finalizeContext(runDir);
    } catch (error) {
      expect(error).toBeInstanceOf(ContextFinalizeError);
      const typed = error as ContextFinalizeError;
      expect(typed.code).toBe('FLASH_OUTPUT_NOT_FOUND');
      expect(typed.path).toBe(path.join(runDir, 'flash', 'flash_output.md'));
      expect(typed.details).toEqual(expect.any(Array));
    }
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
