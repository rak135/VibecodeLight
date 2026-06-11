import { describe, expect, test } from 'vitest';

import { buildCodebaseGraphScene } from '../../../src/core/codebase_map/scene.js';
import type { CodebaseMapOverview } from '../../../src/core/codebase_map/overview.js';

/**
 * Codebase Graph Scene DTO: renderer-neutral scene data model that can feed
 * both the current 2D Codebase Map and a future 2.5D/3D renderer.
 */

function makeOverview(): CodebaseMapOverview {
  return {
    ok: true,
    repo_root: '/repo',
    generated_at: new Date().toISOString(),
    source: { kind: 'latest_scan', run_id: 'test-run' },
    summary: {
      total_nodes: 6,
      displayed_nodes: 6,
      total_edges: 4,
      displayed_edges: 4,
      truncated: false,
    },
    nodes: [
      { id: 'src/index.ts', path: 'src/index.ts', label: 'index.ts', kind: 'source', group: 'src', language: 'typescript', lines: 50 },
      { id: 'src/utils.ts', path: 'src/utils.ts', label: 'utils.ts', kind: 'source', group: 'src', language: 'typescript', lines: 30, changed: true },
      { id: 'src/utils.test.ts', path: 'src/utils.test.ts', label: 'utils.test.ts', kind: 'test', group: 'src', language: 'typescript', lines: 20 },
      { id: 'src/app.ts', path: 'src/app.ts', label: 'app.ts', kind: 'source', group: 'src', language: 'typescript', lines: 40, entrypoint: true },
      { id: 'README.md', path: 'README.md', label: 'README.md', kind: 'doc', group: '(root)', language: 'markdown', lines: 100 },
      { id: 'tsconfig.json', path: 'tsconfig.json', label: 'tsconfig.json', kind: 'config', group: '(root)', language: 'json', lines: 10 },
    ],
    edges: [
      { id: 'src/index.ts->src/utils.ts:import', from: 'src/index.ts', to: 'src/utils.ts', type: 'import', evidence: 'local' },
      { id: 'src/app.ts->src/index.ts:import', from: 'src/app.ts', to: 'src/index.ts', type: 'import', evidence: 'local' },
      { id: 'src/utils.test.ts->src/utils.ts:test', from: 'src/utils.test.ts', to: 'src/utils.ts', type: 'test', evidence: 'test-target' },
      { id: 'src/app.ts->src/index.ts:folder', from: 'src/app.ts', to: 'src/index.ts', type: 'folder', evidence: 'src' },
    ],
    warnings: [],
  };
}

