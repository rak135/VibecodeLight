import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import {
  buildFlashInput,
  buildFlashInputManifest,
  FlashInputManifestError,
} from '../../../src/core/context/index.js';

interface FlashInputBuilderFixture {
  repoRoot: string;
  runId: string;
  runDir: string;
  flashDir: string;
}

function makeFixture(): FlashInputBuilderFixture {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-flash-input-builder-'));
  const runId = 'run-flash-input-builder-001';
  const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
  const flashDir = path.join(runDir, 'flash');
  fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
  fs.mkdirSync(flashDir, { recursive: true });

  fs.writeFileSync(path.join(runDir, 'user_prompt.md'), 'Fix flash input builder manifest handling\n', 'utf8');
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({
      run_id: runId,
      created_at: '2026-01-01T00:00:00.000Z',
      task: 'Fix flash input builder manifest handling',
      status: 'running',
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'scanner_config.json'),
    JSON.stringify({
      run_id: runId,
      repo_root: repoRoot,
      task: 'Fix flash input builder manifest handling',
      paths: { scan_out: 'scan' },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'scan', 'scan_manifest.json'),
    JSON.stringify({ ok: true, run_id: runId, artifacts: {}, warnings: [] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'skills', 'skills_catalog.json'),
    JSON.stringify({ generated_at: '2026-01-01T00:00:00.000Z', skills: [], warnings: [] }),
    'utf8',
  );
  fs.writeFileSync(path.join(runDir, 'scan', 'repo_tree.txt'), 'src/core/context/flash_input_builder.ts\n', 'utf8');
  fs.writeFileSync(
    path.join(runDir, 'scan', 'file_inventory.json'),
    JSON.stringify([{ path: 'src/core/context/flash_input_builder.ts', language: 'typescript' }]),
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'scan', 'tests.json'),
    JSON.stringify({ tests: [{ path: 'tests/core/context/flash_input_builder.test.ts' }] }),
    'utf8',
  );

  return { repoRoot, runId, runDir, flashDir };
}

function cleanup(fixture: FlashInputBuilderFixture): void {
  fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
}

describe('buildFlashInput', () => {
  test('keeps manifest validation explicit instead of a discarded nullish expression', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'core', 'context', 'flash_input_builder.ts'),
      'utf8',
    );

    expect(source).not.toContain('opts.manifest ?? buildFlashInputManifest');
  });

  test('returns compact flash input from saved scan artifacts without writing flash input artifacts', () => {
    const fixture = makeFixture();
    try {
      const content = buildFlashInput({
        run_id: fixture.runId,
        task: 'Fix flash input builder manifest handling',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
        previousRunSummary: 'Previous run summary text.',
      });

      expect(content).toMatch(/^# Task$/m);
      expect(content).toMatch(/^# Repo Atlas$/m);
      expect(content).toMatch(/^# Task Slice$/m);
      expect(content).toMatch(/^# Available Full Artifacts$/m);
      expect(content).toContain('src/core/context/flash_input_builder.ts');
      expect(content).toContain('Previous run summary text.');

      expect(fs.existsSync(path.join(fixture.flashDir, 'repo_atlas.md'))).toBe(true);
      expect(fs.existsSync(path.join(fixture.flashDir, 'task_slice.md'))).toBe(true);
      expect(fs.existsSync(path.join(fixture.flashDir, 'relevance_selection.json'))).toBe(true);
      expect(fs.existsSync(path.join(fixture.flashDir, 'flash_input_budget.json'))).toBe(true);
      expect(fs.existsSync(path.join(fixture.flashDir, 'flash_input.md'))).toBe(false);
      expect(fs.existsSync(path.join(fixture.flashDir, 'flash_input_manifest.json'))).toBe(false);
    } finally {
      cleanup(fixture);
    }
  });

  test('validates missing required manifest inputs when no prebuilt manifest is supplied', () => {
    const fixture = makeFixture();
    fs.rmSync(path.join(fixture.runDir, 'scanner_config.json'));
    try {
      let caught: unknown;
      try {
        buildFlashInput({
          run_id: fixture.runId,
          task: 'Missing required manifest input',
          repo_root: fixture.repoRoot,
          runDir: fixture.runDir,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(FlashInputManifestError);
      const err = caught as FlashInputManifestError;
      expect(err.code).toBe('MISSING_REQUIRED_INPUT');
      expect(err.path).toBe('scanner_config.json');
      expect(err.details).toContain('scanner_config.json');
    } finally {
      cleanup(fixture);
    }
  });

  test('treats a supplied manifest as prebuilt validation and renders from saved artifacts', () => {
    const fixture = makeFixture();
    const manifest = buildFlashInputManifest({
      run_id: fixture.runId,
      task: 'Supplied manifest behavior',
      repo_root: fixture.repoRoot,
      runDir: fixture.runDir,
    });
    fs.writeFileSync(
      path.join(fixture.runDir, 'scan', 'file_inventory.json'),
      JSON.stringify([{ path: 'src/changed_after_manifest.ts', language: 'typescript' }]),
      'utf8',
    );
    fs.rmSync(path.join(fixture.runDir, 'scanner_config.json'));

    try {
      const content = buildFlashInput({
        run_id: fixture.runId,
        task: 'Supplied manifest behavior',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
        manifest,
      });

      expect(content).toContain('src/changed_after_manifest.ts');
      expect(fs.existsSync(path.join(fixture.flashDir, 'task_slice.md'))).toBe(true);
    } finally {
      cleanup(fixture);
    }
  });
});
