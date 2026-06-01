import * as fs from 'fs';
import * as path from 'path';

import FlashSettings from '../../../src/app/desktop/renderer/flash_settings.js';

const repoRoot = path.resolve(__dirname, '../../..');
const indexHtml = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer', 'index.html');
const flashSettingsJs = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer', 'flash_settings.js');

describe('desktop renderer pipeline toggle remembered settings', () => {
  test('CodeGraph mode loads from config bridge and stale localStorage does not override it', async () => {
    const storage = { getItem: vi.fn().mockReturnValue('1'), setItem: vi.fn() };
    const configApi = {
      getDesktopCodeGraphModeSetting: vi.fn().mockResolvedValue({ ok: true, mode: 'use-existing' }),
    };

    const mode = await FlashSettings.loadDesktopCodeGraphModeSetting(configApi, storage);

    expect(mode).toBe('use-existing');
    expect(configApi.getDesktopCodeGraphModeSetting).toHaveBeenCalledTimes(1);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('CodeGraph mode writes desktop.codegraph.mode through config bridge and rejects failed writes', async () => {
    const configApi = {
      setDesktopCodeGraphModeSetting: vi.fn().mockResolvedValue({ ok: true, mode: 'detect-only' }),
    };

    await expect(FlashSettings.writeDesktopCodeGraphModeSetting(configApi, 'detect-only')).resolves.toBe('detect-only');
    expect(configApi.setDesktopCodeGraphModeSetting).toHaveBeenCalledWith('detect-only');

    await expect(FlashSettings.writeDesktopCodeGraphModeSetting({
      setDesktopCodeGraphModeSetting: vi.fn().mockResolvedValue({ ok: false, error: { code: 'WRITE_FAILED', message: 'nope' } }),
    }, 'use-existing')).rejects.toThrow(/WRITE_FAILED/);
  });

  test('Task Normalizer loads from config bridge and stale localStorage does not override it', async () => {
    const storage = { getItem: vi.fn().mockReturnValue('1'), setItem: vi.fn() };
    const configApi = {
      getDesktopTaskNormalizerEnabledSetting: vi.fn().mockResolvedValue({ ok: true, enabled: false }),
    };

    const enabled = await FlashSettings.loadDesktopTaskNormalizerEnabledSetting(configApi, storage);

    expect(enabled).toBe(false);
    expect(configApi.getDesktopTaskNormalizerEnabledSetting).toHaveBeenCalledTimes(1);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('Task Normalizer writes desktop.task_normalizer.enabled through config bridge and rejects failed writes', async () => {
    const configApi = {
      setDesktopTaskNormalizerEnabledSetting: vi.fn().mockResolvedValue({ ok: true, enabled: true }),
    };

    await expect(FlashSettings.writeDesktopTaskNormalizerEnabledSetting(configApi, true)).resolves.toBe(true);
    expect(configApi.setDesktopTaskNormalizerEnabledSetting).toHaveBeenCalledWith(true);

    await expect(FlashSettings.writeDesktopTaskNormalizerEnabledSetting({
      setDesktopTaskNormalizerEnabledSetting: vi.fn().mockResolvedValue({ ok: false, error: { code: 'WRITE_FAILED', message: 'nope' } }),
    }, false)).rejects.toThrow(/WRITE_FAILED/);
  });

  test('Auto-approve loads and writes desktop.auto_approve.enabled through config bridge', async () => {
    const configApi = {
      getDesktopAutoApproveEnabledSetting: vi.fn().mockResolvedValue({ ok: true, enabled: true }),
      setDesktopAutoApproveEnabledSetting: vi.fn().mockResolvedValue({ ok: true, enabled: false }),
    };

    await expect(FlashSettings.loadDesktopAutoApproveEnabledSetting(configApi)).resolves.toBe(true);
    await expect(FlashSettings.writeDesktopAutoApproveEnabledSetting(configApi, false)).resolves.toBe(false);
    expect(configApi.getDesktopAutoApproveEnabledSetting).toHaveBeenCalledTimes(1);
    expect(configApi.setDesktopAutoApproveEnabledSetting).toHaveBeenCalledWith(false);
  });

  test('renderer glue initializes and saves all three remembered toggles through config bridge only', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    const settings = fs.readFileSync(flashSettingsJs, 'utf8');

    expect(html).toContain('loadDesktopCodeGraphMode');
    expect(html).toContain('saveDesktopCodeGraphMode');
    expect(html).toContain('loadDesktopTaskNormalizerEnabled');
    expect(html).toContain('saveDesktopTaskNormalizerEnabled');
    expect(html).toContain('loadDesktopAutoApproveEnabled');
    expect(html).toContain('saveDesktopAutoApproveEnabled');
    expect(html).not.toMatch(/localStorage\.(getItem|setItem)\(\s*['"]vibecode\.codegraph\.on/);
    expect(html).not.toMatch(/localStorage\.(getItem|setItem)\(\s*['"]vibelight\.taskNormalizerEnabled/);
    expect(settings).not.toMatch(/getItem\([^)]*vibecode\.codegraph\.on/);
    expect(settings).not.toMatch(/getItem\([^)]*vibelight\.taskNormalizerEnabled/);
  });

  test('preview/send continue to forward current UI toggle values explicitly', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');

    expect(html).toContain('codegraphMode: getCodeGraphMode()');
    expect(html).toContain('taskNormalizerEnabled: taskNormalizerEnabled()');
    expect(html).toContain('sendPreview(currentPreview.run_id, composerOriginSessionId, autoApproveEnabled())');
  });
});
