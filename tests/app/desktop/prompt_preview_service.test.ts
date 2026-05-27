import fs from 'fs';
import os from 'os';
import path from 'path';

describe('DesktopPromptPreviewService', () => {
  let tmpRepo: string;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('../../../src/core/prompting/pipeline.js');
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-composer-preview-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Composer preview fixture\n', 'utf8');
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'hello.ts'), 'export const hello = "world";\n', 'utf8');
  });

  afterEach(() => {
    vi.doUnmock('../../../src/core/prompting/pipeline.js');
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('rejects empty task with structured diagnostic without creating a run', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');

    const result = await generatePromptPreview({ task: '   ', repoRoot: tmpRepo });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TASK_REQUIRED');
    expect(result.error.message).toMatch(/task/i);
    expect(Array.isArray(result.error.details)).toBe(true);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'runs'))).toBe(false);
  });

  test('calls full mock prompt pipeline and returns run metadata + saved final_prompt content', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');

    const task = 'composer preview generates final prompt';
    const result = await generatePromptPreview({ task, repoRoot: tmpRepo });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(typeof result.run_id).toBe('string');
    expect(result.run_id.length).toBeGreaterThan(0);
    expect(result.runDir).toBe(path.join(tmpRepo, '.vibecode', 'runs', result.run_id));
    expect(result.finalPromptPath).toBe(
      path.join(tmpRepo, '.vibecode', 'runs', result.run_id, 'output', 'final_prompt.md'),
    );
    expect(result.contextPackPath).toBe(
      path.join(tmpRepo, '.vibecode', 'runs', result.run_id, 'output', 'context_pack.md'),
    );
    expect(result.selectedSkillsPath).toBe(
      path.join(tmpRepo, '.vibecode', 'runs', result.run_id, 'skills', 'selected_skills.json'),
    );
    expect(result.terminalSend).toBe('not_sent');
    expect(result.flashOutputPath).toBe(
      path.join(tmpRepo, '.vibecode', 'runs', result.run_id, 'flash', 'flash_output.md'),
    );
    const flashOutputPath = result.flashOutputPath;
    expect(flashOutputPath).toBeDefined();
    if (!flashOutputPath) return;
    expect(result.flashOutputContent).toBe(fs.readFileSync(flashOutputPath, 'utf8'));
    expect(result.flashOutputContent).toContain('# Relevant Files');

    const savedFinal = fs.readFileSync(result.finalPromptPath, 'utf8');
    expect(result.finalPrompt).toBe(savedFinal);
    expect(result.finalPrompt).toContain(task);
    expect(result.flashInputPath).toBe(
      path.join(tmpRepo, '.vibecode', 'runs', result.run_id, 'flash', 'flash_input.md'),
    );
    expect(result.repoAtlasPath).toBe(
      path.join(tmpRepo, '.vibecode', 'index', 'repo_atlas.generated.md'),
    );
    expect(result.taskSlicePath).toBe(
      path.join(tmpRepo, '.vibecode', 'runs', result.run_id, 'flash', 'task_slice.md'),
    );
    expect(result.relevanceSelectionPath).toBe(
      path.join(tmpRepo, '.vibecode', 'runs', result.run_id, 'flash', 'relevance_selection.json'),
    );
    expect(result.flashInputBudgetPath).toBe(
      path.join(tmpRepo, '.vibecode', 'runs', result.run_id, 'flash', 'flash_input_budget.json'),
    );
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.hardMaxTokens).toBe(32000);
    expect(result.providerCalled).toBe(true);
    expect(result.budgetStatus).toBe('ok');
  });

  test('returns a real flash context summary parsed from run artifacts', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');

    const result = await generatePromptPreview({ task: 'context summary regression', repoRoot: tmpRepo });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context).toBeDefined();
    // The deterministic mock flash output drives these lists.
    expect(result.context.relevant_files).toContain('README.md');
    expect(result.context.commands_to_run).toContain('pnpm test');
    expect(result.context.cautions.length).toBeGreaterThan(0);
    expect(Array.isArray(result.context.selected_skills)).toBe(true);
  });

  test('preview text equals contents of saved final_prompt.md (no hidden mutation)', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');

    const result = await generatePromptPreview({
      task: 'preview must equal saved final prompt',
      repoRoot: tmpRepo,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const onDisk = fs.readFileSync(result.finalPromptPath, 'utf8');
    expect(result.finalPrompt).toEqual(onDisk);

    // Touch the saved file would only happen through pipeline; reading again must still match.
    const onDiskAgain = fs.readFileSync(result.finalPromptPath, 'utf8');
    expect(result.finalPrompt).toEqual(onDiskAgain);
  });

  test('composer preview does not create terminal/send_metadata.json or after/ artifacts', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');

    const result = await generatePromptPreview({
      task: 'composer preview does not send to terminal',
      repoRoot: tmpRepo,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sendMetadataPath = path.join(result.runDir, 'terminal', 'send_metadata.json');
    expect(fs.existsSync(sendMetadataPath)).toBe(false);
    const currentSendMetadata = path.join(tmpRepo, '.vibecode', 'current', 'send_metadata.json');
    expect(fs.existsSync(currentSendMetadata)).toBe(false);

    const afterDir = path.join(result.runDir, 'after');
    expect(fs.existsSync(afterDir)).toBe(false);
  });

  test('generatePromptPreview uses explicit repoRoot not process.cwd()', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');

    const result = await generatePromptPreview({ task: 'explicit repo root regression', repoRoot: tmpRepo });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.runDir.startsWith(tmpRepo)).toBe(true);
    expect(result.runDir.startsWith(process.cwd())).toBe(false);
    expect(result.runDir).toContain(path.join(tmpRepo, '.vibecode', 'runs'));
  });

  test('attaches the core-derived CodeGraph detect-only status (informational, not used for context)', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const { readRunCodeGraphStatus } = await import('../../../src/core/scanning/codegraph_status.js');

    const result = await generatePromptPreview({ task: 'codegraph status surfaced in composer', repoRoot: tmpRepo });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The status is present and equals the shared core reader's view of the same
    // run — the service does not re-derive or re-detect anything itself.
    expect(result.codegraph).toBeDefined();
    expect(result.codegraph).toEqual(readRunCodeGraphStatus(result.runDir));

    // Detection always records detect-only mode; state is one of the known states.
    expect(result.codegraph.mode).toBe('detect-only');
    expect(['ready', 'installed-not-initialized', 'not-installed', 'unknown']).toContain(result.codegraph.state);

    // Default is still detect-only: CodeGraph is not automatically used.
    expect(result.codegraph.usedForContext).toBe(false);
    expect(result.codegraph.usageNote.toLowerCase()).toContain('detect-only');
    expect(Object.keys(result.codegraph)).not.toContain('enabled');
  });

  test('passes selected CodeGraph context mode to the prompt pipeline', async () => {
    const runDir = path.join(tmpRepo, '.vibecode', 'runs', '20260525_000001');
    const finalPromptPath = path.join(runDir, 'output', 'final_prompt.md');
    fs.mkdirSync(path.dirname(finalPromptPath), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
    fs.writeFileSync(finalPromptPath, '# Final Prompt\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'scan', 'external_tools.json'), JSON.stringify({ tools: { codegraph: { available: true, initialized: true, mode: 'use-existing', used_for_context: true, context_artifact: 'scan/codegraph_context.md', warnings: [] } } }), 'utf8');
    fs.writeFileSync(path.join(runDir, 'scan', 'codegraph_usage.json'), JSON.stringify({ mode: 'use-existing', used: true, reason: 'EXISTING_INDEX', artifact: 'scan/codegraph_context.md', warnings: [] }), 'utf8');
    const runPromptPipeline = vi.fn().mockResolvedValue({
      ok: true,
      run_id: '20260525_000001',
      runDir,
      finalPromptPath,
      flashInputPath: path.join(runDir, 'flash', 'flash_input.md'),
      providerCalled: true,
      artifacts: [],
      warnings: [],
    });
    vi.doMock('../../../src/core/prompting/pipeline.js', () => ({ runPromptPipeline }));

    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const result = await generatePromptPreview({ task: 'use codegraph', repoRoot: tmpRepo, codegraphMode: 'use-existing' });

    expect(runPromptPipeline).toHaveBeenCalledWith(expect.objectContaining({ codegraphMode: 'use-existing' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.codegraph.mode).toBe('use-existing');
    expect(result.codegraph.usedForContext).toBe(true);
  });

  test('error result includes providerErrorPath when provider_error.json exists in artifacts list', async () => {
    const providerErrorPath = path.join(tmpRepo, '.vibecode', 'runs', '2026-05-24_001', 'flash', 'provider_error.json');
    vi.doMock('../../../src/core/prompting/pipeline.js', () => ({
      runPromptPipeline: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'FLASH_PROVIDER_BAD_RESPONSE',
          message: 'bad provider response',
          path: providerErrorPath,
          details: ['response could not be parsed'],
          artifacts: [providerErrorPath],
        },
      }),
    }));

    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const result = await generatePromptPreview({ task: 'provider error path', repoRoot: tmpRepo, flashMode: 'live' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.providerErrorPath).toBe(providerErrorPath);
    expect(result.artifacts).toEqual([providerErrorPath]);
  });
});
