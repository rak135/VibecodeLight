import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import {
  buildCodeGraphContext,
  parseWindowsNpmShimTarget,
  writeCodeGraphContextArtifacts,
  type CodeGraphContextRunner,
  type CodeGraphReadinessProvider,
} from '../../../src/adapters/codegraph/codegraph_context.js';

function tempRun(): { repoRoot: string; runDir: string; scanDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-context-'));
  const runDir = path.join(repoRoot, '.vibecode', 'runs', '20260525_000001');
  const scanDir = path.join(runDir, 'scan');
  fs.mkdirSync(scanDir, { recursive: true });
  return { repoRoot, runDir, scanDir };
}

function readyProvider(overrides: Partial<Awaited<ReturnType<CodeGraphReadinessProvider>>> = {}): CodeGraphReadinessProvider {
  return async () => ({
    ok: true,
    available: true,
    initialized: true,
    version: '0.9.4',
    warnings: [],
    ...overrides,
  });
}

function makeRunner(overrides: Partial<{ status: number | null; stdout: string; stderr: string; spawnError: string }> = {}): {
  runner: CodeGraphContextRunner;
  calls: Array<{ command: string; args: string[]; cwd: string }>;
} {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runner: CodeGraphContextRunner = (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    if (overrides.spawnError) return { ok: false, stdout: '', stderr: '', exitCode: null, spawnError: overrides.spawnError };
    const status = overrides.status ?? 0;
    return {
      ok: status === 0,
      stdout: overrides.stdout ?? '# Context\nuse adapters/codegraph/codegraph_context.ts',
      stderr: overrides.stderr ?? '',
      exitCode: status,
    };
  };
  return { runner, calls };
}

type AtlasItemForTest = { path: string; reason?: string; provenance?: string; symbol?: string };
type AtlasJsonForTest = {
  sections: {
    likely_relevant_areas: AtlasItemForTest[];
    candidate_entry_points: AtlasItemForTest[];
    related_files_to_inspect: AtlasItemForTest[];
    possible_risk_areas: AtlasItemForTest[];
  };
};

function allAtlasPaths(atlasJson: AtlasJsonForTest): string[] {
  return [
    ...atlasJson.sections.likely_relevant_areas.map((item) => item.path),
    ...atlasJson.sections.candidate_entry_points.map((item) => item.path),
    ...atlasJson.sections.related_files_to_inspect.map((item) => item.path),
    ...atlasJson.sections.possible_risk_areas.map((item) => item.path),
  ];
}

