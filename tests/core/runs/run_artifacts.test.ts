import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  RENDERER_RUN_ARTIFACTS,
  RUN_ARTIFACT_ALIASES,
  RUN_SHOW_ARTIFACTS,
  normalizeRunArtifactSelector,
  readRunArtifactText,
  resolveRunArtifactAlias,
  resolveRunArtifactPath,
} from '../../../src/core/runs/run_artifacts.js';

function makeRunDir(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, 'scan'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'flash'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'output'), { recursive: true });
  return tmp;
}

describe('run_artifacts selector normalization', () => {
  test('normalizeRunArtifactSelector converts backslashes to forward slashes', () => {
    expect(normalizeRunArtifactSelector('flash\\flash_output.md')).toBe('flash/flash_output.md');
  });

  test('normalizeRunArtifactSelector does NOT apply CLI aliases', () => {
    expect(normalizeRunArtifactSelector('codegraph')).toBe('codegraph');
    expect(normalizeRunArtifactSelector('task-intent')).toBe('task-intent');
  });

  test('resolveRunArtifactAlias maps "codegraph" to scan/codegraph_usage.json', () => {
    expect(resolveRunArtifactAlias('codegraph')).toBe('scan/codegraph_usage.json');
  });

  test('resolveRunArtifactAlias maps "task-intent" to task_intent.json', () => {
    expect(resolveRunArtifactAlias('task-intent')).toBe('task_intent.json');
  });

  test('resolveRunArtifactAlias passes through unknown selectors', () => {
    expect(resolveRunArtifactAlias('output/final_prompt.md')).toBe('output/final_prompt.md');
  });

  test('aliases table is frozen so adapters cannot mutate it at runtime', () => {
    expect(() => {
      (RUN_ARTIFACT_ALIASES as Record<string, string>).hacker = 'output/final_prompt.md';
    }).toThrow();
  });
});

describe('run_artifacts allowlists', () => {
  test('RUN_SHOW_ARTIFACTS includes the canonical CLI selectors', () => {
    for (const key of [
      'user_prompt.md',
      'run_manifest.json',
      'output/final_prompt.md',
      'scan/codegraph_usage.json',
      'scan/codegraph_repo_atlas.md',
      'scan/codegraph_repo_atlas.json',
      'scan/repo_atlas.md',
    ]) {
      expect(RUN_SHOW_ARTIFACTS.has(key)).toBe(true);
    }
  });

  test('RENDERER_RUN_ARTIFACTS includes the canonical renderer selectors', () => {
    for (const key of [
      'flash/flash_output.md',
      'flash/provider_error.json',
      'output/context_pack.md',
      'output/final_prompt.md',
      'task_intent.json',
      'config_resolution.json',
      'flash/flash_output_meta.json',
    ]) {
      expect(RENDERER_RUN_ARTIFACTS.has(key)).toBe(true);
    }
  });

  test('RENDERER_RUN_ARTIFACTS does NOT include CLI-only selectors', () => {
    // The renderer surface is intentionally narrower than the CLI surface.
    expect(RENDERER_RUN_ARTIFACTS.has('user_prompt.md')).toBe(false);
    expect(RENDERER_RUN_ARTIFACTS.has('run_manifest.json')).toBe(false);
    expect(RENDERER_RUN_ARTIFACTS.has('scanner_config.json')).toBe(false);
  });
});

