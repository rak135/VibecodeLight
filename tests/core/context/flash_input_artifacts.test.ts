import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import {
  buildAndWriteFlashInputArtifacts,
  FlashInputManifestError,
} from '../../../src/core/context/index.js';

interface MinimalFixture {
  repoRoot: string;
  runId: string;
  runDir: string;
  flashDir: string;
  vibecodePath: string;
}

function makeMinimalFixture(opts: { underVibecode?: boolean } = {}): MinimalFixture {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-flash-artifacts-'));
  const runId = 'run-flash-artifacts-001';
  const underVibecode = opts.underVibecode ?? true;
  const vibecodePath = underVibecode
    ? path.join(repoRoot, '.vibecode')
    : path.join(repoRoot, 'no-vibecode');
  const runDir = path.join(vibecodePath, 'runs', runId);
  const flashDir = path.join(runDir, 'flash');
  fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
  fs.mkdirSync(flashDir, { recursive: true });

  fs.writeFileSync(
    path.join(runDir, 'user_prompt.md'),
    'Test flash input artifacts helper\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({
      run_id: runId,
      created_at: '2026-01-01T00:00:00.000Z',
      task: 'Test flash input artifacts helper',
      status: 'running',
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'scanner_config.json'),
    JSON.stringify({
      run_id: runId,
      repo_root: repoRoot,
      task: 'Test flash input artifacts helper',
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'skills', 'skills_catalog.json'),
    JSON.stringify({ generated_at: 'x', skills: [], warnings: [] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'scan', 'scan_manifest.json'),
    JSON.stringify({ ok: true, run_id: runId, artifacts: {}, warnings: [] }),
    'utf8',
  );

  return { repoRoot, runId, runDir, flashDir, vibecodePath };
}

// Mirrors FLASH_INPUT_OPTIONAL_INPUTS (21 entries). When every entry is
// present on disk, the manifest layer emits zero "optional flash input
// artifact not available" warnings.
const OPTIONAL_SCAN_ARTIFACTS: ReadonlyArray<readonly [string, string]> = [
  ['scan/repo_tree.txt', 'src/example.ts\n'],
  ['scan/file_inventory.json', JSON.stringify({ files: [{ path: 'src/example.ts' }] })],
  ['scan/git_status.json', JSON.stringify({ files: [] })],
  ['scan/git_diff_stat.txt', ''],
  ['scan/ignore_rules.json', JSON.stringify({ ignored: [] })],
  ['scan/config_snapshot.json', JSON.stringify({})],
  ['scan/manifests.json', JSON.stringify({ manifests: [] })],
  ['scan/environment.json', JSON.stringify({})],
  ['scan/commands.json', JSON.stringify({ commands: [] })],
  ['scan/tooling.json', JSON.stringify({})],
  ['scan/repo_instructions.json', JSON.stringify({ repo_instructions: [] })],
  ['scan/docs.json', JSON.stringify({ docs: [] })],
  ['scan/architecture_docs.json', JSON.stringify({ architecture_docs: [] })],
  ['scan/symbols.json', JSON.stringify({ symbols: [] })],
  ['scan/imports.json', JSON.stringify({ imports: [] })],
  ['scan/entrypoints.json', JSON.stringify({ entrypoints: [] })],
  ['scan/tests.json', JSON.stringify({ tests: [] })],
  ['scan/schemas.json', JSON.stringify({ schemas: [] })],
  ['scan/exact_text_hits.json', JSON.stringify({ exact_text_hits: [] })],
  ['scan/keyword_hits.json', JSON.stringify({ keyword_hits: [] })],
  ['scan/recent_history.json', JSON.stringify({ commits: [] })],
];

function writeAllOptionalScanArtifacts(runDir: string): void {
  for (const [rel, content] of OPTIONAL_SCAN_ARTIFACTS) {
    fs.writeFileSync(path.join(runDir, rel), content, 'utf8');
  }
}

function cleanup(fixture: MinimalFixture): void {
  fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
}

describe('buildAndWriteFlashInputArtifacts', () => {
  describe('happy path', () => {
    test('writes manifest and flash input and returns existing paths', () => {
      const fixture = makeMinimalFixture();
      writeAllOptionalScanArtifacts(fixture.runDir);
      try {
        const result = buildAndWriteFlashInputArtifacts({
          run_id: fixture.runId,
          task: 'Happy path task',
          repo_root: fixture.repoRoot,
          runDir: fixture.runDir,
          flashDir: fixture.flashDir,
          vibecodePath: fixture.vibecodePath,
        });

        // The returned paths are exactly the canonical helper-owned paths
        // under the run flash dir.
        expect(result.flashInputManifestPath).toBe(
          path.join(fixture.flashDir, 'flash_input_manifest.json'),
        );
        expect(result.flashInputPath).toBe(path.join(fixture.flashDir, 'flash_input.md'));
        expect(result.taskSlicePath).toBe(path.join(fixture.flashDir, 'task_slice.md'));
        expect(result.relevanceSelectionPath).toBe(
          path.join(fixture.flashDir, 'relevance_selection.json'),
        );
        expect(result.flashInputBudgetPath).toBe(
          path.join(fixture.flashDir, 'flash_input_budget.json'),
        );

        // The compact result and warnings shape are surfaced verbatim.
        expect(result.compactResult).toBeDefined();
        expect(result.compactResult.budget.budget_status).toBe('ok');
        expect(Array.isArray(result.warnings)).toBe(true);

        // Every returned path points to a file the helper has just created.
        expect(fs.existsSync(result.flashInputManifestPath)).toBe(true);
        expect(fs.existsSync(result.flashInputPath)).toBe(true);
        expect(fs.existsSync(result.repoAtlasPath)).toBe(true);
        expect(fs.existsSync(result.taskSlicePath)).toBe(true);
        expect(fs.existsSync(result.relevanceSelectionPath)).toBe(true);
        expect(fs.existsSync(result.flashInputBudgetPath)).toBe(true);

        // Path suffixes are stable; full paths intentionally not asserted.
        expect(result.flashInputManifestPath.endsWith(
          path.join('flash', 'flash_input_manifest.json'),
        )).toBe(true);
        expect(result.flashInputPath.endsWith(path.join('flash', 'flash_input.md'))).toBe(true);
      } finally {
        cleanup(fixture);
      }
    });
  });

  describe('warning propagation', () => {
    test('returns warnings from the manifest layer verbatim', () => {
      const fixture = makeMinimalFixture();
      // Intentionally do not write the optional scan artifacts. The manifest
      // layer emits one "optional flash input artifact not available" warning
      // per missing optional input. The helper must surface those warnings
      // unchanged.
      try {
        const result = buildAndWriteFlashInputArtifacts({
          run_id: fixture.runId,
          task: 'Warning propagation task',
          repo_root: fixture.repoRoot,
          runDir: fixture.runDir,
          flashDir: fixture.flashDir,
          vibecodePath: fixture.vibecodePath,
        });

        const writtenManifest = JSON.parse(
          fs.readFileSync(result.flashInputManifestPath, 'utf8'),
        ) as { warnings: string[] };
        expect(result.warnings).toEqual(writtenManifest.warnings);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(
          result.warnings.some((entry) =>
            entry.includes('optional flash input artifact not available'),
          ),
        ).toBe(true);
      } finally {
        cleanup(fixture);
      }
    });

    test('returns empty warnings when every optional input is present', () => {
      const fixture = makeMinimalFixture();
      writeAllOptionalScanArtifacts(fixture.runDir);
      try {
        const result = buildAndWriteFlashInputArtifacts({
          run_id: fixture.runId,
          task: 'Empty warning task',
          repo_root: fixture.repoRoot,
          runDir: fixture.runDir,
          flashDir: fixture.flashDir,
          vibecodePath: fixture.vibecodePath,
        });
        expect(result.warnings).toEqual([]);
      } finally {
        cleanup(fixture);
      }
    });
  });

  describe('error propagation', () => {
    test('propagates FlashInputManifestError for a missing required input', () => {
      const fixture = makeMinimalFixture();
      // Remove a required artifact so the manifest layer trips
      // MISSING_REQUIRED_INPUT before the compact path runs.
      fs.rmSync(path.join(fixture.runDir, 'scanner_config.json'));
      try {
        let caught: unknown;
        try {
          buildAndWriteFlashInputArtifacts({
            run_id: fixture.runId,
            task: 'Missing required input',
            repo_root: fixture.repoRoot,
            runDir: fixture.runDir,
            flashDir: fixture.flashDir,
            vibecodePath: fixture.vibecodePath,
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(FlashInputManifestError);
        const err = caught as FlashInputManifestError;
        expect(err.code).toBe('MISSING_REQUIRED_INPUT');

        // The helper must not swallow or wrap the error as a CLI/pipeline
        // success/error envelope.
        const raw = caught as Record<string, unknown>;
        expect(raw.ok).toBeUndefined();
        expect(raw.error).toBeUndefined();
      } finally {
        cleanup(fixture);
      }
    });

    test('propagates FlashInputBudgetError from the compact flash build path', () => {
      const fixture = makeMinimalFixture();
      writeAllOptionalScanArtifacts(fixture.runDir);

      // Oversize the inventory/symbols/imports/docs so the compact build
      // path renders past FLASH_INPUT_HARD_MAX_TOKENS and throws a
      // FlashInputBudgetError. Sized like the existing compact_flash_input
      // budget characterization test.
      const selectedHugePath =
        'src/' + 'very-long-subsystem-name/'.repeat(120) + 'flash_context_file.ts';
      const selectedHugeTarget =
        'src/' + 'dependency-edge/'.repeat(120) + 'target.ts';
      fs.writeFileSync(
        path.join(fixture.runDir, 'scan', 'file_inventory.json'),
        JSON.stringify(
          Array.from({ length: 240 }, (_, index) => ({
            path:
              index < 200
                ? selectedHugePath
                : `atlas-top-level-${index}-${'very-long-root-name-'.repeat(80)}/module-${index}/entry.ts`,
            size_bytes: 1234,
            language: 'typescript',
          })),
        ),
        'utf8',
      );
      fs.writeFileSync(
        path.join(fixture.runDir, 'scan', 'symbols.json'),
        JSON.stringify({
          symbols: Array.from({ length: 180 }, (_, index) => ({
            path: selectedHugePath,
            name: `symbol${index}`,
            signature: `function symbol${index}(${`argumentName${index}`.repeat(12)}): ${`ReturnType${index}`.repeat(10)}`,
            line: index + 1,
          })),
        }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(fixture.runDir, 'scan', 'imports.json'),
        JSON.stringify({
          imports: Array.from({ length: 100 }, (_, index) => ({
            path: selectedHugePath,
            target: `${selectedHugeTarget}.${index}`,
            kind: 'local',
            line: index + 1,
          })),
        }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(fixture.runDir, 'scan', 'docs.json'),
        JSON.stringify({
          docs: Array.from({ length: 8 }, (_, index) => ({
            path: `docs/flash-guide-${index}.md`,
            headings: Array.from({ length: 8 }, (_, headingIndex) => `Heading ${index}-${headingIndex}`),
            excerpt:
              ('This is a deliberately large excerpt for compact flash budgeting. '.repeat(120)) +
              index,
          })),
        }),
        'utf8',
      );

      try {
        let caught: unknown;
        try {
          buildAndWriteFlashInputArtifacts({
            run_id: fixture.runId,
            task: 'Oversized compact path',
            repo_root: fixture.repoRoot,
            runDir: fixture.runDir,
            flashDir: fixture.flashDir,
            vibecodePath: fixture.vibecodePath,
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        // FlashInputBudgetError extends FlashInputManifestError; the
        // structured code is what consumers branch on.
        const err = caught as Error & { code?: string };
        expect(err.code).toBe('FLASH_INPUT_BUDGET_EXCEEDED');

        // The helper must not convert the error to a CLI/pipeline envelope.
        const raw = caught as Record<string, unknown>;
        expect(raw.ok).toBeUndefined();
        expect(raw.error).toBeUndefined();
      } finally {
        cleanup(fixture);
      }
    });
  });

  describe('repoAtlasPath fallback', () => {
    test('returns the .vibecode/index repo atlas path when runDir lives under .vibecode/runs', () => {
      const fixture = makeMinimalFixture({ underVibecode: true });
      writeAllOptionalScanArtifacts(fixture.runDir);
      try {
        const result = buildAndWriteFlashInputArtifacts({
          run_id: fixture.runId,
          task: 'Atlas path under .vibecode',
          repo_root: fixture.repoRoot,
          runDir: fixture.runDir,
          flashDir: fixture.flashDir,
          vibecodePath: fixture.vibecodePath,
        });

        // Characterizes the current behavior: when compactResult.paths
        // exposes repo_atlas_path (i.e. the run lives under .vibecode/runs),
        // the helper returns that path, not run_repo_atlas_path.
        expect(result.compactResult.paths.repo_atlas_path).toBe(
          path.join(fixture.vibecodePath, 'index', 'repo_atlas.generated.md'),
        );
        expect(result.repoAtlasPath).toBe(result.compactResult.paths.repo_atlas_path);
        expect(fs.existsSync(result.repoAtlasPath)).toBe(true);

        // The per-run copy is still written but is NOT what the helper
        // returns in this case.
        expect(fs.existsSync(result.compactResult.paths.run_repo_atlas_path)).toBe(true);
        expect(result.repoAtlasPath).not.toBe(result.compactResult.paths.run_repo_atlas_path);
      } finally {
        cleanup(fixture);
      }
    });

    test('falls back to run_repo_atlas_path when runDir is not under .vibecode/runs', () => {
      const fixture = makeMinimalFixture({ underVibecode: false });
      writeAllOptionalScanArtifacts(fixture.runDir);
      try {
        const result = buildAndWriteFlashInputArtifacts({
          run_id: fixture.runId,
          task: 'Atlas path fallback',
          repo_root: fixture.repoRoot,
          runDir: fixture.runDir,
          flashDir: fixture.flashDir,
          vibecodePath: fixture.vibecodePath,
        });

        // Characterizes the fallback branch: when compactResult does not
        // expose a vibecode index path, the helper returns the per-run
        // repo_atlas.md location.
        expect(result.compactResult.paths.repo_atlas_path).toBeUndefined();
        expect(result.repoAtlasPath).toBe(result.compactResult.paths.run_repo_atlas_path);
        expect(result.repoAtlasPath).toBe(path.join(fixture.flashDir, 'repo_atlas.md'));
        expect(fs.existsSync(result.repoAtlasPath)).toBe(true);
      } finally {
        cleanup(fixture);
      }
    });
  });
});