describe('buildCodebaseGraphScene', () => {
  test('builds scene from overview with correct version and metadata', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    expect(scene.version).toBe(1);
    expect(scene.repo_root).toBe('/repo');
    expect(scene.generated_at).toBeTruthy();
    expect(scene.source.kind).toBe('latest_scan');
    expect(scene.source.run_id).toBe('test-run');
  });

  test('scene includes all nodes from overview', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    expect(scene.nodes.length).toBe(6);
    expect(scene.summary.total_nodes).toBe(6);
  });

  test('scene includes all edges from overview', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    expect(scene.edges.length).toBe(4);
    expect(scene.summary.total_edges).toBe(4);
  });

  test('scene nodes have required fields', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    for (const node of scene.nodes) {
      expect(node.id).toBeTruthy();
      expect(node.path).toBeTruthy();
      expect(node.label).toBeTruthy();
      expect(node.kind).toBeTruthy();
      expect(node.group_id).toBeTruthy();
      expect(node.status).toBeDefined();
    }
  });

  test('scene node status preserves changed and entrypoint', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    const utilsNode = scene.nodes.find((n) => n.id === 'src/utils.ts');
    expect(utilsNode).toBeDefined();
    expect(utilsNode!.status.changed).toBe(true);

    const appNode = scene.nodes.find((n) => n.id === 'src/app.ts');
    expect(appNode).toBeDefined();
    expect(appNode!.status.entrypoint).toBe(true);

    const indexNode = scene.nodes.find((n) => n.id === 'src/index.ts');
    expect(indexNode).toBeDefined();
    expect(indexNode!.status.changed).toBeUndefined();
    expect(indexNode!.status.entrypoint).toBeUndefined();
  });

  test('scene node metrics include imports_out, imports_in, related_tests', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    const utilsNode = scene.nodes.find((n) => n.id === 'src/utils.ts');
    expect(utilsNode).toBeDefined();
    expect(utilsNode!.metrics).toBeDefined();
    expect(utilsNode!.metrics!.imports_in).toBe(1); // imported by index.ts
    expect(utilsNode!.metrics!.imports_out).toBeUndefined(); // 0 values omitted
    expect(utilsNode!.metrics!.related_tests).toBe(1); // utils.test.ts

    const indexNode = scene.nodes.find((n) => n.id === 'src/index.ts');
    expect(indexNode).toBeDefined();
    expect(indexNode!.metrics).toBeDefined();
    expect(indexNode!.metrics!.imports_out).toBe(1); // imports utils.ts
    expect(indexNode!.metrics!.imports_in).toBe(1); // imported by app.ts
  });

  test('scene includes groups with counts', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    expect(scene.groups.length).toBeGreaterThan(0);
    const srcGroup = scene.groups.find((g) => g.id === 'src');
    expect(srcGroup).toBeDefined();
    expect(srcGroup!.counts.files).toBe(4);
    expect(srcGroup!.counts.source).toBe(3);
    expect(srcGroup!.counts.tests).toBe(1);

    const rootGroup = scene.groups.find((g) => g.id === '(root)');
    expect(rootGroup).toBeDefined();
    expect(rootGroup!.counts.files).toBe(2);
    expect(rootGroup!.counts.docs).toBe(1);
    expect(rootGroup!.counts.config).toBe(1);
  });

  test('scene includes legend metadata', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    expect(scene.legend).toBeDefined();
    expect(scene.legend.node_kinds.length).toBeGreaterThan(0);
    expect(scene.legend.edge_types.length).toBeGreaterThan(0);
    expect(scene.legend.status_badges.length).toBeGreaterThan(0);
  });

  test('scene legend node_kinds includes all used kinds', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    const kindIds = scene.legend.node_kinds.map((k) => k.id);
    expect(kindIds).toContain('source');
    expect(kindIds).toContain('test');
    expect(kindIds).toContain('doc');
    expect(kindIds).toContain('config');
  });

  test('scene legend edge_types includes all used types', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    const typeIds = scene.legend.edge_types.map((t) => t.id);
    expect(typeIds).toContain('import');
    expect(typeIds).toContain('test');
    expect(typeIds).toContain('folder');
  });

  test('scene includes camera hints with bounds', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    expect(scene.camera_hints).toBeDefined();
    expect(scene.camera_hints.default_view).toBe('top');
    expect(scene.camera_hints.bounds).toBeDefined();
    expect(scene.camera_hints.bounds.width).toBeGreaterThan(0);
    expect(scene.camera_hints.bounds.height).toBeGreaterThan(0);
  });

  test('scene edges have required fields', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    for (const edge of scene.edges) {
      expect(edge.id).toBeTruthy();
      expect(edge.from).toBeTruthy();
      expect(edge.to).toBeTruthy();
      expect(edge.type).toBeTruthy();
      expect(edge.direction).toBeDefined();
    }
  });

  test('scene handles empty overview', () => {
    const overview = makeOverview();
    overview.nodes = [];
    overview.edges = [];
    overview.summary = { total_nodes: 0, displayed_nodes: 0, total_edges: 0, displayed_edges: 0, truncated: false };

    const scene = buildCodebaseGraphScene(overview);

    expect(scene.nodes.length).toBe(0);
    expect(scene.edges.length).toBe(0);
    expect(scene.groups.length).toBe(0);
    expect(scene.summary.total_nodes).toBe(0);
  });

  test('scene preserves warnings from overview', () => {
    const overview = makeOverview();
    overview.warnings = ['Test warning'];

    const scene = buildCodebaseGraphScene(overview);

    expect(scene.warnings).toContain('Test warning');
  });

  test('scene is deterministic for same input', () => {
    const overview = makeOverview();
    const scene1 = buildCodebaseGraphScene(overview);
    const scene2 = buildCodebaseGraphScene(overview);

    expect(scene1.generated_at).toBe(scene2.generated_at);
    expect(scene1.nodes.length).toBe(scene2.nodes.length);
    expect(scene1.edges.length).toBe(scene2.edges.length);
    expect(scene1.groups.length).toBe(scene2.groups.length);
  });

  test('scene overlays is an empty object by default', () => {
    const overview = makeOverview();
    const scene = buildCodebaseGraphScene(overview);

    expect(scene.overlays).toBeDefined();
    expect(typeof scene.overlays).toBe('object');
  });
});