describe('buildCodeGraphContext', () => {
  test('resolves npm .cmd shim target so task text can be passed as argv without cmd.exe quote loss', () => {
    const shim = [
      '@ECHO off',
      'SETLOCAL',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@colbymchenry\\codegraph\\npm-shim.js" %*',
    ].join('\n');

    expect(parseWindowsNpmShimTarget(shim, 'C:\\Users\\Martin\\AppData\\Roaming\\npm')).toBe(
      path.join('C:\\Users\\Martin\\AppData\\Roaming\\npm', 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js'),
    );
  });

  test('defaults to detect-only and does not call status or context/query commands', async () => {
    const { runner, calls } = makeRunner();
    let readinessCalls = 0;

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'use codegraph',
      mode: 'detect-only',
      runner,
      readinessProvider: async () => {
        readinessCalls += 1;
        return readyProvider()('/repo/root');
      },
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(false);
    expect(result.mode).toBe('detect-only');
    expect(result.reason).toBe('DETECT_ONLY');
    expect(calls).toEqual([]);
    expect(readinessCalls).toBe(0);
  });

  test('use-existing ready path verifies status and runs bounded read-only context command', async () => {
    const { runner, calls } = makeRunner({ stdout: '# CodeGraph\nRelevant context' });

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'implement phase 2',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider(),
      maxBytes: 4096,
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(true);
    expect(result.reason).toBe('EXISTING_INDEX');
    expect(result.outputText).toContain('Relevant context');
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['status', '--json']);
    expect(calls[1].args).toEqual([
      'context',
      'implement phase 2',
      '--path',
      '/repo/root',
      '--max-nodes',
      '50',
      '--max-code',
      '10',
      '--format',
      'markdown',
    ]);
    expect(calls[1].cwd).toBe('/repo/root');
  });

  test('use-existing not installed skips without running context', async () => {
    const { runner, calls } = makeRunner();

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider({ available: false, initialized: false }),
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(false);
    expect(result.reason).toBe('CODEGRAPH_NOT_INSTALLED');
    expect(calls).toEqual([]);
  });

  test('use-existing not initialized skips without running init automatically', async () => {
    const { runner, calls } = makeRunner();

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider({ available: true, initialized: false }),
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(false);
    expect(result.reason).toBe('CODEGRAPH_NOT_INITIALIZED');
    expect(calls.some((call) => call.args.includes('init'))).toBe(false);
    expect(calls.some((call) => call.args.includes('context') || call.args.includes('query'))).toBe(false);
  });

  test('stale index records a warning but still uses existing context without syncing or reindexing automatically', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const runner: CodeGraphContextRunner = (command, args, cwd) => {
      calls.push({ command, args: [...args], cwd });
      if (args[0] === 'status') {
        return {
          ok: true,
          stdout: JSON.stringify({ initialized: true, pendingChanges: { added: 1, modified: 2, removed: 0 } }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { ok: true, stdout: '# Context\nExisting index context', stderr: '', exitCode: 0 };
    };

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider(),
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(true);
    expect(result.reason).toBe('EXISTING_INDEX');
    expect(result.outputText).toContain('Existing index context');
    expect(result.warnings.some((warning) => warning.includes('CODEGRAPH_INDEX_STALE'))).toBe(true);
    expect(calls.map((call) => call.args[0])).toEqual(['status', 'context']);
    expect(calls.some((call) => call.args.includes('sync') || call.args.includes('index'))).toBe(false);
  });

  test('command failure is recorded as skipped/fallback with bounded stderr', async () => {
    const longStderr = 'failure '.repeat(20_000);
    const { runner } = makeRunner({ status: 1, stdout: JSON.stringify({ initialized: true, pendingChanges: { added: 0, modified: 0, removed: 0 } }), stderr: longStderr });

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider(),
      maxBytes: 4096,
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(false);
    expect(result.reason).toBe('CODEGRAPH_STATUS_FAILED');
    expect(JSON.stringify(result).length).toBeLessThan(10_000);
  });

  test('huge CodeGraph output is truncated and warning metadata records the bound', async () => {
    const huge = 'x'.repeat(100_000);
    const { runner } = makeRunner({ stdout: huge });

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider(),
      maxBytes: 4096,
    });

    expect(result.used).toBe(true);
    expect(result.outputText!.length).toBeLessThanOrEqual(4096);
    expect(result.warnings.some((warning) => warning.includes('CODEGRAPH_OUTPUT_TRUNCATED'))).toBe(true);
  });

  test('anti-scope: context build never runs init, index, sync, watch, serve, install, or agent config writes', async () => {
    const { runner, calls } = makeRunner();

    await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider(),
    });

    const forbidden = new Set(['init', 'index', 'sync', 'watch', 'serve', 'install', 'uninstall']);
    for (const call of calls) {
      expect(call.args.some((arg) => forbidden.has(arg))).toBe(false);
    }
  });
});

