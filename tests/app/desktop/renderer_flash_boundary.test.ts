import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const rendererDir = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer');
const flashSettingsJs = path.join(rendererDir, 'flash_settings.js');
const indexHtml = path.join(rendererDir, 'index.html');

describe('renderer flash settings module stays a thin view layer', () => {
  test('flash_settings.js exists and is plain renderer JS', () => {
    expect(fs.existsSync(flashSettingsJs)).toBe(true);
  });

  test('flash_settings.js does not use Node fs or child_process', () => {
    const source = fs.readFileSync(flashSettingsJs, 'utf8');
    expect(source).not.toMatch(/\brequire\(\s*['"]fs['"]\s*\)/);
    expect(source).not.toMatch(/\brequire\(\s*['"]child_process['"]\s*\)/);
    expect(source).not.toMatch(/from\s+['"]fs['"]/);
    expect(source).not.toMatch(/from\s+['"]child_process['"]/);
  });

  test('flash_settings.js does not parse YAML', () => {
    const source = fs.readFileSync(flashSettingsJs, 'utf8');
    expect(source).not.toMatch(/YAML\.parse|require\(\s*['"]yaml['"]\s*\)|from\s+['"]yaml['"]/);
  });

  test('flash_settings.js does not parse .env or read config files', () => {
    const source = fs.readFileSync(flashSettingsJs, 'utf8');
    expect(source).not.toMatch(/config\.yaml/);
    expect(source).not.toMatch(/readFileSync|readFile\(/);
    // No .env parsing/reading of any kind.
    expect(source).not.toMatch(/loadEnvFile|parseEnvContent/);
    expect(source).not.toMatch(/process\.env/);
  });

  test('flash_settings.js does not import core config or scanner internals', () => {
    const source = fs.readFileSync(flashSettingsJs, 'utf8');
    expect(source).not.toMatch(/core\/config/);
    expect(source).not.toMatch(/from\s+['"][^'"]*core\/(scanning|context|prompting|skills)[^'"]*['"]/);
  });
});

describe('renderer index.html wires the flash settings GUI', () => {
  test('loads the flash_settings.js view module', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    expect(html).toMatch(/flash_settings\.js/);
    expect(html).toMatch(/VibecodeFlashSettings/);
  });

  test('renders a header flash status pill element', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    expect(html).toMatch(/id="flash-pill"/);
  });

  test('exposes a settings panel with sync and provider/model areas', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    expect(html).toMatch(/id="sync-from-global"/);
    expect(html).toMatch(/id="sync-to-global"/);
    expect(html).toMatch(/id="flash-providers"/);
    expect(html).toMatch(/id="flash-settings-rows"/);
  });

  test('exposes composer flash provider/model selection', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    expect(html).toMatch(/id="composer-flash-provider"/);
    expect(html).toMatch(/id="composer-flash-model"/);
  });

  test('does not parse config files itself (delegates to preload/core)', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    expect(html).not.toMatch(/YAML\.parse|from\s+['"]yaml['"]/);
    expect(html).not.toMatch(/config\.yaml/);
    expect(html).not.toMatch(/core\/config/);
  });
});
