import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('CodeGraph transport CLI parity docs', () => {
  test('README and CodeGraph docs document settings-driven CLI transport selection', () => {
    const readme = read('README.md');
    expect(readme).toContain('vibecode codegraph transport get --json');
    expect(readme).toContain('vibecode codegraph transport set cli|mcp|auto');
    expect(readme).toContain('vibecode codegraph transport reset');
    expect(readme).toContain('defaults.codegraph.transport');
    expect(readme).toContain('global user config');
    expect(readme).toContain('default = cli');
    expect(readme).toContain('prompt-level transport flags are intentionally not the primary UX');
    expect(readme).toContain('GUI dropdown and CLI command both read/write');
  });
});
