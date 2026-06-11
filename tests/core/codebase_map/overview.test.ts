import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildCodebaseMapOverview } from '../../../src/core/codebase_map/overview.js';

/**
 * Codebase Map overview builder: builds a bounded read-only 2D graph DTO
 * from existing deterministic scan artifacts. Never runs the scanner.
 */

function makeRunDir(repoRoot: string, artifacts: Record<string, unknown>): string {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cmap-run-'));
  const scanDir = path.join(runDir, 'scan');
  fs.mkdirSync(scanDir, { recursive: true });
  for (const [name, value] of Object.entries(artifacts)) {
    const filePath = path.join(scanDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (name.endsWith('.json')) {
      fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
    } else {
      fs.writeFileSync(filePath, String(value), 'utf8');
    }
  }
  // Write a minimal run_manifest.json
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({ run_id: 'test-run-001', created_at: new Date().toISOString() }),
    'utf8',
  );
  return runDir;
}

const SIMPLE_INVENTORY = [
  { path: 'src/index.ts', extension: '.ts', kind: 'source', bytes: 100, lines: 10 },
  { path: 'src/utils.ts', extension: '.ts', kind: 'source', bytes: 200, lines: 20 },
  { path: 'src/utils.test.ts', extension: '.ts', kind: 'test', is_test: true, bytes: 150, lines: 15 },
  { path: 'README.md', extension: '.md', kind: 'doc', is_doc: true, bytes: 500, lines: 30 },
  { path: 'tsconfig.json', extension: '.json', kind: 'config', is_config: true, bytes: 100, lines: 5 },
];

const SIMPLE_IMPORTS = {
  imports: [
    { from_path: 'src/index.ts', import_target: './utils', kind: 'local', line: 1 },
  ],
  warnings: [],
};

const SIMPLE_ENTRYPOINTS = {
  entrypoints: [{ path: 'src/index.ts', type: 'cli', source: 'package.json' }],
  warnings: [],
};

const SIMPLE_TESTS = {
  tests: [
    {
      path: 'src/utils.test.ts',
      language_guess: 'typescript',
      test_framework_guess: 'vitest',
      test_names: ['adds correctly'],
      likely_targets: ['src/utils.ts'],
    },
  ],
  test_configs: [{ path: 'vitest.config.ts', framework: 'vitest' }],
  warnings: [],
};

const SIMPLE_GIT_STATUS = {
  git_available: true,
  branch: 'main',
  head_commit: 'abc123',
  dirty: true,
  modified: ['src/utils.ts'],
  untracked: [],
  staged: [],
};

