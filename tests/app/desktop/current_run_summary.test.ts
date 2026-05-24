// tests/app/desktop/current_run_summary.test.ts
// Tests for current-run summary behavior after preview and send

import fs from 'fs';
import os from 'os';
import path from 'path';

describe('current run summary', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-run-summary-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# test\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('preview result contains run_id and all artifact paths', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const result = await generatePromptPreview({ task: 'summary test', repoRoot: tmpRepo });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.run_id).toBe('string');
    expect(result.run_id.length).toBeGreaterThan(0);
    expect(result.runDir).toContain(result.run_id);
    expect(result.finalPromptPath).toContain('final_prompt.md');
    expect(result.contextPackPath).toContain('context_pack.md');
    expect(result.selectedSkillsPath).toContain('selected_skills.json');
  });

  test('preview result has terminalSend not_sent before send', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const result = await generatePromptPreview({ task: 'not sent check', repoRoot: tmpRepo });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.terminalSend).toBe('not_sent');
  });

  test('preview content equals contents of saved final_prompt.md', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const result = await generatePromptPreview({ task: 'invariant check', repoRoot: tmpRepo });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const saved = fs.readFileSync(result.finalPromptPath, 'utf8');
    expect(result.finalPrompt).toBe(saved);
  });

  test('send result has terminalSend sent and sendMetadataPath after send', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');

    const preview = await generatePromptPreview({ task: 'send status check', repoRoot: tmpRepo });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const fakeService = {
      writes: [] as string[],
      writeInput(data: string) { this.writes.push(data); },
      getActiveSessionInfo() {
        return { sessionId: 'sess-1', cwd: tmpRepo, pid: 1234, shell: 'bash' };
      },
    };

    const send = await sendFinalPromptForRun({
      runId: preview.run_id,
      repoRoot: tmpRepo,
      terminalService: fakeService as any,
    });

    expect(send.ok).toBe(true);
    if (!send.ok) return;
    expect(send.terminalSend).toBe('sent');
    expect(send.sendMetadataPath).toContain('send_metadata.json');
    expect(fs.existsSync(send.sendMetadataPath)).toBe(true);
    expect(send.metadata.transfer_mode).toBe('bracketed_paste_chunked');
    expect(send.metadata.bracketed_paste).toBe(true);
  });

  test('send reads saved final_prompt.md not UI text', async () => {
    // Send service must read from disk - verify what was written matches what was sent
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');

    const preview = await generatePromptPreview({ task: 'disk read check', repoRoot: tmpRepo });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const writes: string[] = [];
    const fakeService = {
      writeInput(data: string) { writes.push(data); },
      getActiveSessionInfo() {
        return { sessionId: 'sess-2', cwd: tmpRepo, pid: 999, shell: 'bash' };
      },
    };

    await sendFinalPromptForRun({ runId: preview.run_id, repoRoot: tmpRepo, terminalService: fakeService as any });

    const savedContent = fs.readFileSync(preview.finalPromptPath, 'utf8');
    const allWritten = writes.join('');
    // The sent content should include the saved file content
    expect(allWritten).toContain(savedContent.trim());
    expect(allWritten).toContain('\u001b[200~');
    expect(allWritten).toContain('\u001b[201~');
  });

  test('no terminal_context.json created after preview and send', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');

    const preview = await generatePromptPreview({ task: 'no context artifact', repoRoot: tmpRepo });
    if (!preview.ok) return;

    const fakeService = {
      writeInput(_d: string) {},
      getActiveSessionInfo() { return { sessionId: 's3', cwd: tmpRepo, pid: 1, shell: 'sh' }; },
    };
    await sendFinalPromptForRun({ runId: preview.run_id, repoRoot: tmpRepo, terminalService: fakeService as any });

    expect(fs.existsSync(path.join(preview.runDir, 'terminal', 'terminal_context.json'))).toBe(false);
    expect(fs.existsSync(path.join(preview.runDir, 'terminal', 'terminal_excerpt_after.md'))).toBe(false);
    expect(fs.existsSync(path.join(preview.runDir, 'after'))).toBe(false);
  });

  test('no after/ directory created after send', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const { sendFinalPromptForRun } = await import('../../../src/app/desktop/prompt_send_service.js');

    const preview = await generatePromptPreview({ task: 'no after dir', repoRoot: tmpRepo });
    if (!preview.ok) return;

    const fakeService = {
      writeInput(_d: string) {},
      getActiveSessionInfo() { return { sessionId: 's4', cwd: tmpRepo, pid: 2, shell: 'sh' }; },
    };
    await sendFinalPromptForRun({ runId: preview.run_id, repoRoot: tmpRepo, terminalService: fakeService as any });

    expect(fs.existsSync(path.join(preview.runDir, 'after'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'runs', preview.run_id, 'terminal', 'terminal_excerpt_after.md'))).toBe(false);
  });
});