describe('writeCodeGraphContextArtifacts', () => {
  test('writes usage metadata and context artifact when CodeGraph was used', () => {
    const { runDir } = tempRun();
    try {
      const result = {
        ok: true,
        used: true,
        mode: 'use-existing' as const,
        command: ['codegraph', 'context', 'task'],
        outputText: '# CodeGraph Context\nRelevant files: src/adapters/codegraph/codegraph_context.ts',
        warnings: [],
        reason: 'EXISTING_INDEX',
      };

      const written = writeCodeGraphContextArtifacts({ runDir, result });

      expect(written.usageArtifact).toBe(path.join(runDir, 'scan', 'codegraph_usage.json'));
      expect(written.contextArtifact).toBe(path.join(runDir, 'scan', 'codegraph_context.md'));
      expect(written.repoAtlasArtifact).toBe(path.join(runDir, 'scan', 'repo_atlas.md'));
      expect(written.repoAtlasJsonArtifact).toBe(path.join(runDir, 'scan', 'repo_atlas.json'));
      const usage = JSON.parse(fs.readFileSync(written.usageArtifact, 'utf8'));
      expect(usage).toMatchObject({
        mode: 'use-existing',
        used: true,
        reason: 'EXISTING_INDEX',
        artifact: 'scan/codegraph_context.md',
        repo_atlas_generated: true,
        repo_atlas_artifact: 'scan/repo_atlas.md',
        repo_atlas_json_artifact: 'scan/repo_atlas.json',
      });
      expect(fs.readFileSync(written.contextArtifact!, 'utf8')).toContain('Relevant files');
      const atlas = fs.readFileSync(written.repoAtlasArtifact!, 'utf8');
      expect(atlas).toContain('# Repo Atlas');
      expect(atlas).toContain('CodeGraph output is guidance, not source of truth');
      expect(atlas).toContain('## Likely Relevant Areas');
      const atlasJson = JSON.parse(fs.readFileSync(written.repoAtlasJsonArtifact!, 'utf8'));
      expect(atlasJson.generated).toBe(true);
      expect(atlasJson.sections.likely_relevant_areas.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });

  test('detect-only usage does not create atlas and records detect-only atlas reason', () => {
    const { runDir } = tempRun();
    try {
      const written = writeCodeGraphContextArtifacts({
        runDir,
        result: {
          ok: true,
          used: false,
          mode: 'detect-only',
          reason: 'DETECT_ONLY',
          warnings: [],
        },
      });

      expect(written.contextArtifact).toBeUndefined();
      expect(written.repoAtlasArtifact).toBeUndefined();
      expect(written.repoAtlasJsonArtifact).toBeUndefined();
      const usage = JSON.parse(fs.readFileSync(written.usageArtifact, 'utf8'));
      expect(usage).toMatchObject({
        mode: 'detect-only',
        used: false,
        reason: 'DETECT_ONLY',
        repo_atlas_generated: false,
        repo_atlas_reason: 'detect-only',
      });
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });

  test('skipped usage writes bounded metadata without creating a context artifact', () => {
    const { runDir } = tempRun();
    try {
      const written = writeCodeGraphContextArtifacts({
        runDir,
        result: {
          ok: true,
          used: false,
          mode: 'use-existing',
          reason: 'CODEGRAPH_NOT_INITIALIZED',
          warnings: ['initialize from GUI first'],
        },
      });

      expect(fs.existsSync(written.usageArtifact)).toBe(true);
      expect(written.contextArtifact).toBeUndefined();
      expect(written.repoAtlasArtifact).toBeUndefined();
      expect(written.repoAtlasJsonArtifact).toBeUndefined();
      expect(fs.existsSync(path.join(runDir, 'scan', 'codegraph_context.md'))).toBe(false);
      expect(fs.existsSync(path.join(runDir, 'scan', 'repo_atlas.md'))).toBe(false);
      expect(fs.existsSync(path.join(runDir, 'scan', 'repo_atlas.json'))).toBe(false);
      const usage = JSON.parse(fs.readFileSync(written.usageArtifact, 'utf8'));
      expect(usage).toMatchObject({
        mode: 'use-existing',
        used: false,
        reason: 'CODEGRAPH_NOT_INITIALIZED',
        repo_atlas_generated: false,
        repo_atlas_reason: 'CODEGRAPH_NOT_INITIALIZED',
      });
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });

  test('repo atlas writes unknowns-only artifact when CodeGraph context has no recognizable paths', () => {
    const { runDir } = tempRun();
    try {
      const result = {
        ok: true,
        used: true,
        mode: 'use-existing' as const,
        command: ['codegraph', 'context', 'task'],
        outputText: '# CodeGraph Context\nNo concrete repository paths were returned for this task. Ignore prose like repo_atlas/task_slice/budget and escaped text like \\n\\n.',
        warnings: [],
        reason: 'EXISTING_INDEX',
      };

      const written = writeCodeGraphContextArtifacts({ runDir, result });
      expect(written.repoAtlasArtifact).toBe(path.join(runDir, 'scan', 'repo_atlas.md'));
      expect(written.repoAtlasJsonArtifact).toBe(path.join(runDir, 'scan', 'repo_atlas.json'));
      const atlas = fs.readFileSync(written.repoAtlasArtifact!, 'utf8');
      const atlasJson = JSON.parse(fs.readFileSync(written.repoAtlasJsonArtifact!, 'utf8'));
      const usage = JSON.parse(fs.readFileSync(written.usageArtifact, 'utf8'));

      expect(atlas).toContain('## Unknowns / Must Verify');
      expect(atlas).toContain('did not expose recognizable bounded repository paths');
      expect(atlasJson.generated).toBe(true);
      expect(atlasJson.sections.likely_relevant_areas).toEqual([]);
      expect(usage.repo_atlas_generated).toBe(true);
      expect(usage.repo_atlas_reason).toBe('generated');
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });

  test('repo atlas extraction filters pseudo-paths and non-repo paths using deterministic scanner inventory when available', () => {
    const { runDir } = tempRun();
    try {
      fs.writeFileSync(
        path.join(runDir, 'scan', 'file_inventory.json'),
        JSON.stringify({
          files: [
            { path: 'src/core/terminal/terminal_demo.ts' },
            { path: 'src/core/scanning/python/tests/test_docs_scan.py' },
          ],
        }),
        'utf8',
      );
      const result = {
        ok: true,
        used: true,
        mode: 'use-existing' as const,
        command: ['codegraph', 'context', 'task'],
        outputText: [
          '# CodeGraph Context',
          '- src/core/terminal/terminal_demo.ts — real repo file',
          '- src/core/scanning/python/tests/test_docs_scan.py — real repo file',
          'if (candidates.length > 1 && /ENOENT/i.test(msg) && candidate !== candidates[candidates.length - 1]) {',
          '"# Readme/n/nIntro./n", encoding="utf-8"',
          'entry = _entry_by_path(data["docs"], "docs/GUIDE.md")',
        ].join('\n'),
        warnings: [],
        reason: 'EXISTING_INDEX',
      };

      const written = writeCodeGraphContextArtifacts({ runDir, result });
      const atlas = fs.readFileSync(written.repoAtlasArtifact!, 'utf8');
      const atlasJson = JSON.parse(fs.readFileSync(written.repoAtlasJsonArtifact!, 'utf8'));
      const atlasPaths = [
        ...atlasJson.sections.likely_relevant_areas.map((item: { path: string }) => item.path),
        ...atlasJson.sections.candidate_entry_points.map((item: { path: string }) => item.path),
        ...atlasJson.sections.related_files_to_inspect.map((item: { path: string }) => item.path),
        ...atlasJson.sections.possible_risk_areas.map((item: { path: string }) => item.path),
      ];

      expect(atlas).toContain('src/core/terminal/terminal_demo.ts');
      expect(atlas).toContain('src/core/scanning/python/tests/test_docs_scan.py');
      expect(atlas).not.toContain('ENOENT/i.test');
      expect(atlas).not.toContain('Readme/n/nIntro./n');
      expect(atlas).not.toContain('docs/GUIDE.md');
      expect(atlasPaths).toEqual([
        'src/core/terminal/terminal_demo.ts',
        'src/core/scanning/python/tests/test_docs_scan.py',
      ]);
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });

  test('repo atlas extraction filters pseudo-paths using list-root file inventory from real scanner output', () => {
    const { runDir } = tempRun();
    try {
      fs.writeFileSync(
        path.join(runDir, 'scan', 'file_inventory.json'),
        JSON.stringify([
          { path: 'src/core/terminal/terminal_demo.ts' },
          { path: 'src/core/scanning/python/tests/test_docs_scan.py' },
        ]),
        'utf8',
      );
      const result = {
        ok: true,
        used: true,
        mode: 'use-existing' as const,
        command: ['codegraph', 'context', 'task'],
        outputText: [
          '# CodeGraph Context',
          '- src/core/terminal/terminal_demo.ts — real repo file',
          '- src/core/scanning/python/tests/test_docs_scan.py — real repo file',
          'if (candidates.length > 1 && /ENOENT/i.test(msg) && candidate !== candidates[candidates.length - 1]) {',
          'entry = _entry_by_path(data["docs"], "docs/GUIDE.md")',
        ].join('\n'),
        warnings: [],
        reason: 'EXISTING_INDEX',
      };

      const written = writeCodeGraphContextArtifacts({ runDir, result });
      const atlas = fs.readFileSync(written.repoAtlasArtifact!, 'utf8');
      const atlasJson = JSON.parse(fs.readFileSync(written.repoAtlasJsonArtifact!, 'utf8')) as AtlasJsonForTest;
      const atlasPaths = allAtlasPaths(atlasJson);

      expect(atlasPaths).toEqual([
        'src/core/terminal/terminal_demo.ts',
        'src/core/scanning/python/tests/test_docs_scan.py',
      ]);
      expect(atlas).not.toContain('ENOENT/i.test');
      expect(atlas).not.toContain('docs/GUIDE.md');
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });

  test('repo atlas maps Entry Points section paths to candidate entry points with useful reasons', () => {
    const { runDir } = tempRun();
    try {
      fs.writeFileSync(
        path.join(runDir, 'scan', 'file_inventory.json'),
        JSON.stringify({
          files: [
            { path: 'src/app/desktop/prompt_preview_service.ts' },
            { path: 'src/core/scanning/codegraph_status.ts' },
          ],
        }),
        'utf8',
      );
      const result = {
        ok: true,
        used: true,
        mode: 'use-existing' as const,
        command: ['codegraph', 'context', 'task'],
        outputText: [
          '# CodeGraph Context',
          '### Entry Points',
          '',
          '- `src/app/desktop/prompt_preview_service.ts` — `generatePromptPreview`',
          '- `src/core/scanning/codegraph_status.ts` — `readRunCodeGraphStatus`',
          '- `ENOENT/i.test` — pseudo path from code',
          '- `repo_atlas/task_slice/budget` — pseudo path from prose',
          '- `Readme/n/nIntro./n` — escaped prose',
          '- `docs/GUIDE.md` — not in deterministic file inventory',
        ].join('\n'),
        warnings: [],
        reason: 'EXISTING_INDEX',
      };

      const written = writeCodeGraphContextArtifacts({ runDir, result });
      const atlas = fs.readFileSync(written.repoAtlasArtifact!, 'utf8');
      const atlasJson = JSON.parse(fs.readFileSync(written.repoAtlasJsonArtifact!, 'utf8')) as AtlasJsonForTest;
      const entries = atlasJson.sections.candidate_entry_points;

      expect(entries.map((item) => item.path)).toEqual([
        'src/app/desktop/prompt_preview_service.ts',
        'src/core/scanning/codegraph_status.ts',
      ]);
      expect(entries.every((item) => item.provenance === 'codegraph_hint')).toBe(true);
      expect(entries.map((item) => item.reason)).toEqual([
        expect.stringContaining('entry point: generatePromptPreview'),
        expect.stringContaining('entry point: readRunCodeGraphStatus'),
      ]);
      expect(atlas).toContain('## Candidate Entry Points');
      expect(atlas).toContain('src/app/desktop/prompt_preview_service.ts');
      expect(atlas).toContain('src/core/scanning/codegraph_status.ts');
      expect(allAtlasPaths(atlasJson)).toEqual([
        'src/app/desktop/prompt_preview_service.ts',
        'src/core/scanning/codegraph_status.ts',
      ]);
      expect(atlas).not.toContain('ENOENT/i.test');
      expect(atlas).not.toContain('repo_atlas/task_slice/budget');
      expect(atlas).not.toContain('Readme/n/nIntro./n');
      expect(atlas).not.toContain('docs/GUIDE.md');
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });

  test('repo atlas maps Related Symbols section paths to related files with useful reasons', () => {
    const { runDir } = tempRun();
    try {
      fs.writeFileSync(
        path.join(runDir, 'scan', 'file_inventory.json'),
        JSON.stringify({
          files: [
            { path: 'src/core/context/flash_compaction.ts' },
            { path: 'src/core/context/flash_input_manifest.ts' },
          ],
        }),
        'utf8',
      );
      const result = {
        ok: true,
        used: true,
        mode: 'use-existing' as const,
        command: ['codegraph', 'context', 'task'],
        outputText: [
          '# CodeGraph Context',
          '### Related Symbols',
          '',
          '- `src/core/context/flash_compaction.ts` — `renderFlashInput`',
          '- `src/core/context/flash_input_manifest.ts` — `buildFlashInputManifest`',
          '- `docs/GUIDE.md` — not in inventory',
        ].join('\n'),
        warnings: [],
        reason: 'EXISTING_INDEX',
      };

      const written = writeCodeGraphContextArtifacts({ runDir, result });
      const atlas = fs.readFileSync(written.repoAtlasArtifact!, 'utf8');
      const atlasJson = JSON.parse(fs.readFileSync(written.repoAtlasJsonArtifact!, 'utf8')) as AtlasJsonForTest;
      const related = atlasJson.sections.related_files_to_inspect;

      expect(related.map((item) => item.path)).toEqual([
        'src/core/context/flash_compaction.ts',
        'src/core/context/flash_input_manifest.ts',
      ]);
      expect(related.every((item) => item.provenance === 'codegraph_hint')).toBe(true);
      expect(related.map((item) => item.reason)).toEqual([
        expect.stringContaining('related symbol: renderFlashInput'),
        expect.stringContaining('related symbol: buildFlashInputManifest'),
      ]);
      expect(atlas).toContain('## Related Files To Inspect');
      expect(atlas).toContain('src/core/context/flash_compaction.ts');
      expect(atlas).toContain('src/core/context/flash_input_manifest.ts');
      expect(allAtlasPaths(atlasJson)).toEqual([
        'src/core/context/flash_compaction.ts',
        'src/core/context/flash_input_manifest.ts',
      ]);
      expect(atlas).not.toContain('docs/GUIDE.md');
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });

  test('repo atlas extracts symbols from native CodeGraph section formats', () => {
    const { runDir } = tempRun();
    try {
      fs.writeFileSync(
        path.join(runDir, 'scan', 'file_inventory.json'),
        JSON.stringify({
          files: [
            { path: 'src/core/context/artifact_reader.ts' },
            { path: 'src/adapters/codegraph/codegraph_context.ts' },
          ],
        }),
        'utf8',
      );
      const result = {
        ok: true,
        used: true,
        mode: 'use-existing' as const,
        command: ['codegraph', 'context', 'task'],
        outputText: [
          '# CodeGraph Context',
          '### Entry Points',
          '- **artifactExists** (function) - src/core/context/artifact_reader.ts:23',
          '- **CodeGraphContextMode** (type_alias) - src/adapters/codegraph/codegraph_context.ts:8',
          '### Related Symbols',
          '- src/adapters/codegraph/codegraph_context.ts: buildCodeGraphContext:177, usageJson:263',
        ].join('\n'),
        warnings: [],
        reason: 'EXISTING_INDEX',
      };

      const written = writeCodeGraphContextArtifacts({ runDir, result });
      const atlasJson = JSON.parse(fs.readFileSync(written.repoAtlasJsonArtifact!, 'utf8')) as AtlasJsonForTest;

      expect(atlasJson.sections.candidate_entry_points.map((item) => item.reason)).toEqual([
        expect.stringContaining('entry point: artifactExists'),
        expect.stringContaining('entry point: CodeGraphContextMode'),
      ]);
      expect(atlasJson.sections.related_files_to_inspect.map((item) => item.reason)).toEqual([
        expect.stringContaining('related symbol: buildCodeGraphContext'),
      ]);
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });

  test('repo atlas applies hard bounds to paths from CodeGraph markdown sections', () => {
    const { runDir } = tempRun();
    try {
      const entryPaths = Array.from({ length: 12 }, (_, index) => `src/app/entry${index}.ts`);
      const relatedPaths = Array.from({ length: 14 }, (_, index) => `src/core/related${index}.ts`);
      fs.writeFileSync(
        path.join(runDir, 'scan', 'file_inventory.json'),
        JSON.stringify({ files: [...entryPaths, ...relatedPaths].map((filePath) => ({ path: filePath })) }),
        'utf8',
      );
      const result = {
        ok: true,
        used: true,
        mode: 'use-existing' as const,
        command: ['codegraph', 'context', 'task'],
        outputText: [
          '# CodeGraph Context',
          '### Entry Points',
          ...entryPaths.map((filePath, index) => `- \`${filePath}\` — \`entry${index}\``),
          '### Related Symbols',
          ...relatedPaths.map((filePath, index) => `- \`${filePath}\` — \`related${index}\``),
        ].join('\n'),
        warnings: [],
        reason: 'EXISTING_INDEX',
      };

      const written = writeCodeGraphContextArtifacts({ runDir, result });
      const atlasJson = JSON.parse(fs.readFileSync(written.repoAtlasJsonArtifact!, 'utf8')) as AtlasJsonForTest;

      expect(atlasJson.sections.candidate_entry_points).toHaveLength(8);
      expect(atlasJson.sections.related_files_to_inspect).toHaveLength(10);
      expect(atlasJson.sections.candidate_entry_points.map((item) => item.path)).toEqual(entryPaths.slice(0, 8));
      expect(atlasJson.sections.related_files_to_inspect.map((item) => item.path)).toEqual(relatedPaths.slice(0, 10));
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });

  test('repo atlas extraction dedupes paths, preserves warnings, provenance, and hard bounds', () => {
    const { runDir } = tempRun();
    try {
      const repeated = Array.from({ length: 40 }, (_, index) => `- src/feature/file${index}.ts imports src/shared/common.ts and relates to tests/feature/file${index}.test.ts`).join('\n');
      const result = {
        ok: true,
        used: true,
        mode: 'use-existing' as const,
        command: ['codegraph', 'context', 'task'],
        outputText: [
          '# CodeGraph Context',
          'Entrypoint: src/app/cli/index.ts :: main',
          'Risk: src/core/prompting/pipeline.ts coordinates context build.',
          'Related: src/core/context/flash_compaction.ts -> src/core/context/flash_input_manifest.ts',
          'Duplicate src/core/context/flash_compaction.ts should appear once.',
          repeated,
        ].join('\n'),
        warnings: ['CODEGRAPH_INDEX_STALE: stale but usable'],
        reason: 'EXISTING_INDEX',
      };

      const written = writeCodeGraphContextArtifacts({ runDir, result });
      const atlas = fs.readFileSync(written.repoAtlasArtifact!, 'utf8');
      const atlasJson = JSON.parse(fs.readFileSync(written.repoAtlasJsonArtifact!, 'utf8'));

      expect(atlas.length).toBeLessThan(12_000);
      expect(atlas).toContain('CODEGRAPH_INDEX_STALE');
      expect(atlas).toContain('CodeGraph-derived hints');
      expect(atlas).toContain('inferred recommendations');
      expect((atlas.match(/src\/core\/context\/flash_compaction\.ts/g) ?? []).length).toBe(1);
      expect(atlasJson.sections.likely_relevant_areas.length).toBeLessThanOrEqual(10);
      expect(atlasJson.sections.candidate_entry_points.length).toBeLessThanOrEqual(8);
      expect(atlasJson.sections.related_files_to_inspect.length).toBeLessThanOrEqual(10);
      expect(atlasJson.sections.possible_risk_areas.length).toBeLessThanOrEqual(5);
      expect(atlasJson.warnings).toEqual(['CODEGRAPH_INDEX_STALE: stale but usable']);
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });
});
