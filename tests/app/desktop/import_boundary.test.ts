import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const desktopRoot = path.join(repoRoot, 'src', 'app', 'desktop');

function collectTypeScriptFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
    } else if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

// prompt_preview_service.ts is the single documented gateway between the
// desktop main process and the core prompt pipeline. It is intentionally
// allowed to import from core/prompting; the renderer never imports it.
const GATEWAY_FILES = new Set(['prompt_preview_service.ts', 'skills_bridge.ts']);

describe('desktop import boundaries', () => {
  test('desktop modules do not import scanner/context/prompting/skills internals directly', () => {
    const files = collectTypeScriptFiles(desktopRoot);
    expect(files.length).toBeGreaterThan(0);

    const forbiddenImport = /from\s+['"][^'"]*(core\/(scanning|context|prompting|skills)|scanner|context\/|prompting\/|skills\/)[^'"]*['"]/;
    for (const file of files) {
      if (GATEWAY_FILES.has(path.basename(file))) continue;
      const source = fs.readFileSync(file, 'utf8');
      expect(source, `${path.relative(repoRoot, file)} imports forbidden core internals`).not.toMatch(forbiddenImport);
    }
  });

  test('renderer scripts do not require/import Node fs or child_process', () => {
    const rendererDir = path.join(desktopRoot, 'renderer');
    const htmlFiles: string[] = [];
    if (fs.existsSync(rendererDir)) {
      for (const entry of fs.readdirSync(rendererDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.html')) {
          htmlFiles.push(path.join(rendererDir, entry.name));
        }
      }
    }
    expect(htmlFiles.length).toBeGreaterThan(0);
    for (const file of htmlFiles) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, `${path.relative(repoRoot, file)} must not use Node require`).not.toMatch(/\brequire\(\s*['"]fs['"]\s*\)/);
      expect(source, `${path.relative(repoRoot, file)} must not use Node require`).not.toMatch(/\brequire\(\s*['"]child_process['"]\s*\)/);
      expect(source, `${path.relative(repoRoot, file)} must not import scanner internals`).not.toMatch(
        /from\s+['"][^'"]*core\/(scanning|context|prompting|skills)[^'"]*['"]/,
      );
    }
  });

  test('renderer does not parse config files directly', () => {
    const rendererDir = path.join(desktopRoot, 'renderer');
    const htmlFiles: string[] = [];
    if (fs.existsSync(rendererDir)) {
      for (const entry of fs.readdirSync(rendererDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.html')) {
          htmlFiles.push(path.join(rendererDir, entry.name));
        }
      }
    }
    expect(htmlFiles.length).toBeGreaterThan(0);
    for (const file of htmlFiles) {
      const source = fs.readFileSync(file, 'utf8');
      // The renderer must only display config data returned by core via the
      // preload contextBridge; it must never read or parse config files itself.
      expect(source, `${path.relative(repoRoot, file)} must not import core/config`).not.toMatch(/core\/config/);
      expect(source, `${path.relative(repoRoot, file)} must not parse YAML`).not.toMatch(/YAML\.parse|require\(\s*['"]yaml['"]\s*\)|from\s+['"]yaml['"]/);
      expect(source, `${path.relative(repoRoot, file)} must not read config.yaml`).not.toMatch(/config\.yaml/);
    }
  });

  test('terminal demo core remains importable', async () => {
    const terminal = await import('../../../src/core/terminal/terminal_demo.js');
    expect(typeof terminal.runTerminalDemo).toBe('function');
  });

  test('full mock prompt pipeline core remains importable', async () => {
    const prompting = await import('../../../src/core/prompting/pipeline.js');
    expect(typeof prompting.runPromptPipeline).toBe('function');
  });
});
