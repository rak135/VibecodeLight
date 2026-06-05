import fs from 'fs';
import os from 'os';
import path from 'path';

import { Command } from 'commander';

import { registerSkillsCommands } from '../../src/app/cli/commands/skills';
import { writeSelectedSkillsManifest } from '../../src/core/skills/selected_manifest';
import { getWorkspacePaths } from '../../src/core/workspace/paths';

function setupRepoWithRun(opts: {
  runId: string;
  skills: Array<{ id: string; body: string }>;
  selected: string[];
}): { repoRoot: string; runDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-skill-'));
  const paths = getWorkspacePaths(repoRoot);
  const runDir = path.join(paths.runs, opts.runId);
  fs.mkdirSync(runDir, { recursive: true });

  for (const s of opts.skills) {
    const skillDir = path.join(repoRoot, 'SKILLS', s.id);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), s.body, 'utf8');
  }

  writeSelectedSkillsManifest(runDir, {
    schema_version: 1,
    run_id: opts.runId,
    skills_dir: 'SKILLS',
    selected_skills: opts.selected.map((id) => ({
      id,
      title: id,
      summary: '',
      source_path: `SKILLS/${id}/SKILL.md`,
    })),
  });

  return { repoRoot, runDir };
}

interface JsonEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function runCli(argv: string[]): Promise<string[]> {
  const out: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg?: unknown) => { out.push(String(msg ?? '')); };
  console.error = (msg?: unknown) => { out.push(String(msg ?? '')); };
  const program = new Command();
  registerSkillsCommands(program);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return out;
}

function parseJson<T = unknown>(out: string[]): JsonEnvelope<T> {
  return JSON.parse(out.find((line) => line.startsWith('{')) ?? '{}') as JsonEnvelope<T>;
}

describe('vibecode skills list/show/path --run-id', () => {
  test('list --run-id surfaces only selected skills', async () => {
    const { repoRoot } = setupRepoWithRun({
      runId: 'run-list',
      skills: [
        { id: 'sel-a', body: '# Sel A\nbody-A\n' },
        { id: 'sel-b', body: '# Sel B\nbody-B\n' },
        { id: 'not-selected', body: '# Not\nbody-N\n' },
      ],
      selected: ['sel-a', 'sel-b'],
    });
    const out = await runCli([
      'skills', 'list', '--run-id', 'run-list', '--repo', repoRoot, '--json',
    ]);
    const env = parseJson<{ selected_skills: Array<{ id: string }> }>(out);
    expect(env.ok).toBe(true);
    const ids = env.data?.selected_skills.map((s) => s.id);
    expect(ids).toEqual(['sel-a', 'sel-b']);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('show prints current repo-local skill body without embedding it in the manifest', async () => {
    const { repoRoot, runDir } = setupRepoWithRun({
      runId: 'run-show',
      skills: [{ id: 'sel-a', body: '# Sel A\nbody-only-on-disk\n' }],
      selected: ['sel-a'],
    });
    const out = await runCli([
      'skills', 'show', 'sel-a', '--run-id', 'run-show', '--repo', repoRoot, '--json',
    ]);
    const env = parseJson<{ content: string; source_path: string }>(out);
    expect(env.ok).toBe(true);
    expect(env.data?.content).toContain('body-only-on-disk');
    expect(env.data?.source_path).toBe('SKILLS/sel-a/SKILL.md');

    // skill_usage.jsonl was written, but did not include the full content
    const jsonl = fs.readFileSync(path.join(runDir, 'terminal', 'skill_usage.jsonl'), 'utf8');
    expect(jsonl).not.toContain('body-only-on-disk');
    expect(jsonl).toContain('"command":"show"');

    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('path prints absolute path of skill file', async () => {
    const { repoRoot } = setupRepoWithRun({
      runId: 'run-path',
      skills: [{ id: 'sel-a', body: '# Sel A\n' }],
      selected: ['sel-a'],
    });
    const out = await runCli([
      'skills', 'path', 'sel-a', '--run-id', 'run-path', '--repo', repoRoot, '--json',
    ]);
    const env = parseJson<{ absolute_path: string }>(out);
    expect(env.ok).toBe(true);
    expect(env.data?.absolute_path).toContain(path.join('SKILLS', 'sel-a', 'SKILL.md'));
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('show returns SKILL_NOT_SELECTED when skill is not in run manifest', async () => {
    const { repoRoot } = setupRepoWithRun({
      runId: 'run-not-selected',
      skills: [
        { id: 'sel-a', body: '# Sel A\n' },
        { id: 'other', body: '# Other\n' },
      ],
      selected: ['sel-a'],
    });
    const out = await runCli([
      'skills', 'show', 'other', '--run-id', 'run-not-selected', '--repo', repoRoot, '--json',
    ]);
    const env = parseJson(out);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('SKILL_NOT_SELECTED');
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('show returns SKILL_FILE_NOT_FOUND when source file is missing', async () => {
    const { repoRoot } = setupRepoWithRun({
      runId: 'run-missing',
      skills: [{ id: 'sel-a', body: '# Sel A\n' }],
      selected: ['sel-a'],
    });
    fs.rmSync(path.join(repoRoot, 'SKILLS', 'sel-a'), { recursive: true, force: true });
    const out = await runCli([
      'skills', 'show', 'sel-a', '--run-id', 'run-missing', '--repo', repoRoot, '--json',
    ]);
    const env = parseJson(out);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('SKILL_FILE_NOT_FOUND');
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('show without --run-id returns structured RUN_ID_REQUIRED (--json)', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-skill-noid-show-'));
    const out = await runCli([
      'skills', 'show', 'systematic-debugging', '--repo', repoRoot, '--json',
    ]);
    const env = parseJson(out);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('RUN_ID_REQUIRED');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('path without --run-id returns structured RUN_ID_REQUIRED (--json)', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-skill-noid-path-'));
    const out = await runCli([
      'skills', 'path', 'systematic-debugging', '--repo', repoRoot, '--json',
    ]);
    const env = parseJson(out);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('RUN_ID_REQUIRED');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('show without --run-id (text mode) prints clear error and exits non-zero', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-skill-noid-show-text-'));
    const out = await runCli([
      'skills', 'show', 'systematic-debugging', '--repo', repoRoot,
    ]);
    const joined = out.join('\n');
    expect(joined).toContain('RUN_ID_REQUIRED');
    expect(joined).toMatch(/--run-id is required/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('show rejects unsafe skill ids before touching the run', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-skill-unsafe-'));
    const out = await runCli([
      'skills', 'show', '../escape', '--run-id', 'run-unsafe', '--repo', repoRoot, '--json',
    ]);
    const env = parseJson(out);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('UNSAFE_SKILL_ID');
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
});
