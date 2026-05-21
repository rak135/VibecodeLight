import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { runPromptPipeline } from '../../../src/core/prompting/pipeline.js';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

function makeRepo(prefix: string): string {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), `${prefix} fixture\n`, 'utf8');
  fs.writeFileSync(path.join(tmpRepo, 'hello.py'), 'print("hello")\n', 'utf8');
  return tmpRepo;
}

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      VIBECODE_PROVIDER: undefined,
      VIBECODE_API_KEY: undefined,
      VIBECODE_MODEL: undefined,
      VIBECODE_BASE_URL: undefined,
    },
  });
}

const requiredArtifacts = [
  'user_prompt.md',
  'run_manifest.json',
  'scanner_config.json',
  'scan/scan_manifest.json',
  'skills/skills_catalog.json',
  'flash/flash_input_manifest.json',
  'flash/flash_input.md',
  'flash/flash_output.md',
  'flash/flash_output_meta.json',
  'flash/tool_calls.json',
  'output/context_pack.md',
  'skills/selected_skills.json',
  'skills/selected_skill_contents.md',
  'output/final_prompt.md',
];

const forbiddenArtifacts = [
  'terminal_context.json',
  'terminal/send_metadata.json',
  'terminal/terminal_excerpt_after.md',
  'after/git_status_after.json',
  'after/changed_files_after.json',
  'after/checks_summary.md',
];

describe('full prompt pipeline', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = makeRepo('vibecode-pipeline-');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('prompt "task" --mock creates a complete prompt run', async () => {
    const result = await runPromptPipeline({ task: 'complete prompt run test', repoRoot: tmpRepo, mock: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run_id).toBeTruthy();
    expect(fs.existsSync(result.runDir)).toBe(true);
    expect(fs.existsSync(result.finalPromptPath)).toBe(true);
    expect(result.artifacts).toContain(result.finalPromptPath);
    expect(result.warnings).toEqual(expect.any(Array));
  });

  test('full mock prompt run writes all required artifacts', async () => {
    const result = await runPromptPipeline({ task: 'required artifacts test', repoRoot: tmpRepo, mock: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const relativePath of requiredArtifacts) {
      expect(fs.existsSync(path.join(result.runDir, relativePath))).toBe(true);
    }
  });

  test('full mock prompt run updates current/ artifacts', async () => {
    const result = await runPromptPipeline({ task: 'current artifacts test', repoRoot: tmpRepo, mock: true });

    expect(result.ok).toBe(true);
    const currentDir = path.join(tmpRepo, '.vibecode', 'current');
    expect(fs.existsSync(path.join(currentDir, 'run_manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(currentDir, 'context_pack.md'))).toBe(true);
    expect(fs.existsSync(path.join(currentDir, 'selected_skills.json'))).toBe(true);
    expect(fs.existsSync(path.join(currentDir, 'final_prompt.md'))).toBe(true);
  });

  test('full mock prompt run does NOT create forbidden artifacts', async () => {
    const result = await runPromptPipeline({ task: 'forbidden artifacts test', repoRoot: tmpRepo, mock: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const relativePath of forbiddenArtifacts) {
      expect(fs.existsSync(path.join(result.runDir, relativePath))).toBe(false);
    }
  });

  test('prompt generation does not include terminal context from previous runs', async () => {
    const prevRunDir = path.join(tmpRepo, '.vibecode', 'runs', '20250101-000000-PREV');
    fs.mkdirSync(path.join(prevRunDir, 'terminal'), { recursive: true });
    fs.writeFileSync(
      path.join(prevRunDir, 'terminal', 'terminal_excerpt_after.md'),
      'previous terminal output must not enter prompt\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(prevRunDir, 'run_manifest.json'),
      JSON.stringify({ run_id: '20250101-000000-PREV', created_at: '2025-01-01T00:00:00.000Z', task: 'prev', status: 'done' }),
      'utf8',
    );

    const result = await runPromptPipeline({ task: 'current-info only prompt test', repoRoot: tmpRepo, mock: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fs.existsSync(path.join(result.runDir, 'terminal_context.json'))).toBe(false);
    const flashInput = fs.readFileSync(path.join(result.runDir, 'flash', 'flash_input.md'), 'utf8');
    expect(flashInput).not.toContain('# Terminal Context');
    expect(flashInput).not.toContain('previous terminal output must not enter prompt');
  });

  test('final_prompt.md includes user task', async () => {
    const task = 'unique final prompt user task 9217';
    const result = await runPromptPipeline({ task, repoRoot: tmpRepo, mock: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const finalPrompt = fs.readFileSync(result.finalPromptPath, 'utf8');
    expect(finalPrompt).toContain(task);
  });

  test('prompt without --mock fails with MOCK_REQUIRED', async () => {
    const result = await runPromptPipeline({ task: 'missing mock flag test', repoRoot: tmpRepo, mock: false });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: 'MOCK_REQUIRED',
      message: 'use --mock flag; live provider not configured for this checkpoint',
      path: '',
      details: [],
    });
  });

  test('prompt --mock --json returns canonical success envelope', () => {
    const result = runCli(['prompt', 'canonical success envelope task', '--repo', tmpRepo, '--mock', '--json'], tmpRepo);

    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.run_id).toBeTruthy();
    expect(envelope.data.runDir).toBeTruthy();
    expect(envelope.data.finalPromptPath).toBeTruthy();
    expect(Array.isArray(envelope.artifacts)).toBe(true);
    expect(Array.isArray(envelope.warnings)).toBe(true);
  });

  test('prompt rejects removed --include-terminal-context flag', () => {
    const result = runCli(['prompt', 'removed terminal context flag task', '--repo', tmpRepo, '--mock', '--include-terminal-context'], tmpRepo);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown option');
    expect(result.stderr).toContain('--include-terminal-context');
  });

  test('failure returns canonical error envelope', () => {
    const result = runCli(['prompt', 'canonical failure envelope task', '--repo', tmpRepo, '--json'], tmpRepo);

    expect(result.status).not.toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope).toEqual({
      ok: false,
      error: {
        code: 'MOCK_REQUIRED',
        message: 'use --mock flag; live provider not configured for this checkpoint',
        path: '',
        details: [],
      },
    });
  });
});
