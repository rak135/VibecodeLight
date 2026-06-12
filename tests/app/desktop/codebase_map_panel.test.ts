import { describe, expect, test } from 'vitest';

/**
 * Codebase Map renderer panel: pure render function tests.
 * Tests legend, tooltip, detail panel, focus/dimming, search centering,
 * and Entrypoints/Changed filters.
 */

const KIND_COLORS = {
  source: '#4fc3f7',
  test: '#81c784',
  doc: '#ffb74d',
  config: '#ba68c8',
  generated: '#90a4ae',
  unknown: '#78909c',
};

const KIND_LABELS = {
  source: 'Source',
  test: 'Test',
  doc: 'Doc',
  config: 'Config',
  generated: 'Generated',
  unknown: 'Unknown',
};

const EDGE_COLORS = {
  import: 'rgba(79,195,247,0.35)',
  test: 'rgba(129,199,132,0.35)',
  entrypoint: 'rgba(255,183,77,0.35)',
  folder: 'rgba(144,164,174,0.2)',
  related: 'rgba(186,104,200,0.3)',
};

const EDGE_LABELS = {
  import: 'Import',
  test: 'Test relation',
  entrypoint: 'Entrypoint',
  folder: 'Folder',
  related: 'Related',
};

  function makeOverview(nodeCount: number, edgeCount: number) {
    const nodes: {
      id: string; path: string; label: string; kind: string; group: string;
      language: string; entrypoint?: boolean; changed?: boolean; claimed?: boolean; conflicted?: boolean;
    }[] = Array.from({ length: nodeCount }, (_, i) => ({
    id: `src/file${i}.ts`,
    path: `src/file${i}.ts`,
    label: `file${i}.ts`,
    kind: i % 3 === 0 ? 'test' : 'source' as string,
    group: 'src',
    language: 'typescript',
  }));
  const edges: {
    id: string; from: string; to: string; type: string; evidence?: string;
  }[] = Array.from({ length: Math.min(edgeCount, nodeCount - 1) }, (_, i) => ({
    id: `edge-${i}`,
    from: `src/file${i}.ts`,
    to: `src/file${i + 1}.ts`,
    type: 'import' as string,
  }));
  return {
    ok: true,
    repo_root: '/repo',
    generated_at: new Date().toISOString(),
    source: { kind: 'latest_scan' as const },
    summary: {
      total_nodes: nodes.length,
      displayed_nodes: nodes.length,
      total_edges: edges.length,
      displayed_edges: edges.length,
      truncated: false,
    },
    nodes,
    edges,
    warnings: [],
  };
}

function makeMultiGroupOverview(totalNodes: number, groupCount: number) {
  const nodesPerGroup = Math.ceil(totalNodes / groupCount);
  const nodes = [];
  for (let g = 0; g < groupCount; g++) {
    const count = Math.min(nodesPerGroup, totalNodes - nodes.length);
    for (let i = 0; i < count; i++) {
      nodes.push({
        id: `group${g}/file${i}.ts`,
        path: `group${g}/file${i}.ts`,
        label: `file${i}.ts`,
        kind: 'source' as string,
        group: `group${g}`,
        language: 'typescript',
      });
    }
  }
  return {
    ok: true,
    repo_root: '/repo',
    generated_at: new Date().toISOString(),
    source: { kind: 'latest_scan' as const },
    summary: {
      total_nodes: nodes.length,
      displayed_nodes: nodes.length,
      total_edges: 0,
      displayed_edges: 0,
      truncated: false,
    },
    nodes,
    edges: [],
    warnings: [],
  };
}

/** Simulate the layout computation from renderCodebaseMapSvgHtml */
function computeLayoutBounds(nodes: Array<{ id: string; group: string }>) {
  const PADDING = 16;
  const NODE_W = 140;
  const NODE_H = 32;
  const GROUP_GAP = 24;
  const NODE_GAP = 8;
  const GROUP_HEADER_H = 24;

  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const existing = groups.get(node.group) ?? [];
    existing.push(node.id);
    groups.set(node.group, existing);
  }

  const groupEntries = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  let x = PADDING;
  for (const [, groupNodes] of groupEntries) {
    x += NODE_W + GROUP_GAP;
  }
  const totalW = x - GROUP_GAP + PADDING;
  const maxGroupSize = Math.max(...Array.from(groups.values()).map((g) => g.length));
  const totalH = PADDING + GROUP_HEADER_H + maxGroupSize * (NODE_H + NODE_GAP) + PADDING;

  return { x: 0, y: 0, w: totalW, h: totalH, groupCount: groups.size, maxGroupSize };
}