describe('codebase map overview builder', () => {
  let repoRoot: string;
  let runDir: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cmap-repo-'));
    runDir = makeRunDir(repoRoot, {
      'file_inventory.json': SIMPLE_INVENTORY,
      'imports.json': SIMPLE_IMPORTS,
      'entrypoints.json': SIMPLE_ENTRYPOINTS,
      'tests.json': SIMPLE_TESTS,
      'git_status.json': SIMPLE_GIT_STATUS,
    });
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('returns ok with nodes and edges from scan artifacts', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    expect(result.ok).toBe(true);
    expect(result.repo_root).toBe(repoRoot);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);
    expect(result.summary.total_nodes).toBe(result.nodes.length);
    expect(result.summary.total_edges).toBe(result.edges.length);
    expect(result.summary.truncated).toBe(false);
  });

  test('classifies file kinds correctly', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    const byPath = new Map(result.nodes.map((n) => [n.path, n]));
    expect(byPath.get('src/index.ts')?.kind).toBe('source');
    expect(byPath.get('src/utils.ts')?.kind).toBe('source');
    expect(byPath.get('src/utils.test.ts')?.kind).toBe('test');
    expect(byPath.get('README.md')?.kind).toBe('doc');
    expect(byPath.get('tsconfig.json')?.kind).toBe('config');
  });

  test('derives group from top-level directory', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    const byPath = new Map(result.nodes.map((n) => [n.path, n]));
    expect(byPath.get('src/index.ts')?.group).toBe('src');
    expect(byPath.get('README.md')?.group).toBe('(root)');
  });

  test('derives label from filename', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    const byPath = new Map(result.nodes.map((n) => [n.path, n]));
    expect(byPath.get('src/index.ts')?.label).toBe('index.ts');
    expect(byPath.get('README.md')?.label).toBe('README.md');
  });

  test('marks entrypoints', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    const byPath = new Map(result.nodes.map((n) => [n.path, n]));
    expect(byPath.get('src/index.ts')?.entrypoint).toBe(true);
    expect(byPath.get('src/utils.ts')?.entrypoint).toBeUndefined();
  });

  test('marks changed files from git status', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    const byPath = new Map(result.nodes.map((n) => [n.path, n]));
    expect(byPath.get('src/utils.ts')?.changed).toBe(true);
    expect(byPath.get('src/index.ts')?.changed).toBeUndefined();
  });

  test('creates import edges between known local modules', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    const importEdges = result.edges.filter((e) => e.type === 'import');
    expect(importEdges.length).toBeGreaterThanOrEqual(1);
    const edge = importEdges.find((e) => e.from === 'src/index.ts' && e.to === 'src/utils.ts');
    expect(edge).toBeDefined();
    expect(edge?.evidence).toBe('local');
  });

  test('creates test edges from test to likely_targets', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    const testEdges = result.edges.filter((e) => e.type === 'test');
    expect(testEdges.length).toBeGreaterThanOrEqual(1);
    const edge = testEdges.find((e) => e.from === 'src/utils.test.ts' && e.to === 'src/utils.ts');
    expect(edge).toBeDefined();
  });

  test('creates folder edges within same group', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    const folderEdges = result.edges.filter((e) => e.type === 'folder');
    expect(folderEdges.length).toBeGreaterThanOrEqual(1);
  });

  test('respects maxNodes cap and sets truncated flag', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir, { maxNodes: 3 });

    expect(result.nodes.length).toBe(3);
    expect(result.summary.total_nodes).toBe(5);
    expect(result.summary.displayed_nodes).toBe(3);
    expect(result.summary.truncated).toBe(true);
    expect(result.warnings.some((w) => w.includes('Node cap'))).toBe(true);
  });

  test('respects maxEdges cap', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir, { maxEdges: 1 });

    expect(result.edges.length).toBe(1);
    expect(result.summary.total_edges).toBeGreaterThanOrEqual(1);
    expect(result.summary.displayed_edges).toBe(1);
    expect(result.summary.truncated).toBe(true);
  });

  test('default behavior includes all nodes without a hard 200-node cap', () => {
    // Generate a large inventory with 300 files
    const largeInventory = Array.from({ length: 300 }, (_, i) => ({
      path: `src/module${i}.ts`,
      extension: '.ts',
      kind: 'source',
      bytes: 100,
      lines: 10,
    }));
    const largeRunDir = makeRunDir(repoRoot, {
      'file_inventory.json': largeInventory,
      'imports.json': { imports: [], warnings: [] },
      'entrypoints.json': { entrypoints: [], warnings: [] },
      'tests.json': { tests: [], test_configs: [], warnings: [] },
      'git_status.json': { git_available: false, branch: '', head_commit: '', dirty: false, modified: [], untracked: [], staged: [] },
    });

    try {
      const result = buildCodebaseMapOverview(repoRoot, largeRunDir);

      expect(result.nodes.length).toBe(300);
      expect(result.summary.total_nodes).toBe(300);
      expect(result.summary.displayed_nodes).toBe(300);
      // No node truncation warning
      expect(result.warnings.some((w) => w.includes('nodes'))).toBe(false);
    } finally {
      fs.rmSync(largeRunDir, { recursive: true, force: true });
    }
  });

  test('summary reports displayed_nodes == total_nodes when no maxNodes cap', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    expect(result.summary.displayed_nodes).toBe(result.summary.total_nodes);
    expect(result.summary.truncated).toBe(false);
  });

  test('only edge truncation warning is emitted when edges are capped but nodes are not', () => {
    // Create inventory with many import edges possible
    const manyImports = Array.from({ length: 5 }, (_, i) => ({
      from_path: `src/file${i}.ts`,
      import_target: `./file${i + 1}`,
      kind: 'local',
      line: 1,
    }));
    const inventory = Array.from({ length: 7 }, (_, i) => ({
      path: `src/file${i}.ts`,
      extension: '.ts',
      kind: 'source',
      bytes: 100,
      lines: 10,
    }));
    const edgeCapRunDir = makeRunDir(repoRoot, {
      'file_inventory.json': inventory,
      'imports.json': { imports: manyImports, warnings: [] },
      'entrypoints.json': { entrypoints: [], warnings: [] },
      'tests.json': { tests: [], test_configs: [], warnings: [] },
      'git_status.json': { git_available: false, branch: '', head_commit: '', dirty: false, modified: [], untracked: [], staged: [] },
    });

    try {
      const result = buildCodebaseMapOverview(repoRoot, edgeCapRunDir, { maxEdges: 2 });

      // All nodes should be present
      expect(result.nodes.length).toBe(7);
      expect(result.summary.displayed_nodes).toBe(7);
      // Edges should be capped
      expect(result.edges.length).toBe(2);
      expect(result.summary.displayed_edges).toBe(2);
      // Warning should mention edges only
      const edgeWarning = result.warnings.find((w) => w.includes('Edge cap'));
      expect(edgeWarning).toBeDefined();
      expect(edgeWarning).toContain('edges');
      // Should NOT have a node cap warning
      expect(result.warnings.some((w) => w.includes('Node cap'))).toBe(false);
    } finally {
      fs.rmSync(edgeCapRunDir, { recursive: true, force: true });
    }
  });

  test('sets source kind to latest_scan when run_manifest exists', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    expect(result.source.kind).toBe('latest_scan');
    expect(result.source.run_id).toBe('test-run-001');
  });

  test('returns fallback with warning when no scan artifacts exist', () => {
    const emptyRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cmap-empty-'));
    fs.mkdirSync(path.join(emptyRunDir, 'scan'), { recursive: true });
    try {
      const result = buildCodebaseMapOverview(repoRoot, emptyRunDir);

      expect(result.ok).toBe(true);
      expect(result.source.kind).toBe('fallback');
      expect(result.nodes.length).toBe(0);
      expect(result.edges.length).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(emptyRunDir, { recursive: true, force: true });
    }
  });

  test('populates language field from extension', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    const byPath = new Map(result.nodes.map((n) => [n.path, n]));
    expect(byPath.get('src/index.ts')?.language).toBe('typescript');
    expect(byPath.get('README.md')?.language).toBe('markdown');
    expect(byPath.get('tsconfig.json')?.language).toBe('json');
  });

  test('generated_at is an ISO timestamp', () => {
    const result = buildCodebaseMapOverview(repoRoot, runDir);

    expect(result.generated_at).toBeTruthy();
    const parsed = new Date(result.generated_at);
    expect(parsed.getTime()).not.toBeNaN();
  });
});
