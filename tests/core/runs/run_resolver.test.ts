import fs from 'fs';
import os from 'os';
import path from 'path';

import { LlmAdapterError } from '../../../src/adapters/llm/errors.js';
import { resolveRunDir } from '../../../src/core/runs/run_resolver.js';

function makeRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(repo, '.vibecode', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.vibecode', 'current'), { recursive: true });
  return repo;
}

function writeLatestManifest(repoRoot: string, runId: string): void {
  fs.writeFileSync(
    path.join(repoRoot, '.vibecode', 'current', 'run_manifest.json'),
    JSON.stringify({ run_id: runId, created_at: '2026-01-01T00:00:00Z', task: 't', status: 'done' }, null, 2),
    'utf8',
  );
}

describe('resolveRunDir', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeRepo('vibecode-run-resolver-');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('resolves an explicit run id to <repo>/.vibecode/runs/<runId>', () => {
    const runId = '2026-01-01_001';
    const result = resolveRunDir(repoRoot, runId);
    expect(result.runId).toBe(runId);
    expect(result.runDir).toBe(path.join(repoRoot, '.vibecode', 'runs', runId));
  });

  test('"latest" reads .vibecode/current/run_manifest.json', () => {
    writeLatestManifest(repoRoot, '2026-05-24_001');
    const result = resolveRunDir(repoRoot, 'latest');
    expect(result.runId).toBe('2026-05-24_001');
    expect(result.runDir).toBe(path.join(repoRoot, '.vibecode', 'runs', '2026-05-24_001'));
  });

  test('"latest" without a manifest throws RUN_NOT_FOUND', () => {
    expect(() => resolveRunDir(repoRoot, 'latest')).toThrow(LlmAdapterError);
    try {
      resolveRunDir(repoRoot, 'latest');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmAdapterError);
      expect((err as LlmAdapterError).code).toBe('RUN_NOT_FOUND');
    }
  });

  test('"latest" with invalid JSON throws RUN_MANIFEST_INVALID', () => {
    fs.writeFileSync(path.join(repoRoot, '.vibecode', 'current', 'run_manifest.json'), 'not json', 'utf8');
    try {
      resolveRunDir(repoRoot, 'latest');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmAdapterError);
      expect((err as LlmAdapterError).code).toBe('RUN_MANIFEST_INVALID');
    }
  });

  test('"latest" with manifest missing run_id throws RUN_MANIFEST_INVALID', () => {
    fs.writeFileSync(
      path.join(repoRoot, '.vibecode', 'current', 'run_manifest.json'),
      JSON.stringify({ task: 't' }),
      'utf8',
    );
    try {
      resolveRunDir(repoRoot, 'latest');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmAdapterError);
      expect((err as LlmAdapterError).code).toBe('RUN_MANIFEST_INVALID');
    }
  });

  test('rejects empty string as INVALID_RUN_ID', () => {
    expect(() => resolveRunDir(repoRoot, '')).toThrow(LlmAdapterError);
    try {
      resolveRunDir(repoRoot, '');
    } catch (err) {
      expect((err as LlmAdapterError).code).toBe('INVALID_RUN_ID');
    }
  });

  test('rejects whitespace-only run id as INVALID_RUN_ID', () => {
    expect(() => resolveRunDir(repoRoot, '   ')).toThrow(LlmAdapterError);
    try {
      resolveRunDir(repoRoot, '   ');
    } catch (err) {
      expect((err as LlmAdapterError).code).toBe('INVALID_RUN_ID');
    }
  });

  test('rejects run id containing forward slash (path traversal guard)', () => {
    expect(() => resolveRunDir(repoRoot, '../escape')).toThrow(LlmAdapterError);
    try {
      resolveRunDir(repoRoot, '../escape');
    } catch (err) {
      expect((err as LlmAdapterError).code).toBe('INVALID_RUN_ID');
      expect((err as LlmAdapterError).message).toMatch(/invalid run id/);
    }
  });

  test('rejects run id containing backslash (Windows path traversal guard)', () => {
    expect(() => resolveRunDir(repoRoot, '..\\escape')).toThrow(LlmAdapterError);
  });

  test('rejects bare ".." and "." segments', () => {
    expect(() => resolveRunDir(repoRoot, '..')).toThrow(LlmAdapterError);
    expect(() => resolveRunDir(repoRoot, '.')).toThrow(LlmAdapterError);
  });

  test('rejects nested traversal "foo/../bar"', () => {
    expect(() => resolveRunDir(repoRoot, 'foo/../bar')).toThrow(LlmAdapterError);
  });

  test('rejects run id containing traversal marker even without separators', () => {
    expect(() => resolveRunDir(repoRoot, 'run..id')).toThrow(LlmAdapterError);
    try {
      resolveRunDir(repoRoot, 'run..id');
    } catch (err) {
      expect((err as LlmAdapterError).code).toBe('INVALID_RUN_ID');
    }
  });

  test('rejects drive-prefix-looking run id', () => {
    expect(() => resolveRunDir(repoRoot, 'C:escape')).toThrow(LlmAdapterError);
    try {
      resolveRunDir(repoRoot, 'C:escape');
    } catch (err) {
      expect((err as LlmAdapterError).code).toBe('INVALID_RUN_ID');
    }
  });

  test('a corrupted "latest" manifest with a traversal run_id is rejected', () => {
    writeLatestManifest(repoRoot, '../../etc');
    expect(() => resolveRunDir(repoRoot, 'latest')).toThrow(LlmAdapterError);
  });

  test('returns runDir even when the directory does not yet exist on disk', () => {
    // Existence is the CLI/desktop caller's responsibility — see runs show
    // which performs its own fs.existsSync check and emits RUN_NOT_FOUND.
    const result = resolveRunDir(repoRoot, '2099-12-31_999');
    expect(result.runId).toBe('2099-12-31_999');
    expect(result.runDir).toBe(path.join(repoRoot, '.vibecode', 'runs', '2099-12-31_999'));
    expect(fs.existsSync(result.runDir)).toBe(false);
  });
});

describe('CLI re-export', () => {
  test('vibecode CLI exports the same resolveRunDir from core', async () => {
    const cli = await import('../../../src/app/cli/commands/runs.js');
    const core = await import('../../../src/core/runs/run_resolver.js');
    expect(cli.resolveRunDir).toBe(core.resolveRunDir);
  });
});
