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
    const codegraph = read('docs/codegraph.md');
    const roadmap = read('docs/codegraph_mcp_roadmap.md');

    for (const doc of [readme, codegraph, roadmap]) {
      expect(doc).toContain('vibecode codegraph transport get --json');
      expect(doc).toContain('vibecode codegraph transport set cli|mcp|auto');
      expect(doc).toContain('vibecode codegraph transport reset');
      expect(doc).toContain('defaults.codegraph.transport');
      expect(doc).toContain('global user config');
      expect(doc).toContain('default = cli');
      expect(doc).toContain('prompt-level transport flags are intentionally not the primary UX');
    }

    expect(readme).toContain('GUI dropdown and CLI command both read/write');
    expect(codegraph).toContain('GUI remembers the setting by using global config, not localStorage');
    expect(roadmap).toContain('shared global setting');
    expect(codegraph).toContain('mcp` is strict: no fallback');
    expect(codegraph).toContain('auto` prefers MCP and falls back to CLI');
    expect(codegraph).toContain('detect-only` never calls CodeGraph context');
    expect(codegraph).toContain('scan/codegraph_usage.json');
  });
});
