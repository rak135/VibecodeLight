import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_SCAN_SUMMARY_SECTIONS,
  SCAN_SUMMARY_MAX_ITEMS,
  getScanSummary,
  type ScanSummaryResult,
} from '../../../src/core/runs/scan_summary.js';

/**
 * Phase 1B-2: bounded scan summary.
 *
 * Pins that the summary projects real scanner artifact shapes into compact,
 * counted, bounded sections; never includes source/instruction file contents;
 * degrades gracefully on a missing scan dir or a missing/parse-broken artifact;
 * and rejects unknown sections / out-of-range max_items.
 */

function makeScanRun(prefix: string, files: Record<string, string>): { runDir: string; cleanup: () => void } {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(runDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return { runDir, cleanup: () => fs.rmSync(runDir, { recursive: true, force: true }) };
}

function ok(result: ReturnType<typeof getScanSummary>): ScanSummaryResult {
  if (!result.ok) throw new Error(`expected ok summary, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

const SAMPLE: Record<string, string> = {
  'scan/file_inventory.json': JSON.stringify([
    { path: 'src/a.ts', extension: '.ts', bytes: 10 },
    { path: 'src/b.ts', extension: '.ts', bytes: 20 },
    { path: 'README.md', extension: '.md', bytes: 30 },
  ]),
  'scan/commands.json': JSON.stringify({
    commands: {
      test: [{ command: 'pnpm test', source: 'package.json:scripts.test' }],
      lint: [{ command: 'pnpm lint', source: 'package.json:scripts.lint' }],
    },
    warnings: [],
  }),
  'scan/tests.json': JSON.stringify({
    tests: [
      { path: 'tests/a.test.ts', language_guess: 'typescript', test_framework_guess: 'vitest', test_names: ['x', 'y'], likely_targets: ['src/a.ts'] },
    ],
    test_configs: [{ path: 'vitest.config.ts', framework: 'vitest' }],
    warnings: [],
  }),
  'scan/symbols.json': JSON.stringify({
    symbols: [
      { path: 'src/a.ts', name: 'foo', kind: 'function', signature: 'function foo()', line: 1 },
      { path: 'src/a.ts', name: 'Bar', kind: 'class', signature: 'class Bar', line: 5 },
    ],
    warnings: [],
  }),
  'scan/imports.json': JSON.stringify({
    imports: [{ from_path: 'src/a.ts', import_target: './b', kind: 'local', line: 1, language_guess: 'typescript' }],
    warnings: [],
  }),
  'scan/entrypoints.json': JSON.stringify({
    entrypoints: [{ name: 'vibecode', type: 'cli' }],
    warnings: [],
  }),
  'scan/repo_instructions.json': JSON.stringify({
    repo_instructions: [
      { path: 'AGENTS.md', content: 'SECRET BODY THAT MUST NOT LEAK', headings: ['A', 'B'], bytes: 1234, source_type: 'agents' },
    ],
    warnings: [],
  }),
  'scan/tooling.json': JSON.stringify({
    formatters: ['prettier'],
    linters: ['eslint'],
    typecheckers: ['tsc'],
    test_frameworks: ['vitest'],
    configs: [{ path: '.eslintrc', tool: 'eslint' }],
    warnings: [],
  }),
  'scan/git_status.json': JSON.stringify({
    git_available: true,
    branch: 'master',
    head_commit: 'abc123',
    dirty: true,
    modified: ['src/a.ts'],
    untracked: ['new.ts'],
    staged: [],
  }),
  'scan/git_diff_stat.txt': 'src/a.ts | 2 +-\n',
};

describe('getScanSummary — populated scan dir', () => {
  let env: { runDir: string; cleanup: () => void };
  beforeEach(() => {
    env = makeScanRun('vibecode-scan-summary-', SAMPLE);
  });
  afterEach(() => env.cleanup());

  test('defaults to all sections and reports scan availability', () => {
    const result = ok(getScanSummary(env.runDir));
    expect(result.scan_dir_available).toBe(true);
    expect(result.scan_available).toBe(true);
    expect(result.sections_requested).toEqual([...DEFAULT_SCAN_SUMMARY_SECTIONS]);
    expect(result.available_artifacts).toContain('commands');
    expect(result.available_artifacts).toContain('git_diff_stat');
    // schemas.json / keyword_hits.json were not written.
    expect(result.missing_artifacts).toContain('schemas');
    expect(result.missing_artifacts).toContain('keyword_hits');
  });

  test('files section reports totals and sample paths only (no contents)', () => {
    const result = ok(getScanSummary(env.runDir, { sections: ['files'] }));
    const files = result.sections.files;
    expect(files.available).toBe(true);
    expect(files.total).toBe(3);
    expect(files.items).toEqual(['src/a.ts', 'src/b.ts', 'README.md']);
  });

  test('commands section flattens categories', () => {
    const result = ok(getScanSummary(env.runDir, { sections: ['commands'] }));
    const commands = result.sections.commands;
    expect(commands.total).toBe(2);
    expect(commands.items).toContainEqual({ category: 'test', command: 'pnpm test', source: 'package.json:scripts.test' });
  });

  test('tests section reports counts and test_configs summary', () => {
    const result = ok(getScanSummary(env.runDir, { sections: ['tests'] }));
    const tests = result.sections.tests;
    expect(tests.total).toBe(1);
    expect(tests.items[0]).toMatchObject({ path: 'tests/a.test.ts', framework: 'vitest', test_count: 2, target_count: 1 });
    expect(tests.summary?.test_configs).toBe(1);
  });

  test('symbols/imports/entrypoints project bounded fields', () => {
    const result = ok(getScanSummary(env.runDir, { sections: ['symbols', 'imports', 'entrypoints'] }));
    expect(result.sections.symbols.total).toBe(2);
    expect(result.sections.symbols.items[0]).toEqual({ name: 'foo', kind: 'function', path: 'src/a.ts', line: 1 });
    expect(result.sections.imports.items[0]).toMatchObject({ from_path: 'src/a.ts', import_target: './b', kind: 'local' });
    expect(result.sections.entrypoints.items[0]).toMatchObject({ name: 'vibecode', type: 'cli' });
  });

  test('instructions section never includes file content', () => {
    const result = ok(getScanSummary(env.runDir, { sections: ['instructions'] }));
    const instructions = result.sections.instructions;
    expect(instructions.items[0]).toEqual({ path: 'AGENTS.md', source_type: 'agents', bytes: 1234, heading_count: 2 });
    expect(JSON.stringify(result)).not.toContain('SECRET BODY THAT MUST NOT LEAK');
  });

  test('tooling and git sections expose compact summaries', () => {
    const result = ok(getScanSummary(env.runDir, { sections: ['tooling', 'git'] }));
    expect(result.sections.tooling.summary).toMatchObject({ linters: ['eslint'], config_count: 1 });
    expect(result.sections.git.summary).toMatchObject({ branch: 'master', dirty: true, modified: 1, untracked: 1, staged: 0 });
    expect(result.sections.git.items).toEqual(['src/a.ts', 'new.ts']);
  });

  test('max_items caps and marks truncation', () => {
    const result = ok(getScanSummary(env.runDir, { sections: ['files'], maxItems: 2 }));
    const files = result.sections.files;
    expect(files.returned).toBe(2);
    expect(files.total).toBe(3);
    expect(files.truncated).toBe(true);
  });

  test('recommends scan_artifact_read when scan is available', () => {
    const result = ok(getScanSummary(env.runDir, { sections: ['files'] }));
    expect(result.recommended_next_tools).toContain('vibecode_scan_artifact_read');
  });
});

describe('getScanSummary — degraded states', () => {
  test('missing scan dir returns ok with scan_available=false', () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-scan-summary-empty-'));
    try {
      const result = ok(getScanSummary(runDir));
      expect(result.scan_dir_available).toBe(false);
      expect(result.scan_available).toBe(false);
      expect(result.warnings.some((w) => /scan directory is not available/.test(w))).toBe(true);
      expect(result.recommended_next_tools).toContain('vibecode_session_bootstrap');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('a missing individual artifact does not fail the whole summary', () => {
    const env = makeScanRun('vibecode-scan-summary-partial-', {
      'scan/commands.json': JSON.stringify({ commands: { test: [{ command: 'pnpm test', source: 's' }] } }),
    });
    try {
      const result = ok(getScanSummary(env.runDir, { sections: ['commands', 'symbols'] }));
      expect(result.sections.commands.available).toBe(true);
      expect(result.sections.symbols.available).toBe(false);
      expect(result.sections.symbols.total).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  test('a malformed artifact marks its section unavailable with a warning', () => {
    const env = makeScanRun('vibecode-scan-summary-bad-', { 'scan/symbols.json': '{bad json' });
    try {
      const result = ok(getScanSummary(env.runDir, { sections: ['symbols'] }));
      expect(result.sections.symbols.available).toBe(false);
      expect(result.warnings.some((w) => /could not be parsed/.test(w))).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});

describe('getScanSummary — validation', () => {
  let env: { runDir: string; cleanup: () => void };
  beforeEach(() => {
    env = makeScanRun('vibecode-scan-summary-val-', SAMPLE);
  });
  afterEach(() => env.cleanup());

  test('unknown section is a structured INVALID_SECTION error', () => {
    const result = getScanSummary(env.runDir, { sections: ['files', 'nope'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_SECTION');
    expect(result.error).toHaveProperty('allowed');
  });

  test('max_items of 0 is rejected', () => {
    const result = getScanSummary(env.runDir, { maxItems: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_MAX_ITEMS');
  });

  test('max_items above the hard cap is rejected', () => {
    const result = getScanSummary(env.runDir, { maxItems: SCAN_SUMMARY_MAX_ITEMS + 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_MAX_ITEMS');
  });

  test('duplicate requested sections are de-duplicated', () => {
    const result = ok(getScanSummary(env.runDir, { sections: ['files', 'files', 'commands'] }));
    expect(result.sections_requested).toEqual(['files', 'commands']);
  });
});
