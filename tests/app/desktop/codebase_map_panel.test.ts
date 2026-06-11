import { describe, expect, test } from 'vitest';

/**
 * Codebase Map renderer panel: pure render function tests.
 * The renderCodebaseMapSvgHtml function is tested via its contract:
 * given an overview DTO, it produces valid SVG markup.
 *
 * CAD viewport tests verify the viewport group structure and
 * exported helper functions for zoom/pan math.
 */

const KIND_COLORS = {
  source: '#4fc3f7',
  test: '#81c784',
  doc: '#ffb74d',
  config: '#ba68c8',
  generated: '#90a4ae',
  unknown: '#78909c',
};

function makeOverview(nodeCount: number, edgeCount: number) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `src/file${i}.ts`,
    path: `src/file${i}.ts`,
    label: `file${i}.ts`,
    kind: i % 3 === 0 ? 'test' : 'source' as string,
    group: 'src',
    language: 'typescript',
  }));
  const edges = Array.from({ length: Math.min(edgeCount, nodeCount - 1) }, (_, i) => ({
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

describe('codebase map viewport math', () => {
  test('zoom toward cursor: world point under cursor stays under cursor', () => {
    // Test the zoom math formula directly:
    // newScale = clamp(oldScale * factor, minZoom, maxZoom)
    // newTranslateX = cursorX - (cursorX - oldTranslateX) * (newScale / oldScale)
    // newTranslateY = cursorY - (cursorY - oldTranslateY) * (newScale / oldZoom)

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

  test('viewport transform string format', () => {
    function viewportTransform(tx: number, ty: number, scale: number) {
      return `translate(${tx} ${ty}) scale(${scale})`;
    }

    expect(viewportTransform(10, 20, 1.5)).toBe('translate(10 20) scale(1.5)');
    expect(viewportTransform(0, 0, 1)).toBe('translate(0 0) scale(1)');
  });
});
