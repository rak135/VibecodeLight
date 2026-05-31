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

describe('desktop renderer CodeGraph transport (Phase 1B)', () => {
  test('composer overlay exposes a CodeGraph Transport dropdown with CLI/MCP/Auto', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    expect(html).toContain('id="codegraph-transport-select"');
    expect(html).toMatch(/<option value="cli">CLI<\/option>/);
    expect(html).toMatch(/<option value="mcp">MCP<\/option>/);
    expect(html).toMatch(/<option value="auto">Auto<\/option>/);
  });

  test('uses the shared storage key vibecode.codegraphTransport', () => {
    expect(FlashSettings.CODEGRAPH_TRANSPORT_STORAGE_KEY).toBe('vibecode.codegraphTransport');
  });

  test('default transport is cli when nothing persisted', () => {
    const storage = fakeStorage();
    expect(FlashSettings.readCodeGraphTransport(storage)).toBe('cli');
  });

  test('invalid persisted value falls back to cli', () => {
    const storage = fakeStorage();
    storage.setItem('vibecode.codegraphTransport', 'rubbish');
    expect(FlashSettings.readCodeGraphTransport(storage)).toBe('cli');
  });

  test('writeCodeGraphTransport normalizes and persists the selection', () => {
    const storage = fakeStorage();
    expect(FlashSettings.writeCodeGraphTransport(storage, 'MCP')).toBe('mcp');
    expect(FlashSettings.readCodeGraphTransport(storage)).toBe('mcp');
    expect(FlashSettings.writeCodeGraphTransport(storage, ' auto ')).toBe('auto');
    expect(FlashSettings.readCodeGraphTransport(storage)).toBe('auto');
    expect(FlashSettings.writeCodeGraphTransport(storage, 'cli')).toBe('cli');
    expect(FlashSettings.readCodeGraphTransport(storage)).toBe('cli');
  });

  test('runComposerPreview forwards the persisted transport into the composer API (mock mode)', async () => {
    const composer = {
      generatePreview: vi.fn().mockResolvedValue({ ok: true }),
      generatePreviewLive: vi.fn().mockResolvedValue({ ok: true }),
    };
    const outcome = await FlashSettings.runComposerPreview({
      composer,
      mode: 'mock',
      task: 'transport mock',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      providerList: [{
        id: 'openrouter',
        label: 'OpenRouter',
        hasApiKey: true,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', role: 'flash' }],
      }],
      codegraphTransport: 'auto',
    });
    expect(composer.generatePreview).toHaveBeenCalledWith('transport mock', 'detect-only', false, 'auto');
    expect(composer.generatePreviewLive).not.toHaveBeenCalled();
    expect(outcome.codegraphTransport).toBe('auto');
  });

  test('runComposerPreview forwards the persisted transport into the composer API (live mode)', async () => {
    const composer = {
      generatePreview: vi.fn().mockResolvedValue({ ok: true }),
      generatePreviewLive: vi.fn().mockResolvedValue({ ok: true }),
    };
    const outcome = await FlashSettings.runComposerPreview({
      composer,
      mode: 'live',
      task: 'transport live',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      providerList: [{
        id: 'openrouter',
        label: 'OpenRouter',
        hasApiKey: true,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', role: 'flash' }],
      }],
      codegraphMode: 'use-existing',
      codegraphTransport: 'mcp',
    });
    expect(composer.generatePreviewLive).toHaveBeenCalledWith(
      'transport live',
      'openrouter',
      'deepseek/deepseek-chat',
      'use-existing',
      false,
      'mcp',
    );
    expect(outcome.codegraphTransport).toBe('mcp');
  });

  test('unrecognized transport values normalize to cli before being forwarded', async () => {
    const composer = {
      generatePreview: vi.fn().mockResolvedValue({ ok: true }),
      generatePreviewLive: vi.fn().mockResolvedValue({ ok: true }),
    };
    await FlashSettings.runComposerPreview({
      composer,
      mode: 'mock',
      task: 'guard',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      providerList: [{
        id: 'openrouter',
        label: 'OpenRouter',
        hasApiKey: true,
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', role: 'flash' }],
      }],
      codegraphTransport: 'nope',
    });
    expect(composer.generatePreview).toHaveBeenCalledWith('guard', 'detect-only', false, 'cli');
  });
});
