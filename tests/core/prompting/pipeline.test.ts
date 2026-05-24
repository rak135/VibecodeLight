import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import type { LlmAdapter } from '../../../src/adapters/llm/base.js';
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
      VIBECODE_FLASH_PROVIDER: undefined,
      VIBECODE_FLASH_API_KEY: undefined,
      VIBECODE_FLASH_MODEL: undefined,
      VIBECODE_FLASH_BASE_URL: undefined,
      VIBECODE_FLASH_TIMEOUT_MS: undefined,
      VIBECODE_FLASH_MAX_TOKENS: undefined,
      VIBECODE_FLASH_TEMPERATURE: undefined,
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
  'flash/repo_atlas.md',
  'flash/task_slice.md',
  'flash/relevance_selection.json',
  'flash/flash_input_budget.json',
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

  test('prompt without --mock or --live fails with FLASH_MODE_REQUIRED', async () => {
    const result = await runPromptPipeline({ task: 'missing mode flag test', repoRoot: tmpRepo, mock: false });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FLASH_MODE_REQUIRED');
    expect(result.error.message).toMatch(/--mock.*--live|--live.*--mock/);
  });

  test('prompt --mock --live together fails FLASH_MODE_CONFLICT', async () => {
    const result = await runPromptPipeline({ task: 'conflict mode test', repoRoot: tmpRepo, mock: true, live: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FLASH_MODE_CONFLICT');
  });

  test('prompt --mock --json returns canonical success envelope', () => {
    const result = runCli(['prompt', 'canonical success envelope task', '--repo', tmpRepo, '--mock', '--json'], tmpRepo);

    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.run_id).toBeTruthy();
    expect(envelope.data.runDir).toBeTruthy();
    expect(envelope.data.finalPromptPath).toBeTruthy();
    expect(envelope.data.flash_input_path).toContain('flash_input.md');
    expect(envelope.data.repo_atlas_path).toContain('repo_atlas.generated.md');
    expect(envelope.data.task_slice_path).toContain('task_slice.md');
    expect(envelope.data.relevance_selection_path).toContain('relevance_selection.json');
    expect(envelope.data.flash_input_budget_path).toContain('flash_input_budget.json');
    expect(envelope.data.estimated_tokens).toBeGreaterThan(0);
    expect(envelope.data.hard_max_tokens).toBe(32000);
    expect(envelope.data.provider_called).toBe(true);
    expect(Array.isArray(envelope.artifacts)).toBe(true);
    expect(Array.isArray(envelope.warnings)).toBe(true);
  });

  test('prompt rejects removed --include-terminal-context flag', () => {
    const result = runCli(['prompt', 'removed terminal context flag task', '--repo', tmpRepo, '--mock', '--include-terminal-context'], tmpRepo);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown option');
    expect(result.stderr).toContain('--include-terminal-context');
  });

  test('FLASH_INPUT_BUDGET_EXCEEDED fails before adapter call and keeps provider_called false in budget artifact', async () => {
    vi.resetModules();
    const adapterRun = vi.fn();
    vi.doMock('../../../src/core/context/index.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/core/context/index.js')>('../../../src/core/context/index.js');
      const fsModule = await import('fs');
      const pathModule = await import('path');
      return {
        ...actual,
        buildCompactFlashContext: (opts: { runDir: string }) => {
          const budgetPath = pathModule.join(opts.runDir, 'flash', 'flash_input_budget.json');
          fsModule.mkdirSync(pathModule.dirname(budgetPath), { recursive: true });
          fsModule.writeFileSync(
            budgetPath,
            `${JSON.stringify({
              target_tokens: 24000,
              hard_max_tokens: 32000,
              estimated_tokens: 64001,
              estimated_chars: 256004,
              section_breakdown: [],
              included_sections: ['Task', 'Repo Atlas', 'Task Slice', 'Available Full Artifacts', 'Flash Instructions'],
              summarized_sections: ['Repo Atlas', 'Task Slice'],
              excluded_sections: ['full Symbols dump'],
              full_artifacts_referenced: ['scan/symbols.json'],
              provider_called: false,
              budget_status: 'FLASH_INPUT_BUDGET_EXCEEDED',
            }, null, 2)}\n`,
            'utf8',
          );
          throw new actual.FlashInputBudgetError(
            'flash_input.md estimated 64001 tokens exceeds hard max 32000',
            budgetPath,
            ['estimated_tokens=64001', 'hard_max_tokens=32000'],
          );
        },
      };
    });

    const { runPromptPipeline: runBudgetPipeline } = await import('../../../src/core/prompting/pipeline.js');
    const adapter: LlmAdapter = {
      run: adapterRun,
    };

    const result = await runBudgetPipeline({
      task: 'budget exceeded test',
      repoRoot: tmpRepo,
      mock: false,
      adapter,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FLASH_INPUT_BUDGET_EXCEEDED');
    expect(result.error.path).toContain('flash_input_budget.json');
    expect(adapterRun).not.toHaveBeenCalled();
    expect(fs.existsSync(result.error.path ?? '')).toBe(true);
    const budget = JSON.parse(fs.readFileSync(result.error.path!, 'utf8'));
    expect(budget.provider_called).toBe(false);

    vi.doUnmock('../../../src/core/context/index.js');
  });

  test('failure returns canonical error envelope', () => {
    const result = runCli(['prompt', 'canonical failure envelope task', '--repo', tmpRepo, '--json'], tmpRepo);

    expect(result.status).not.toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('FLASH_MODE_REQUIRED');
    expect(envelope.error.message).toMatch(/--mock.*--live|--live.*--mock/);
  });
});
