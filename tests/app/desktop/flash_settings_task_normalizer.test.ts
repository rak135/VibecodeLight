import * as fs from 'fs';
import * as path from 'path';

import FlashSettings from '../../../src/app/desktop/renderer/flash_settings.js';

const repoRoot = path.resolve(__dirname, '../../..');
const indexHtml = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer', 'index.html');

function fakeStorage() {
  const backing = new Map<string, string>();
  return {
    getItem(key: string) {
      return backing.has(key) ? backing.get(key) ?? null : null;
    },
    setItem(key: string, value: string) {
      backing.set(key, value);
    },
  };
}

describe('desktop renderer task normalizer switch', () => {
  test('Task Normalizer switch exists in the composer UI without description copy', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');

    expect(html).toContain('id="task-normalizer-toggle"');
    expect(html).toContain('Task Normalizer');
    expect(html).not.toContain('id="task-normalizer-helper"');
    expect(html).not.toContain('Translates and expands your task into English search hints before context selection. Does not select files.');
  });

  test('Task Normalizer switch defaults to OFF', () => {
    const storage = fakeStorage();

    expect(FlashSettings.readTaskNormalizerEnabled(storage)).toBe(false);
  });

  test('Task Normalizer switch persists ON/OFF state', () => {
    const storage = fakeStorage();

    FlashSettings.writeTaskNormalizerEnabled(storage, true);
    expect(FlashSettings.readTaskNormalizerEnabled(storage)).toBe(true);

    FlashSettings.writeTaskNormalizerEnabled(storage, false);
    expect(FlashSettings.readTaskNormalizerEnabled(storage)).toBe(false);
  });

  test('when Task Normalizer is ON, generatePreview is called with taskNormalizerEnabled=true', async () => {
    const composer = {
      generatePreview: vi.fn().mockResolvedValue({ ok: true, run_id: 'r-mock', finalPrompt: 'mock prompt' }),
      generatePreviewLive: vi.fn().mockResolvedValue({ ok: true, run_id: 'r-live', finalPrompt: 'live prompt' }),
    };

    await FlashSettings.runComposerPreview({
      composer,
      mode: 'mock',
      task: 'normalize in desktop',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      providerList: [{
        id: 'openrouter',
        label: 'OpenRouter',
        hasApiKey: true,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', role: 'flash' }],
      }],
      taskNormalizerEnabled: true,
    });

    expect(composer.generatePreview).toHaveBeenCalledWith('normalize in desktop', 'detect-only', true);
  });
});