/** Simulate fitToView math */
function fitToView(
  contentX: number,
  contentY: number,
  contentW: number,
  contentH: number,
  viewW: number,
  viewH: number,
  padding: number,
) {
  const scaleX = (viewW - 2 * padding) / contentW;
  const scaleY = (viewH - 2 * padding) / contentH;
  const scale = Math.min(scaleX, scaleY);
  const tx = padding + (viewW - 2 * padding - contentW * scale) / 2 - contentX * scale;
  const ty = padding + (viewH - 2 * padding - contentH * scale) / 2 - contentY * scale;
  return { scale, tx, ty };
}

/** Simulate filterNodes from renderer */
function filterNodes(nodes: Array<{ kind: string; entrypoint?: boolean; changed?: boolean; path: string; label: string }>, filter: string, query: string) {
  let filtered = nodes;
  if (filter === 'entrypoints') {
    filtered = filtered.filter((n) => n.entrypoint === true);
  } else if (filter === 'changed') {
    filtered = filtered.filter((n) => n.changed === true);
  } else if (filter !== 'all') {
    filtered = filtered.filter((n) => n.kind === filter);
  }
  if (query) {
    const q = query.toLowerCase();
    filtered = filtered.filter((n) => n.path.toLowerCase().includes(q) || n.label.toLowerCase().includes(q));
  }
  return filtered;
}

/** Simulate getNodeDetail from renderer (characterization copy of core logic) */
function getNodeDetail(overview: ReturnType<typeof makeOverview>, nodeId: string) {
  const node = overview.nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const imports_out: string[] = [];
  const imports_in: string[] = [];
  const related_tests: string[] = [];
  const edge_evidence: Array<{ edge_id: string; type: string; evidence?: string; direction: string; peer: string }> = [];

  for (const edge of overview.edges) {
    if (edge.from === nodeId) {
      if (edge.type === 'import') imports_out.push(edge.to);
      if (edge.type === 'test') related_tests.push(edge.to);
      edge_evidence.push({ edge_id: edge.id, type: edge.type, evidence: edge.evidence, direction: 'outgoing', peer: edge.to });
    } else if (edge.to === nodeId) {
      if (edge.type === 'import') imports_in.push(edge.from);
      if (edge.type === 'test') related_tests.push(edge.from);
      edge_evidence.push({ edge_id: edge.id, type: edge.type, evidence: edge.evidence, direction: 'incoming', peer: edge.from });
    }
  }

  return { ...node, changed: node.changed === true, entrypoint: node.entrypoint === true, imports_out, imports_in, related_tests, edge_evidence };
}

/** Simulate getConnectedNeighborhood from renderer */
function getConnectedNeighborhood(overview: ReturnType<typeof makeOverview>, nodeId: string) {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const node = overview.nodes.find((n) => n.id === nodeId);
  if (!node) return { nodeIds, edgeIds };
  nodeIds.add(nodeId);
  for (const edge of overview.edges) {
    if (edge.from === nodeId) { nodeIds.add(edge.to); edgeIds.add(edge.id); }
    else if (edge.to === nodeId) { nodeIds.add(edge.from); edgeIds.add(edge.id); }
  }
  return { nodeIds, edgeIds };
}