describe('resolveRunArtifactPath', () => {
  let runDir: string;

  beforeEach(() => {
    runDir = makeRunDir('vibecode-run-artifacts-');
  });

  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('resolves an allowed selector to an absolute path inside runDir', () => {
    const file = path.join(runDir, 'output', 'final_prompt.md');
    fs.writeFileSync(file, '# final\n', 'utf8');

    const result = resolveRunArtifactPath(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relativePath).toBe('output/final_prompt.md');
    expect(result.value.absolutePath).toBe(path.resolve(file));
  });

  test('rejects a selector that is not in the supplied allowlist', () => {
    const result = resolveRunArtifactPath(runDir, '.env', {
      allowlist: RUN_SHOW_ARTIFACTS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ARTIFACT_NOT_ALLOWED');
    expect(result.error.allowed).toBeTruthy();
    expect((result.error.allowed ?? []).length).toBeGreaterThan(0);
  });

  test('applyAliases=true resolves "codegraph" to scan/codegraph_usage.json', () => {
    const file = path.join(runDir, 'scan', 'codegraph_usage.json');
    fs.writeFileSync(file, '{}', 'utf8');

    const result = resolveRunArtifactPath(runDir, 'codegraph', {
      allowlist: RUN_SHOW_ARTIFACTS,
      applyAliases: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relativePath).toBe('scan/codegraph_usage.json');
  });

  test('applyAliases=false (default) does NOT resolve aliases', () => {
    const result = resolveRunArtifactPath(runDir, 'codegraph', {
      allowlist: RUN_SHOW_ARTIFACTS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ARTIFACT_NOT_ALLOWED');
  });

  test('rejects a path-escape attempt via ../secrets.env', () => {
    const result = resolveRunArtifactPath(runDir, '../secrets.env', {
      allowlist: new Set(['../secrets.env']),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PATH_OUTSIDE_RUN');
  });

  test('rejects an absolute selector even if it matches the allowlist', () => {
    const absolute = path.resolve(runDir, 'output/final_prompt.md');
    const result = resolveRunArtifactPath(runDir, absolute, {
      allowlist: new Set([absolute]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // After normalization the selector is absolute and lands outside the
    // runDir-relative resolution; both checks (allowlist+escape) protect us.
    expect(['ARTIFACT_NOT_ALLOWED', 'PATH_OUTSIDE_RUN']).toContain(result.error.code);
  });

  test('returns ARTIFACT_NOT_FOUND when the allowed file does not exist', () => {
    const result = resolveRunArtifactPath(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ARTIFACT_NOT_FOUND');
    expect(result.error.resolvedPath).toBe(path.resolve(runDir, 'output', 'final_prompt.md'));
  });

  test('requireExists=false skips the existence check', () => {
    const result = resolveRunArtifactPath(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      requireExists: false,
    });
    expect(result.ok).toBe(true);
  });

  test('CLI and Desktop allowlists agree on the overlap they share', () => {
    const overlap = ['output/final_prompt.md', 'output/context_pack.md', 'flash/flash_output.md', 'task_intent.json'];
    for (const key of overlap) {
      expect(RUN_SHOW_ARTIFACTS.has(key)).toBe(true);
      expect(RENDERER_RUN_ARTIFACTS.has(key)).toBe(true);
    }
  });
});

describe('readRunArtifactText', () => {
  let runDir: string;

  beforeEach(() => {
    runDir = makeRunDir('vibecode-run-artifacts-read-');
  });

  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('reads UTF-8 content for an allowed, existing artifact', () => {
    fs.writeFileSync(path.join(runDir, 'output', 'final_prompt.md'), '# final\n', 'utf8');
    const result = readRunArtifactText(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe('# final\n');
    expect(result.value.bytesRead).toBe(Buffer.byteLength('# final\n', 'utf8'));
    expect(result.value.truncated).toBe(false);
  });

  test('truncates when maxBytes is set and file is larger', () => {
    const content = 'x'.repeat(1024);
    fs.writeFileSync(path.join(runDir, 'output', 'final_prompt.md'), content, 'utf8');
    const result = readRunArtifactText(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      maxBytes: 16,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe('x'.repeat(16));
    expect(result.value.truncated).toBe(true);
    expect(result.value.bytesRead).toBe(1024);
  });

  test('propagates ARTIFACT_NOT_ALLOWED unchanged', () => {
    const result = readRunArtifactText(runDir, '.env', {
      allowlist: RUN_SHOW_ARTIFACTS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ARTIFACT_NOT_ALLOWED');
  });
});
