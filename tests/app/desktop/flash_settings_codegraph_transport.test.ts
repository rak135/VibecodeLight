import * as fs from 'fs';
import * as path from 'path';

import FlashSettings from '../../../src/app/desktop/renderer/flash_settings.js';

const repoRoot = path.resolve(__dirname, '../../..');
const indexHtml = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer', 'index.html');
const flashSettingsJs = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer', 'flash_settings.js');

describe('desktop renderer CodeGraph transport shared global setting', () => {
  test('composer overlay exposes a CodeGraph Transport dropdown with CLI/MCP/Auto', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    expect(html).toContain('id="codegraph-transport-select"');
    expect(html).toMatch(/<option value="cli">CLI<\/option>/);
    expect(html).toMatch(/<option value="mcp">MCP<\/option>/);
    expect(html).toMatch(/<option value="auto">Auto<\/option>/);
  });

  test('loads transport from the preload config bridge, not localStorage', async () => {
    const configApi = {
      getCodeGraphTransportSetting: vi.fn().mockResolvedValue({ ok: true, transport: 'mcp' }),
    };
    const transport = await FlashSettings.loadCodeGraphTransportSetting(configApi);

    expect(transport).toBe('mcp');
    expect(configApi.getCodeGraphTransportSetting).toHaveBeenCalledTimes(1);
  });

  test('missing or failed preload config read falls back to cli without throwing', async () => {
    await expect(FlashSettings.loadCodeGraphTransportSetting({})).resolves.toBe('cli');
    await expect(FlashSettings.loadCodeGraphTransportSetting({
      getCodeGraphTransportSetting: vi.fn().mockRejectedValue(new Error('bridge down')),
    })).resolves.toBe('cli');
    await expect(FlashSettings.loadCodeGraphTransportSetting({
      getCodeGraphTransportSetting: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOPE', message: 'nope' } }),
    })).resolves.toBe('cli');
  });

  test('stale localStorage value is not read or allowed to override the bridge/global value', async () => {
    const storage = {
      getItem: vi.fn().mockReturnValue('auto'),
      setItem: vi.fn(),
    };
    const configApi = {
      getCodeGraphTransportSetting: vi.fn().mockResolvedValue({ ok: true, transport: 'mcp' }),
    };

    const transport = await FlashSettings.loadCodeGraphTransportSetting(configApi, storage);

    expect(transport).toBe('mcp');
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('changing transport writes through the preload config bridge and not localStorage', async () => {
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
    };
    const configApi = {
      setCodeGraphTransportSetting: vi.fn().mockResolvedValue({ ok: true, transport: 'auto' }),
    };

    const transport = await FlashSettings.writeCodeGraphTransportSetting(configApi, ' auto ', storage);

    expect(transport).toBe('auto');
    expect(configApi.setCodeGraphTransportSetting).toHaveBeenCalledWith('auto');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('failed transport write rejects so the UI can revert instead of pretending it saved', async () => {
    await expect(FlashSettings.writeCodeGraphTransportSetting({
      setCodeGraphTransportSetting: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'INVALID_CODEGRAPH_TRANSPORT', message: 'invalid' },
      }),
    }, 'mcp')).rejects.toThrow(/INVALID_CODEGRAPH_TRANSPORT/);
  });

  test('renderer glue calls the desktop config bridge methods and never writes the legacy localStorage key', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    const settings = fs.readFileSync(flashSettingsJs, 'utf8');

    expect(html).toContain('getCodeGraphTransportSetting');
    expect(html).toContain('setCodeGraphTransportSetting');
    expect(html).not.toMatch(/localStorage\.setItem\(\s*['"]vibecode\.codegraphTransport/);
    expect(settings).not.toMatch(/getItem\([^)]*vibecode\.codegraphTransport/);
  });

  test('runComposerPreview forwards the loaded global transport into the composer API (mock mode)', async () => {
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
    expect(composer.generatePreview).toHaveBeenCalledWith('transport mock', 'detect-only', false, 'auto', []);
    expect(composer.generatePreviewLive).not.toHaveBeenCalled();
    expect(outcome.codegraphTransport).toBe('auto');
  });

  test('runComposerPreview forwards the loaded global transport into the composer API (live mode)', async () => {
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
      [],
    );
    expect(outcome.codegraphTransport).toBe('mcp');
  });
});
