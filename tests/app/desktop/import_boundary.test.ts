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

describe('desktop import boundaries', () => {
  test('desktop modules do not import scanner/context/prompting/skills internals directly', () => {
    const files = collectTypeScriptFiles(desktopRoot);
    expect(files.length).toBeGreaterThan(0);

    const forbiddenImport = /from\s+['"][^'"]*(core\/(scanning|context|prompting|skills)|scanner|context\/|prompting\/|skills\/)[^'"]*['"]/;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, `${path.relative(repoRoot, file)} imports forbidden core internals`).not.toMatch(forbiddenImport);
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
