import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('desktop remembered settings documentation', () => {
  test('README documents desktop.* remembered settings and CLI explicit flags', () => {
    const readme = read('README.md');

    expect(readme).toContain('desktop.codegraph.mode');
    expect(readme).toContain('desktop.task_normalizer.enabled');
    expect(readme).toContain('desktop.auto_approve.enabled');
    expect(readme).toContain('defaults.codegraph.transport');
    expect(readme).toContain('Renderer localStorage is not the source of truth');
    expect(readme).toContain('CLI remains explicit');
    expect(readme).toContain('--auto-approve');
  });

  test('README documents auto-approve safety and CodeGraph transport exception', () => {
    const combined = read('README.md');

    expect(combined).toContain('desktop.*');
    expect(combined).toContain('desktop.auto_approve.enabled');
    expect(combined).toContain('safety-sensitive');
    expect(combined).toContain('CLI remains explicit');
    expect(combined).toContain('defaults.codegraph.transport');
    expect(combined).toContain('Renderer localStorage is not the source of truth');
  });
});
