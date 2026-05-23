import fs from 'fs';
import os from 'os';
import path from 'path';

describe('DesktopPromptPreviewService', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-composer-preview-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Composer preview fixture\n', 'utf8');
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'hello.ts'), 'export const hello = "world";\n', 'utf8');
  });

  afterEach(() => {
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

    const savedFinal = fs.readFileSync(result.finalPromptPath, 'utf8');
    expect(result.finalPrompt).toBe(savedFinal);
    expect(result.finalPrompt).toContain(task);
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
});
