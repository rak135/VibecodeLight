import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('Vibecode config ownership documentation', () => {
  test('core docs state root config.yaml is not Vibecode configuration', () => {
    const docs = [
      read('AGENTS.md'),
      read('README.md'),
      read('docs/CONTEXT.md'),
      read('docs/ARCHITECTURE.md'),
      read('docs/ARCHITECTURE_DECISIONS.md'),
    ];

    for (const doc of docs) {
      expect(doc).toContain('Never treat <repo>/config.yaml as Vibecode configuration');
      expect(doc).toContain('%LOCALAPPDATA%/vibecodelight/config.yaml');
      expect(doc).toContain('<repo>/.vibecode/config.yaml');
      expect(doc).toContain('root config.yaml belongs to the target project');
      expect(doc).toContain('Renderer localStorage');
    }
  });

  test('configuration docs distinguish local Vibecode config from root project config', () => {
    const readme = read('README.md');
    expect(readme).toContain('.vibecode/config.yaml can be initialized or synced from the global config');
    expect(readme).toContain('VibecodeLight must not create, read, write, or interpret <repo>/config.yaml as Vibecode settings');
    expect(readme).toContain('If root config.yaml appears in context, it is only a target project file');
  });
});
