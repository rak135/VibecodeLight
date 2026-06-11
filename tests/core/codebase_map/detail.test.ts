import { describe, expect, test } from 'vitest';

import {
  getNodeDetail,
  getConnectedNeighborhood,
  filterOverviewNodes,
  searchNodes,
  getNodeCenter,
} from '../../../src/core/codebase_map/detail.js';
import type { CodebaseMapOverview } from '../../../src/core/codebase_map/overview.js';

/**
 * Codebase Map detail helpers: pure functions that derive node detail,
 * neighborhood connections, and filtered/searched node sets from an
 * existing CodebaseMapOverview DTO. These helpers are renderer-neutral
 * and testable in isolation.
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

describe('getNodeDetail', () => {
  test('returns full detail for a known node', () => {
    const overview = makeOverview();
    const detail = getNodeDetail(overview, 'src/utils.ts');

    expect(detail).not.toBeNull();
    expect(detail!.path).toBe('src/utils.ts');
    expect(detail!.label).toBe('utils.ts');
    expect(detail!.kind).toBe('source');
    expect(detail!.group).toBe('src');
    expect(detail!.language).toBe('typescript');
    expect(detail!.lines).toBe(30);
    expect(detail!.changed).toBe(true);
    expect(detail!.entrypoint).toBe(false);
  });

  test('returns null for unknown node id', () => {
    const overview = makeOverview();
    const detail = getNodeDetail(overview, 'nonexistent.ts');
    expect(detail).toBeNull();
  });

  test('returns imports_out list', () => {
    const overview = makeOverview();
    const detail = getNodeDetail(overview, 'src/index.ts');

    expect(detail).not.toBeNull();
    expect(detail!.imports_out).toEqual(['src/utils.ts']);
  });

  test('returns imports_in list', () => {
    const overview = makeOverview();
    const detail = getNodeDetail(overview, 'src/utils.ts');

    expect(detail).not.toBeNull();
    expect(detail!.imports_in).toEqual(['src/index.ts']);
  });

  test('returns related_tests list', () => {
    const overview = makeOverview();
    const detail = getNodeDetail(overview, 'src/utils.ts');

    expect(detail).not.toBeNull();
    expect(detail!.related_tests).toEqual(['src/utils.test.ts']);
  });

  test('returns empty related_tests when none exist', () => {
    const overview = makeOverview();
    const detail = getNodeDetail(overview, 'src/index.ts');

    expect(detail).not.toBeNull();
    expect(detail!.related_tests).toEqual([]);
  });

  test('returns edge evidence for connected edges', () => {
    const overview = makeOverview();
    const detail = getNodeDetail(overview, 'src/utils.ts');

    expect(detail).not.toBeNull();
    expect(detail!.edge_evidence.length).toBeGreaterThan(0);
    expect(detail!.edge_evidence[0]).toHaveProperty('edge_id');
    expect(detail!.edge_evidence[0]).toHaveProperty('type');
    expect(detail!.edge_evidence[0]).toHaveProperty('evidence');
  });

  test('entrypoint node has entrypoint=true', () => {
    const overview = makeOverview();
    const detail = getNodeDetail(overview, 'src/app.ts');

    expect(detail).not.toBeNull();
    expect(detail!.entrypoint).toBe(true);
  });

  test('non-changed node has changed=false', () => {
    const overview = makeOverview();
    const detail = getNodeDetail(overview, 'src/index.ts');

    expect(detail).not.toBeNull();
    expect(detail!.changed).toBe(false);
  });
});

describe('getConnectedNeighborhood', () => {
  test('returns directly connected nodes and edges', () => {
    const overview = makeOverview();
    const neighborhood = getConnectedNeighborhood(overview, 'src/utils.ts');

    expect(neighborhood.nodeIds.has('src/utils.ts')).toBe(true); // self
    expect(neighborhood.nodeIds.has('src/index.ts')).toBe(true); // imports_in
    expect(neighborhood.nodeIds.has('src/utils.test.ts')).toBe(true); // related test
    expect(neighborhood.edgeIds.size).toBeGreaterThan(0);
  });

  test('returns empty neighborhood for unknown node', () => {
    const overview = makeOverview();
    const neighborhood = getConnectedNeighborhood(overview, 'nonexistent.ts');

    expect(neighborhood.nodeIds.size).toBe(0);
    expect(neighborhood.edgeIds.size).toBe(0);
  });

  test('includes import edges in both directions', () => {
    const overview = makeOverview();
    const neighborhood = getConnectedNeighborhood(overview, 'src/index.ts');

    // src/index.ts imports src/utils.ts (outgoing)
    expect(neighborhood.nodeIds.has('src/utils.ts')).toBe(true);
    // src/app.ts imports src/index.ts (incoming)
    expect(neighborhood.nodeIds.has('src/app.ts')).toBe(true);
  });

  test('includes test edges', () => {
    const overview = makeOverview();
    const neighborhood = getConnectedNeighborhood(overview, 'src/utils.ts');

    expect(neighborhood.nodeIds.has('src/utils.test.ts')).toBe(true);
  });

  test('self is always included', () => {
    const overview = makeOverview();
    const neighborhood = getConnectedNeighborhood(overview, 'src/app.ts');

    expect(neighborhood.nodeIds.has('src/app.ts')).toBe(true);
  });
});

describe('filterOverviewNodes', () => {
  test('returns all nodes when filter is all and no search', () => {
    const overview = makeOverview();
    const filtered = filterOverviewNodes(overview.nodes, 'all', '');

    expect(filtered.length).toBe(6);
  });

  test('filters by kind', () => {
    const overview = makeOverview();
    const filtered = filterOverviewNodes(overview.nodes, 'source', '');

    expect(filtered.length).toBe(3); // index.ts, utils.ts, app.ts
    expect(filtered.every((n) => n.kind === 'source')).toBe(true);
  });

  test('filters by test kind', () => {
    const overview = makeOverview();
    const filtered = filterOverviewNodes(overview.nodes, 'test', '');

    expect(filtered.length).toBe(1);
    expect(filtered[0].kind).toBe('test');
  });

  test('filters by search query matching path', () => {
    const overview = makeOverview();
    const filtered = filterOverviewNodes(overview.nodes, 'all', 'utils');

    expect(filtered.length).toBe(2); // utils.ts and utils.test.ts
  });

  test('filters by search query matching label', () => {
    const overview = makeOverview();
    const filtered = filterOverviewNodes(overview.nodes, 'all', 'README');

    expect(filtered.length).toBe(1);
    expect(filtered[0].label).toBe('README.md');
  });

  test('combines kind filter and search query', () => {
    const overview = makeOverview();
    const filtered = filterOverviewNodes(overview.nodes, 'source', 'utils');

    expect(filtered.length).toBe(1); // only src/utils.ts
    expect(filtered[0].kind).toBe('source');
  });

  test('returns empty when no matches', () => {
    const overview = makeOverview();
    const filtered = filterOverviewNodes(overview.nodes, 'all', 'nonexistent');

    expect(filtered.length).toBe(0);
  });

  test('entrypoints filter returns only entrypoint nodes', () => {
    const overview = makeOverview();
    const filtered = filterOverviewNodes(overview.nodes, 'entrypoints', '');

    expect(filtered.length).toBe(1);
    expect(filtered[0].entrypoint).toBe(true);
  });

  test('changed filter returns only changed nodes', () => {
    const overview = makeOverview();
    const filtered = filterOverviewNodes(overview.nodes, 'changed', '');

    expect(filtered.length).toBe(1);
    expect(filtered[0].changed).toBe(true);
  });

  test('entrypoints filter returns empty when no entrypoints', () => {
    const overview = makeOverview();
    overview.nodes.forEach((n) => { n.entrypoint = undefined; });
    const filtered = filterOverviewNodes(overview.nodes, 'entrypoints', '');

    expect(filtered.length).toBe(0);
  });

  test('changed filter returns empty when no changed files', () => {
    const overview = makeOverview();
    overview.nodes.forEach((n) => { n.changed = undefined; });
    const filtered = filterOverviewNodes(overview.nodes, 'changed', '');

    expect(filtered.length).toBe(0);
  });
});

describe('searchNodes', () => {
  test('returns matching nodes', () => {
    const overview = makeOverview();
    const results = searchNodes(overview.nodes, 'utils');

    expect(results.length).toBe(2);
  });

  test('returns empty for no match', () => {
    const overview = makeOverview();
    const results = searchNodes(overview.nodes, 'nonexistent');

    expect(results.length).toBe(0);
  });

  test('case insensitive search', () => {
    const overview = makeOverview();
    const results = searchNodes(overview.nodes, 'README');

    expect(results.length).toBe(1);
  });

  test('search matches partial path', () => {
    const overview = makeOverview();
    const results = searchNodes(overview.nodes, 'src/');

    expect(results.length).toBe(4); // all src/ files
  });
});

describe('getNodeCenter', () => {
  test('returns center position for a node in layout', () => {
    const positions = new Map<string, { x: number; y: number }>();
    positions.set('src/index.ts', { x: 100, y: 200 });

    const NODE_W = 140;
    const NODE_H = 32;

    const center = getNodeCenter(positions, 'src/index.ts', NODE_W, NODE_H);

    expect(center).not.toBeNull();
    expect(center!.x).toBe(100 + NODE_W / 2);
    expect(center!.y).toBe(200 + NODE_H / 2);
  });

  test('returns null for unknown node', () => {
    const positions = new Map<string, { x: number; y: number }>();

    const center = getNodeCenter(positions, 'unknown.ts', 140, 32);

    expect(center).toBeNull();
  });
});
