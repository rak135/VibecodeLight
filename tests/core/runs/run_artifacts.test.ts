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

/**
 * Probe whether this environment can create symlinks. On Windows without
 * Developer Mode/elevation, fs.symlinkSync throws EPERM, so the symlink-escape
 * cases are skipped there while the normal-path regression still runs.
 */
function detectSymlinkSupport(): boolean {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-symlink-probe-'));
  const target = path.join(probeDir, 'target');
  const link = path.join(probeDir, 'link');
  try {
    fs.writeFileSync(target, 'x', 'utf8');
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

const SYMLINKS_SUPPORTED = detectSymlinkSupport();

/**
 * Probe whether this environment can create directory links. On Windows this
 * uses junctions (which, unlike file symlinks, do not require elevation); on
 * POSIX Node treats the 'junction' type as a normal directory symlink. This is
 * supported on effectively every CI/dev environment, so the directory-escape
 * regression runs everywhere rather than being skipped on Windows.
 */
function detectDirLinkSupport(): boolean {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-dirlink-probe-'));
  const target = path.join(probeDir, 'target');
  const link = path.join(probeDir, 'link');
  try {
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'junction');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

const DIRLINKS_SUPPORTED = detectDirLinkSupport();

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

describe('run_artifacts symlink / realpath containment', () => {
  let runDir: string;
  let outsideDir: string;

  beforeEach(() => {
    runDir = makeRunDir('vibecode-run-artifacts-symlink-');
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-outside-secret-'));
  });

  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  test('a normal real file at an allowlisted path still reads (regression, runs everywhere)', () => {
    fs.writeFileSync(path.join(runDir, 'output', 'final_prompt.md'), '# real\n', 'utf8');
    const result = readRunArtifactText(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe('# real\n');
  });

  test.skipIf(!SYMLINKS_SUPPORTED)(
    'rejects an allowlisted artifact that is a symlink pointing outside the run dir',
    () => {
      const secret = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(secret, 'TOP SECRET CONTENTS', 'utf8');
      const artifact = path.join(runDir, 'output', 'final_prompt.md');
      fs.symlinkSync(secret, artifact);

      // Sanity: prove fs.readFileSync WOULD have followed the link and leaked
      // the external file. The resolver must prevent this.
      expect(fs.readFileSync(artifact, 'utf8')).toBe('TOP SECRET CONTENTS');

      const resolved = resolveRunArtifactPath(runDir, 'output/final_prompt.md', {
        allowlist: RUN_SHOW_ARTIFACTS,
      });
      expect(resolved.ok).toBe(false);
      if (resolved.ok) return;
      expect(resolved.error.code).toBe('PATH_OUTSIDE_RUN');

      const read = readRunArtifactText(runDir, 'output/final_prompt.md', {
        allowlist: RUN_SHOW_ARTIFACTS,
      });
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.error.code).toBe('PATH_OUTSIDE_RUN');
      // The external secret must never appear in the structured error.
      expect(JSON.stringify(read.error)).not.toContain('TOP SECRET CONTENTS');
    },
  );

  test.skipIf(!DIRLINKS_SUPPORTED)(
    'rejects an allowlisted artifact reached through a linked intermediate directory (runs on Windows via junction)',
    () => {
      const secret = path.join(outsideDir, 'final_prompt.md');
      fs.writeFileSync(secret, 'OUTSIDE VIA DIR LINK', 'utf8');
      // Replace the real output/ dir with a directory link to the outside dir.
      fs.rmSync(path.join(runDir, 'output'), { recursive: true, force: true });
      fs.symlinkSync(outsideDir, path.join(runDir, 'output'), 'junction');

      // Sanity: prove fs.readFileSync WOULD have followed the link and leaked
      // the external file. The resolver must prevent this.
      expect(fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8')).toBe(
        'OUTSIDE VIA DIR LINK',
      );

      const read = readRunArtifactText(runDir, 'output/final_prompt.md', {
        allowlist: RUN_SHOW_ARTIFACTS,
      });
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.error.code).toBe('PATH_OUTSIDE_RUN');
      expect(JSON.stringify(read.error)).not.toContain('OUTSIDE VIA DIR LINK');
    },
  );

  test.skipIf(!SYMLINKS_SUPPORTED)('handles a broken symlink cleanly as ARTIFACT_NOT_FOUND', () => {
    const missing = path.join(outsideDir, 'does-not-exist.txt');
    const artifact = path.join(runDir, 'output', 'final_prompt.md');
    fs.symlinkSync(missing, artifact);

    const read = readRunArtifactText(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe('ARTIFACT_NOT_FOUND');
  });

  test.skipIf(!SYMLINKS_SUPPORTED)('still allows a symlink that stays inside the run dir', () => {
    // A symlink pointing to another file *within* the run dir is not an escape.
    const realInside = path.join(runDir, 'scan', 'codegraph_usage.json');
    fs.writeFileSync(realInside, '{"inside":true}', 'utf8');
    const artifact = path.join(runDir, 'output', 'final_prompt.md');
    fs.symlinkSync(realInside, artifact);

    const read = readRunArtifactText(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.content).toBe('{"inside":true}');
  });
});
