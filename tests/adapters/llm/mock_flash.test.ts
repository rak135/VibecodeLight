import fs from 'fs';
import os from 'os';
import path from 'path';

import { MockFlashAdapter } from '../../../src/adapters/llm/mock_flash';
import { parseFlashOutput } from '../../../src/core/context/markdown_flash_output_parser';

function makeRun(workspaceRoot: string, runId = '20260101-000000-mock') {
  const runDir = path.join(workspaceRoot, '.vibecode', 'runs', runId);
  const flashDir = path.join(runDir, 'flash');
  fs.mkdirSync(flashDir, { recursive: true });
  fs.writeFileSync(path.join(flashDir, 'flash_input.md'), '# Flash Input\n\nMock task input\n', 'utf8');
  return { runId, runDir, flashDir };
}

function flashInput(args: { flashDir: string; runId: string; workspaceRoot: string }) {
  return {
    flashInputMd: '',
    systemPrompt: 'test system prompt',
    flashDir: args.flashDir,
    runId: args.runId,
    workspaceRoot: args.workspaceRoot,
  };
}

describe('MockFlashAdapter', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mock-flash-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test('mock flash adapter produces valid flash_output.md', async () => {
    const { runId, flashDir } = makeRun(workspaceRoot);
    const adapter = new MockFlashAdapter();

    const result = await adapter.run(flashInput({ flashDir, runId, workspaceRoot }));

    const outputPath = path.join(flashDir, 'flash_output.md');
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(result.flashOutputMd);
    expect(result.flashOutputMd).toContain('# Task Summary');
    expect(result.flashOutputMd).toContain('# Context Pack');
  });

  test('produced flash_output.md passes markdown flash output parser', async () => {
    const { runId, flashDir } = makeRun(workspaceRoot);
    const adapter = new MockFlashAdapter();

    await adapter.run(flashInput({ flashDir, runId, workspaceRoot }));

    const outputPath = path.join(flashDir, 'flash_output.md');
    const parsed = parseFlashOutput(fs.readFileSync(outputPath, 'utf8'), outputPath);
    expect(parsed.ok).toBe(true);
  });

  test('flash_output_meta.json is written and stable', async () => {
    const { runId, flashDir } = makeRun(workspaceRoot);
    const adapter = new MockFlashAdapter();

    await adapter.run(flashInput({ flashDir, runId, workspaceRoot }));
    const first = fs.readFileSync(path.join(flashDir, 'flash_output_meta.json'), 'utf8');

    await adapter.run(flashInput({ flashDir, runId, workspaceRoot }));
    const second = fs.readFileSync(path.join(flashDir, 'flash_output_meta.json'), 'utf8');

    expect(second).toBe(first);
    expect(JSON.parse(first)).toEqual({
      selected_skills: [],
      relevant_files: ['README.md'],
      files_to_read_with_tools: ['README.md'],
      relevant_tests: ['pnpm test'],
      commands_to_run: ['pnpm test'],
      cautions: ['mock adapter output; do not treat as live model result'],
      warnings: [],
    });
  });

  test('tool_calls.json is written', async () => {
    const { runId, flashDir } = makeRun(workspaceRoot);
    const adapter = new MockFlashAdapter();

    const result = await adapter.run(flashInput({ flashDir, runId, workspaceRoot }));

    const calls = JSON.parse(fs.readFileSync(path.join(flashDir, 'tool_calls.json'), 'utf8'));
    expect(calls).toEqual(result.toolCalls);
    expect(Array.isArray(calls)).toBe(true);
  });

  test('mock adapter does not call real provider', async () => {
    const { runId, flashDir } = makeRun(workspaceRoot);
    process.env.VIBECODE_PROVIDER = 'provider-that-must-not-be-called';
    process.env.VIBECODE_API_KEY = 'not-a-real-key';
    delete process.env.VIBECODE_FLASH_PROVIDER;
    delete process.env.VIBECODE_FLASH_API_KEY;
    delete process.env.VIBECODE_FLASH_MODEL;
    delete process.env.VIBECODE_FLASH_BASE_URL;
    const adapter = new MockFlashAdapter();

    const result = await adapter.run(flashInput({ flashDir, runId, workspaceRoot }));

    expect(result.meta.provider).toBe('mock');
    expect(result.meta.live).toBe(false);
    delete process.env.VIBECODE_PROVIDER;
    delete process.env.VIBECODE_API_KEY;
  });

  test('mock fails clearly if latest run has no flash_input.md', async () => {
    const runId = '20260101-000000-empty';
    fs.mkdirSync(path.join(workspaceRoot, '.vibecode', 'runs', runId, 'flash'), { recursive: true });
    const adapter = new MockFlashAdapter();

    await expect(adapter.run(flashInput({ flashDir: path.join(workspaceRoot, '.vibecode', 'runs', runId, 'flash'), runId, workspaceRoot }))).rejects.toThrow(/flash_input\.md/i);
  });

  test('uses the orchestration-supplied flashDir for flash artifacts', async () => {
    const runId = '20260101-000000-supplied-flash-dir';
    const flashDir = path.join(workspaceRoot, 'run-package', 'flash');
    fs.mkdirSync(flashDir, { recursive: true });
    fs.writeFileSync(path.join(flashDir, 'flash_input.md'), '# Flash Input\n\nSupplied flash dir input\n', 'utf8');
    const adapter = new MockFlashAdapter();

    const result = await adapter.run(flashInput({ flashDir, runId, workspaceRoot }));

    expect(fs.existsSync(path.join(flashDir, 'flash_output.md'))).toBe(true);
    expect(fs.readFileSync(path.join(flashDir, 'flash_output.md'), 'utf8')).toBe(result.flashOutputMd);
    expect(fs.existsSync(path.join(workspaceRoot, '.vibecode', 'runs', runId, 'flash', 'flash_output.md'))).toBe(false);
  });
});