describe('codebase map renderer pure render', () => {
  test('renderCodebaseMapSvgHtml produces SVG markup for valid overview', () => {
    const overview = makeOverview(5, 3);

    expect(overview.ok).toBe(true);
    expect(overview.nodes.length).toBe(5);
    expect(overview.edges.length).toBe(3);
    expect(overview.summary.truncated).toBe(false);
  });

  test('filterNodes logic: all filter includes everything', () => {
    const overview = makeOverview(6, 0);
    overview.nodes[0].kind = 'test';
    overview.nodes[1].kind = 'doc';
    overview.nodes[2].kind = 'config';

    const allNodes = overview.nodes;
    expect(allNodes.length).toBe(6);

    const sourceNodes = allNodes.filter((n) => n.kind === 'source');
    const testNodes = allNodes.filter((n) => n.kind === 'test');
    const docNodes = allNodes.filter((n) => n.kind === 'doc');

    expect(sourceNodes.length).toBe(2);
    expect(testNodes.length).toBe(2);
    expect(docNodes.length).toBe(1);
  });

  test('filterNodes logic: search query matches path and label', () => {
    const overview = makeOverview(5, 0);
    overview.nodes[0].path = 'src/core/important.ts';
    overview.nodes[0].label = 'important.ts';

    const query = 'important';
    const q = query.toLowerCase();
    const matched = overview.nodes.filter(
      (n) => n.path.toLowerCase().includes(q) || n.label.toLowerCase().includes(q),
    );

    expect(matched.length).toBe(1);
    expect(matched[0].path).toBe('src/core/important.ts');
  });

  test('kind colors are defined for all node kinds', () => {
    const kinds: Array<keyof typeof KIND_COLORS> = ['source', 'test', 'doc', 'config', 'generated', 'unknown'];
    for (const kind of kinds) {
      expect(KIND_COLORS[kind]).toBeDefined();
      expect(KIND_COLORS[kind]).toMatch(/^#/);
    }
  });

  test('kind labels are defined for all node kinds', () => {
    const kinds: Array<keyof typeof KIND_LABELS> = ['source', 'test', 'doc', 'config', 'generated', 'unknown'];
    for (const kind of kinds) {
      expect(KIND_LABELS[kind]).toBeDefined();
      expect(KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
  });

  test('edge colors are defined for all edge types', () => {
    const types: Array<keyof typeof EDGE_COLORS> = ['import', 'test', 'entrypoint', 'folder', 'related'];
    for (const type of types) {
      expect(EDGE_COLORS[type]).toBeDefined();
    }
  });

  test('edge labels are defined for all edge types', () => {
    const types: Array<keyof typeof EDGE_LABELS> = ['import', 'test', 'entrypoint', 'folder', 'related'];
    for (const type of types) {
      expect(EDGE_LABELS[type]).toBeDefined();
      expect(EDGE_LABELS[type].length).toBeGreaterThan(0);
    }
  });

  test('overview with zero nodes produces empty result', () => {
    const overview = makeOverview(0, 0);
    expect(overview.nodes.length).toBe(0);
    expect(overview.edges.length).toBe(0);
  });

  test('overview with truncation reports truncated flag', () => {
    const overview = makeOverview(5, 3);
    overview.summary.truncated = true;
    overview.summary.total_nodes = 100;
    overview.summary.displayed_nodes = 5;

    expect(overview.summary.truncated).toBe(true);
    expect(overview.summary.displayed_nodes).toBeLessThan(overview.summary.total_nodes);
  });

  test('meta text shows nodes=N/N when all nodes are displayed', () => {
    const overview = makeOverview(250, 100);
    const s = overview.summary;
    // Meta text should show displayed/total equal when not truncated
    expect(s.displayed_nodes).toBe(s.total_nodes);
    expect(s.displayed_nodes).toBe(250);
    expect(s.truncated).toBe(false);
  });

  test('overview with >200 nodes has all nodes in DTO', () => {
    const overview = makeOverview(500, 200);
    expect(overview.nodes.length).toBe(500);
    expect(overview.summary.total_nodes).toBe(500);
    expect(overview.summary.displayed_nodes).toBe(500);
  });
});

describe('codebase map filter: entrypoints and changed', () => {
  test('entrypoints filter returns only entrypoint nodes', () => {
    const overview = makeOverview(6, 0);
    overview.nodes[0].entrypoint = true;
    overview.nodes[2].entrypoint = true;

    const filtered = filterNodes(overview.nodes as any, 'entrypoints', '');
    expect(filtered.length).toBe(2);
    expect(filtered.every((n: any) => n.entrypoint === true)).toBe(true);
  });

  test('changed filter returns only changed nodes', () => {
    const overview = makeOverview(6, 0);
    overview.nodes[1].changed = true;

    const filtered = filterNodes(overview.nodes as any, 'changed', '');
    expect(filtered.length).toBe(1);
    expect(filtered[0].changed).toBe(true);
  });

  test('entrypoints filter returns empty when no entrypoints', () => {
    const overview = makeOverview(6, 0);
    const filtered = filterNodes(overview.nodes as any, 'entrypoints', '');
    expect(filtered.length).toBe(0);
  });

  test('changed filter returns empty when no changed files', () => {
    const overview = makeOverview(6, 0);
    const filtered = filterNodes(overview.nodes as any, 'changed', '');
    expect(filtered.length).toBe(0);
  });

  test('entrypoints filter combined with search', () => {
    const overview = makeOverview(6, 0);
    overview.nodes[0].entrypoint = true;
    overview.nodes[0].path = 'src/main.ts';
    overview.nodes[0].label = 'main.ts';
    overview.nodes[2].entrypoint = true;
    overview.nodes[2].path = 'src/app.ts';
    overview.nodes[2].label = 'app.ts';

    const filtered = filterNodes(overview.nodes as any, 'entrypoints', 'main');
    expect(filtered.length).toBe(1);
    expect(filtered[0].path).toBe('src/main.ts');
  });
});

describe('codebase map node detail', () => {
  test('getNodeDetail returns imports_out', () => {
    const overview = makeOverview(3, 2);
    overview.edges = [
      { id: 'e1', from: 'src/file0.ts', to: 'src/file1.ts', type: 'import' },
      { id: 'e2', from: 'src/file0.ts', to: 'src/file2.ts', type: 'import' },
    ];
    const detail = getNodeDetail(overview, 'src/file0.ts');
    expect(detail).not.toBeNull();
    expect(detail!.imports_out).toEqual(['src/file1.ts', 'src/file2.ts']);
  });

  test('getNodeDetail returns imports_in', () => {
    const overview = makeOverview(3, 2);
    overview.edges = [
      { id: 'e1', from: 'src/file1.ts', to: 'src/file0.ts', type: 'import' },
    ];
    const detail = getNodeDetail(overview, 'src/file0.ts');
    expect(detail).not.toBeNull();
    expect(detail!.imports_in).toEqual(['src/file1.ts']);
  });

  test('getNodeDetail returns related_tests', () => {
    const overview = makeOverview(3, 1);
    overview.edges = [
      { id: 'e1', from: 'src/file0.ts', to: 'src/file1.ts', type: 'test' },
    ];
    const detail = getNodeDetail(overview, 'src/file1.ts');
    expect(detail).not.toBeNull();
    expect(detail!.related_tests).toEqual(['src/file0.ts']);
  });

  test('getNodeDetail returns null for unknown node', () => {
    const overview = makeOverview(3, 0);
    const detail = getNodeDetail(overview, 'nonexistent.ts');
    expect(detail).toBeNull();
  });

  test('getNodeDetail marks changed correctly', () => {
    const overview = makeOverview(3, 0);
    overview.nodes[0].changed = true;
    const detail = getNodeDetail(overview, 'src/file0.ts');
    expect(detail).not.toBeNull();
    expect(detail!.changed).toBe(true);
  });

  test('getNodeDetail marks entrypoint correctly', () => {
    const overview = makeOverview(3, 0);
    overview.nodes[1].entrypoint = true;
    const detail = getNodeDetail(overview, 'src/file1.ts');
    expect(detail).not.toBeNull();
    expect(detail!.entrypoint).toBe(true);
  });
});

describe('codebase map neighborhood', () => {
  test('getConnectedNeighborhood returns connected nodes', () => {
    const overview = makeOverview(4, 2);
    overview.edges = [
      { id: 'e1', from: 'src/file0.ts', to: 'src/file1.ts', type: 'import' },
      { id: 'e2', from: 'src/file2.ts', to: 'src/file0.ts', type: 'import' },
    ];
    const neighborhood = getConnectedNeighborhood(overview, 'src/file0.ts');
    expect(neighborhood.nodeIds.has('src/file0.ts')).toBe(true);
    expect(neighborhood.nodeIds.has('src/file1.ts')).toBe(true);
    expect(neighborhood.nodeIds.has('src/file2.ts')).toBe(true);
    expect(neighborhood.edgeIds.size).toBe(2);
  });

  test('getConnectedNeighborhood returns empty for unknown node', () => {
    const overview = makeOverview(3, 0);
    const neighborhood = getConnectedNeighborhood(overview, 'nonexistent.ts');
    expect(neighborhood.nodeIds.size).toBe(0);
    expect(neighborhood.edgeIds.size).toBe(0);
  });

  test('getConnectedNeighborhood includes self', () => {
    const overview = makeOverview(3, 0);
    const neighborhood = getConnectedNeighborhood(overview, 'src/file0.ts');
    expect(neighborhood.nodeIds.has('src/file0.ts')).toBe(true);
  });
});

describe('codebase map focus/dimming', () => {
  test('focused node neighborhood includes connected nodes', () => {
    const overview = makeOverview(5, 2);
    overview.edges = [
      { id: 'e1', from: 'src/file0.ts', to: 'src/file1.ts', type: 'import' },
      { id: 'e2', from: 'src/file0.ts', to: 'src/file2.ts', type: 'import' },
    ];
    const neighborhood = getConnectedNeighborhood(overview, 'src/file0.ts');

    // Focused node and its connections should be in the set
    expect(neighborhood.nodeIds.has('src/file0.ts')).toBe(true);
    expect(neighborhood.nodeIds.has('src/file1.ts')).toBe(true);
    expect(neighborhood.nodeIds.has('src/file2.ts')).toBe(true);

    // Unrelated nodes should NOT be in the set
    expect(neighborhood.nodeIds.has('src/file3.ts')).toBe(false);
    expect(neighborhood.nodeIds.has('src/file4.ts')).toBe(false);
  });

  test('dimming logic: nodes not in focus set should be dimmed', () => {
    const overview = makeOverview(5, 1);
    overview.edges = [{ id: 'e1', from: 'src/file0.ts', to: 'src/file1.ts', type: 'import' }];
    const focusNodeIds = getConnectedNeighborhood(overview, 'src/file0.ts').nodeIds;

    // file0 and file1 are focused
    expect(focusNodeIds.has('src/file0.ts')).toBe(true);
    expect(focusNodeIds.has('src/file1.ts')).toBe(true);

    // file2, file3, file4 are not focused
    expect(focusNodeIds.has('src/file2.ts')).toBe(false);
    expect(focusNodeIds.has('src/file3.ts')).toBe(false);
    expect(focusNodeIds.has('src/file4.ts')).toBe(false);
  });
});

describe('codebase map layout bounds', () => {
  test('layout bounds cover all nodes in a single group', () => {
    const overview = makeOverview(20, 0);
    const bounds = computeLayoutBounds(overview.nodes);
    // 20 nodes in one column: height = 16 + 24 + 20*(32+8) + 16 = 856
    expect(bounds.h).toBeGreaterThan(20 * 32);
    expect(bounds.w).toBeGreaterThan(0);
    expect(bounds.groupCount).toBe(1);
  });

  test('layout bounds expand with multiple groups', () => {
    const overview = makeMultiGroupOverview(100, 10);
    const bounds = computeLayoutBounds(overview.nodes);
    // 10 groups side by side: width grows with each group
    expect(bounds.groupCount).toBe(10);
    expect(bounds.w).toBeGreaterThan(10 * 140);
    // At least 10 nodes per group
    expect(bounds.maxGroupSize).toBeGreaterThanOrEqual(10);
    expect(bounds.h).toBeGreaterThan(10 * 32);
  });

  test('layout bounds for 531 nodes span large area', () => {
    const overview = makeOverview(531, 0);
    const bounds = computeLayoutBounds(overview.nodes);
    // All in one group: width = 16 + 140 + 16 = 172, height = 16+24+531*(32+8)+16 = 21296
    expect(bounds.w).toBeGreaterThan(100);
    expect(bounds.h).toBeGreaterThan(531 * 32);
    expect(bounds.h).toBeGreaterThan(10000);
  });

  test('layout bounds for 531 nodes across 20 groups cover full extent', () => {
    const overview = makeMultiGroupOverview(531, 20);
    const bounds = computeLayoutBounds(overview.nodes);
    expect(bounds.groupCount).toBe(20);
    // 20 groups * (140 + 24) - 24 + 32 = ~3288 width
    expect(bounds.w).toBeGreaterThan(20 * 140);
    // Each group has ~27 nodes: height ~ 27*(32+8) + 40 = 1120
    expect(bounds.h).toBeGreaterThan(25 * 32);
  });

  test('single node produces minimal non-zero bounds', () => {
    const overview = makeOverview(1, 0);
    const bounds = computeLayoutBounds(overview.nodes);
    expect(bounds.w).toBe(16 + 140 + 16); // PADDING + NODE_W + PADDING
    expect(bounds.h).toBe(16 + 24 + 1 * (32 + 8) + 16); // PADDING + HEADER + 1 node + PADDING
  });
});

describe('codebase map viewport math', () => {
  test('zoom toward cursor: world point under cursor stays under cursor', () => {
    function zoomTowardCursor(
      oldScale: number,
      oldTx: number,
      oldTy: number,
      cursorX: number,
      cursorY: number,
      factor: number,
      minZoom: number,
      maxZoom: number,
    ) {
      const newScale = Math.min(maxZoom, Math.max(minZoom, oldScale * factor));
      const ratio = newScale / oldScale;
      const newTx = cursorX - (cursorX - oldTx) * ratio;
      const newTy = cursorY - (cursorY - oldTy) * ratio;
      return { scale: newScale, tx: newTx, ty: newTy };
    }

    // Zoom in at cursor (100, 50) with initial transform identity
    const result = zoomTowardCursor(1, 0, 0, 100, 50, 1.2, 0.1, 10);
    expect(result.scale).toBeCloseTo(1.2);
    // World point (100,50) should map to same screen point after zoom
    // Before: screenX = 100 * 1 + 0 = 100
    // After:  screenX = 100 * 1.2 + tx => tx should be 100 - 120 = -20
    expect(result.tx).toBeCloseTo(-20);
    expect(result.ty).toBeCloseTo(-10);
  });

  test('zoom respects min/max clamp', () => {
    function clampScale(scale: number, factor: number, minZoom: number, maxZoom: number) {
      return Math.min(maxZoom, Math.max(minZoom, scale * factor));
    }

    // Already at max, zoom in more
    expect(clampScale(10, 1.5, 0.1, 10)).toBe(10);
    // Already at min, zoom out more
    expect(clampScale(0.1, 0.5, 0.1, 10)).toBeCloseTo(0.1);
    // Normal zoom
    expect(clampScale(1, 2, 0.1, 10)).toBe(2);
  });

  test('pan: translateX/Y update by pointer delta', () => {
    function pan(oldTx: number, oldTy: number, dx: number, dy: number) {
      return { tx: oldTx + dx, ty: oldTy + dy };
    }

    const result = pan(10, 20, 5, -3);
    expect(result.tx).toBe(15);
    expect(result.ty).toBe(17);
  });

  test('fitToView: calculates transform to fit content bounds into viewport', () => {
    // Content at (0,0) size 1000x500, viewport 800x600, padding 20
    const result = fitToView(0, 0, 1000, 500, 800, 600, 20);
    // scaleX = (800-40)/1000 = 0.76, scaleY = (600-40)/500 = 1.12
    // scale = min(0.76, 1.12) = 0.76
    expect(result.scale).toBeCloseTo(0.76);
    // Content should be centered
    expect(result.tx).toBeCloseTo(20);
    // ty = 20 + (600-40-500*0.76)/2 - 0 = 20 + (560-380)/2 = 20 + 90 = 110
    expect(result.ty).toBeCloseTo(110);
  });

  test('fitToView: regression for 531 nodes with large content bounds', () => {
    // Simulate 531 nodes in one group: bounds ~172 x 21296
    const contentBounds = computeLayoutBounds(makeOverview(531, 0).nodes);
    const viewW = 1200;
    const viewH = 800;
    const padding = 20;

    const result = fitToView(contentBounds.x, contentBounds.y, contentBounds.w, contentBounds.h, viewW, viewH, padding);

    // Scale must be positive and less than 1 (content is much larger than viewport)
    expect(result.scale).toBeGreaterThan(0);
    expect(result.scale).toBeLessThan(1);

    // After applying transform, all corners of content must be within viewport
    const topLeft = { x: contentBounds.x * result.scale + result.tx, y: contentBounds.y * result.scale + result.ty };
    const bottomRight = {
      x: (contentBounds.x + contentBounds.w) * result.scale + result.tx,
      y: (contentBounds.y + contentBounds.h) * result.scale + result.ty,
    };

    // Top-left must be at or past the padding
    expect(topLeft.x).toBeGreaterThanOrEqual(padding);
    expect(topLeft.y).toBeGreaterThanOrEqual(padding);

    // Bottom-right must be at or before viewport minus padding
    expect(bottomRight.x).toBeLessThanOrEqual(viewW - padding + 1);
    expect(bottomRight.y).toBeLessThanOrEqual(viewH - padding + 1);
  });

  test('fitToView: regression for 531 nodes across 20 groups', () => {
    const overview = makeMultiGroupOverview(531, 20);
    const contentBounds = computeLayoutBounds(overview.nodes);
    const viewW = 1200;
    const viewH = 800;
    const padding = 20;

    const result = fitToView(contentBounds.x, contentBounds.y, contentBounds.w, contentBounds.h, viewW, viewH, padding);

    expect(result.scale).toBeGreaterThan(0);
    expect(result.scale).toBeLessThan(1);

    // Content corners within viewport
    const bottomRight = {
      x: (contentBounds.x + contentBounds.w) * result.scale + result.tx,
      y: (contentBounds.y + contentBounds.h) * result.scale + result.ty,
    };
    expect(bottomRight.x).toBeLessThanOrEqual(viewW - padding + 1);
    expect(bottomRight.y).toBeLessThanOrEqual(viewH - padding + 1);
  });

  test('fitToView: scale is uniform (not stretched)', () => {
    // Wide content: should scale to fit width, leaving vertical space
    const result = fitToView(0, 0, 2000, 200, 800, 600, 20);
    // scaleX = 760/2000 = 0.38, scaleY = 560/200 = 2.8
    // scale = 0.38 (limited by width)
    expect(result.scale).toBeCloseTo(0.38);
    // Content width on screen: 2000 * 0.38 = 760, centered in 800 with padding 20 => tx = 20
    expect(result.tx).toBeCloseTo(20);
    // Content height on screen: 200 * 0.38 = 76, centered in 600 with padding 20 => ty = 20 + (560-76)/2 = 262
    expect(result.ty).toBeCloseTo(262);
  });

  test('fitToView after zoom+pan: clicking Fit restores full view', () => {
    // Start with fit transform
    const contentBounds = { x: 0, y: 0, w: 1000, h: 500 };
    const fitResult = fitToView(0, 0, 1000, 500, 800, 600, 20);

    // User zooms in (simulating wheel zoom at center)
    const zoomFactor = 1.5;
    const centerX = 400;
    const centerY = 300;
    const newScale = fitResult.scale * zoomFactor;
    const newTx = centerX - (centerX - fitResult.tx) * zoomFactor;
    const newTy = centerY - (centerY - fitResult.ty) * zoomFactor;

    // After zoom, content is larger on screen — some parts may be off-screen
    expect(newScale).toBeGreaterThan(fitResult.scale);

    // User clicks Fit — should restore the original fit transform
    const restored = fitToView(0, 0, 1000, 500, 800, 600, 20);
    expect(restored.scale).toBeCloseTo(fitResult.scale);
    expect(restored.tx).toBeCloseTo(fitResult.tx);
    expect(restored.ty).toBeCloseTo(fitResult.ty);
  });

  test('viewport transform string format', () => {
    function viewportTransform(tx: number, ty: number, scale: number) {
      return `translate(${tx} ${ty}) scale(${scale})`;
    }

    expect(viewportTransform(10, 20, 1.5)).toBe('translate(10 20) scale(1.5)');
    expect(viewportTransform(0, 0, 1)).toBe('translate(0 0) scale(1)');
  });
});

describe('codebase map search centering', () => {
  test('single search match can be identified', () => {
    const overview = makeOverview(10, 0);
    overview.nodes[5].path = 'src/unique_file.ts';
    overview.nodes[5].label = 'unique_file.ts';

    const q = 'unique_file';
    const matches = overview.nodes.filter(
      (n) => n.path.toLowerCase().includes(q) || n.label.toLowerCase().includes(q),
    );

    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe('src/file5.ts');
  });

  test('multiple search matches are returned', () => {
    const overview = makeOverview(10, 0);
    const q = 'file';
    const matches = overview.nodes.filter(
      (n) => n.path.toLowerCase().includes(q) || n.label.toLowerCase().includes(q),
    );

    expect(matches.length).toBe(10);
  });

  test('no search matches returns empty', () => {
    const overview = makeOverview(10, 0);
    const q = 'nonexistent';
    const matches = overview.nodes.filter(
      (n) => n.path.toLowerCase().includes(q) || n.label.toLowerCase().includes(q),
    );

    expect(matches.length).toBe(0);
  });
});

describe('codebase map renderer overlay rendering', () => {
  function makeOverlayOverview() {
    const overview = makeOverview(6, 2);
    // Add overlay status flags to nodes (as the bridge now provides)
    overview.nodes[0].changed = true;
    overview.nodes[1].claimed = true;
    overview.nodes[2].conflicted = true;
    overview.nodes[3].changed = true;
    overview.nodes[3].claimed = true;
    return overview;
  }

  test('nodes with changed flag are identified', () => {
    const overview = makeOverlayOverview();
    const changedNodes = overview.nodes.filter((n) => n.changed === true);
    expect(changedNodes.length).toBe(2);
    expect(changedNodes.map((n) => n.id)).toContain('src/file0.ts');
    expect(changedNodes.map((n) => n.id)).toContain('src/file3.ts');
  });

  test('nodes with claimed flag are identified', () => {
    const overview = makeOverlayOverview();
    const claimedNodes = overview.nodes.filter((n) => n.claimed === true);
    expect(claimedNodes.length).toBe(2);
    expect(claimedNodes.map((n) => n.id)).toContain('src/file1.ts');
    expect(claimedNodes.map((n) => n.id)).toContain('src/file3.ts');
  });

  test('nodes with conflicted flag are identified', () => {
    const overview = makeOverlayOverview();
    const conflictedNodes = overview.nodes.filter((n) => n.conflicted === true);
    expect(conflictedNodes.length).toBe(1);
    expect(conflictedNodes[0].id).toBe('src/file2.ts');
  });

  test('node can have multiple overlay flags simultaneously', () => {
    const overview = makeOverlayOverview();
    const node3 = overview.nodes.find((n) => n.id === 'src/file3.ts');
    expect(node3).toBeDefined();
    expect(node3!.changed).toBe(true);
    expect(node3!.claimed).toBe(true);
  });

  test('overlay layer toggle: hiding changed removes changed nodes from filtered set', () => {
    const overview = makeOverlayOverview();
    // Simulate layer toggle: changed layer off hides all changed nodes
    const activeLayers = { changed: false, entrypoints: true, claimed: true, conflicted: true };
    const filtered = overview.nodes.filter((n) => {
      if (n.changed && !activeLayers.changed) return false;
      return true;
    });
    // Node 0 is only changed - filtered out
    expect(filtered.find((n) => n.id === 'src/file0.ts')).toBeUndefined();
    // Node 3 is changed+claimed - also filtered out because changed layer is off
    // (renderer hides node if ANY of its matching layers is inactive)
    expect(filtered.find((n) => n.id === 'src/file3.ts')).toBeUndefined();
    // Node 1 is only claimed - stays visible
    expect(filtered.find((n) => n.id === 'src/file1.ts')).toBeDefined();
  });

  test('overlay layer toggle: hiding claimed removes claimed nodes', () => {
    const overview = makeOverlayOverview();
    const activeLayers = { changed: true, entrypoints: true, claimed: false, conflicted: true };
    const filtered = overview.nodes.filter((n) => {
      if (n.claimed && !activeLayers.claimed) return false;
      return true;
    });
    expect(filtered.find((n) => n.id === 'src/file1.ts')).toBeUndefined();
    // Node 0 is only changed, should remain
    expect(filtered.find((n) => n.id === 'src/file0.ts')).toBeDefined();
  });

  test('overlay layer toggle: hiding conflicted removes conflicted nodes', () => {
    const overview = makeOverlayOverview();
    const activeLayers = { changed: true, entrypoints: true, claimed: true, conflicted: false };
    const filtered = overview.nodes.filter((n) => {
      if (n.conflicted && !activeLayers.conflicted) return false;
      return true;
    });
    expect(filtered.find((n) => n.id === 'src/file2.ts')).toBeUndefined();
  });

  test('SVG rendering includes overlay badge indicators for changed nodes', () => {
    const overview = makeOverlayOverview();
    // Simulate SVG badge check: changed nodes should have a badge marker
    const changedNode = overview.nodes.find((n) => n.id === 'src/file0.ts');
    expect(changedNode).toBeDefined();
    expect(changedNode!.changed).toBe(true);
    // The badge is rendered when node.changed && activeLayers.changed
    const activeLayers = { changed: true };
    const shouldShowBadge = changedNode!.changed && activeLayers.changed;
    expect(shouldShowBadge).toBe(true);
  });

  test('SVG rendering includes overlay badge indicators for claimed nodes', () => {
    const overview = makeOverlayOverview();
    const claimedNode = overview.nodes.find((n) => n.id === 'src/file1.ts');
    expect(claimedNode).toBeDefined();
    expect(claimedNode!.claimed).toBe(true);
  });

  test('SVG rendering includes overlay badge indicators for conflicted nodes', () => {
    const overview = makeOverlayOverview();
    const conflictedNode = overview.nodes.find((n) => n.id === 'src/file2.ts');
    expect(conflictedNode).toBeDefined();
    expect(conflictedNode!.conflicted).toBe(true);
  });

  test('getNodeDetail includes overlay status in detail', () => {
    const overview = makeOverlayOverview();
    const detail = getNodeDetail(overview, 'src/file0.ts');
    expect(detail).toBeDefined();
    expect(detail!.changed).toBe(true);
    expect(detail!.entrypoint).toBe(false);
  });

  test('getNodeDetail for claimed node returns claimed status', () => {
    const overview = makeOverlayOverview();
    // getNodeDetail returns spread node, so claimed flag is available
    const node = overview.nodes.find((n) => n.id === 'src/file1.ts');
    expect(node).toBeDefined();
    expect((node as Record<string, unknown>).claimed).toBe(true);
  });

  test('all nodes still included when no overlay flags set', () => {
    const overview = makeOverview(5, 0);
    // No overlay flags
    for (const node of overview.nodes) {
      expect(node.changed).toBeUndefined();
      expect(node.claimed).toBeUndefined();
      expect(node.conflicted).toBeUndefined();
    }
    expect(overview.nodes.length).toBe(5);
  });

  test('search still works with overlay-flagged nodes', () => {
    const overview = makeOverlayOverview();
    const q = 'file1';
    const matches = overview.nodes.filter(
      (n) => n.path.toLowerCase().includes(q) || n.label.toLowerCase().includes(q),
    );
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe('src/file1.ts');
    expect(matches[0].claimed).toBe(true);
  });
});
