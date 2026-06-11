/**
 * Codebase Graph Scene DTO: renderer-neutral scene data model that can feed
 * both the current 2D Codebase Map and a future 2.5D/3D renderer.
 *
 * This module builds a CodebaseGraphScene from an existing CodebaseMapOverview.
 * It never runs the scanner, never reads source files, and never mutates state.
 */

import type {
  CodebaseMapOverview,
  CodebaseMapNodeKind,
  CodebaseMapEdgeType,
} from './overview.js';

// ============ Scene DTO types ============

export interface SceneNodeStatus {
  changed?: boolean;
  entrypoint?: boolean;
  generated?: boolean;
  selected?: boolean;
  claimed?: boolean;
  conflicted?: boolean;
}

export interface SceneNodeMetrics {
  imports_out?: number;
  imports_in?: number;
  related_tests?: number;
}

export interface SceneNode {
  id: string;
  path: string;
  label: string;
  kind: CodebaseMapNodeKind;
  group_id: string;
  language?: string;
  lines?: number;
  status: SceneNodeStatus;
  metrics?: SceneNodeMetrics;
}

export interface SceneEdge {
  id: string;
  from: string;
  to: string;
  type: CodebaseMapEdgeType;
  direction: 'directed' | 'undirected';
  evidence?: string;
}

export interface SceneGroupCounts {
  files: number;
  source: number;
  tests: number;
  docs: number;
  config: number;
  generated: number;
  unknown: number;
}

export interface SceneGroup {
  id: string;
  label: string;
  kind: 'folder';
  path?: string;
  counts: SceneGroupCounts;
}

export interface SceneLegendKind {
  id: string;
  label: string;
  color: string;
}

export interface SceneLegendEdge {
  id: string;
  label: string;
}

export interface SceneLegendBadge {
  id: string;
  label: string;
}

export interface SceneLegend {
  node_kinds: SceneLegendKind[];
  edge_types: SceneLegendEdge[];
  status_badges: SceneLegendBadge[];
}

export interface SceneCameraBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneCameraHints {
  default_view: 'top';
  bounds: SceneCameraBounds;
}

export interface SceneOverlays {
  current_run?: Record<string, unknown>;
  git?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  conflicts?: Record<string, unknown>;
}

export interface CodebaseGraphScene {
  version: 1;
  repo_root: string;
  generated_at: string;
  source: {
    kind: 'latest_scan' | 'current_run' | 'workspace' | 'fallback';
    run_id?: string;
  };
  summary: {
    total_nodes: number;
    total_edges: number;
    groups: number;
  };
  legend: SceneLegend;
  groups: SceneGroup[];
  nodes: SceneNode[];
  edges: SceneEdge[];
  overlays: SceneOverlays;
  camera_hints: SceneCameraHints;
  warnings: string[];
}

// ============ Color constants ============

const KIND_COLORS: Record<CodebaseMapNodeKind, string> = {
  source: '#4fc3f7',
  test: '#81c784',
  doc: '#ffb74d',
  config: '#ba68c8',
  generated: '#90a4ae',
  unknown: '#78909c',
};

const KIND_LABELS: Record<CodebaseMapNodeKind, string> = {
  source: 'Source',
  test: 'Test',
  doc: 'Doc',
  config: 'Config',
  generated: 'Generated',
  unknown: 'Unknown',
};

const EDGE_LABELS: Record<CodebaseMapEdgeType, string> = {
  import: 'Import',
  test: 'Test relation',
  entrypoint: 'Entrypoint',
  folder: 'Folder',
  related: 'Related',
};

// ============ Scene builder ============

/**
 * Build a CodebaseGraphScene from an existing CodebaseMapOverview.
 * Renderer-neutral, deterministic, read-only.
 */
export function buildCodebaseGraphScene(
  overview: CodebaseMapOverview,
): CodebaseGraphScene {
  const { nodes: overviewNodes, edges: overviewEdges, repo_root, source, warnings } = overview;

  // Pre-compute edge maps for metrics
  const importsOutMap = new Map<string, number>();
  const importsInMap = new Map<string, number>();
  const relatedTestsMap = new Map<string, number>();

  for (const edge of overviewEdges) {
    if (edge.type === 'import') {
      importsOutMap.set(edge.from, (importsOutMap.get(edge.from) ?? 0) + 1);
      importsInMap.set(edge.to, (importsInMap.get(edge.to) ?? 0) + 1);
    }
    if (edge.type === 'test') {
      // Test edge: from=test, to=target
      relatedTestsMap.set(edge.to, (relatedTestsMap.get(edge.to) ?? 0) + 1);
    }
  }

  // Build groups
  const groupMap = new Map<string, SceneGroup>();
  for (const node of overviewNodes) {
    let group = groupMap.get(node.group);
    if (!group) {
      group = {
        id: node.group,
        label: node.group,
        kind: 'folder',
        path: node.group === '(root)' ? undefined : node.group,
        counts: { files: 0, source: 0, tests: 0, docs: 0, config: 0, generated: 0, unknown: 0 },
      };
      groupMap.set(node.group, group);
    }
    group.counts.files++;
    // Map node kind to group count field
    switch (node.kind) {
      case 'source': group.counts.source++; break;
      case 'test': group.counts.tests++; break;
      case 'doc': group.counts.docs++; break;
      case 'config': group.counts.config++; break;
      case 'generated': group.counts.generated++; break;
      default: group.counts.unknown++; break;
    }
  }
  const groups = Array.from(groupMap.values());

  // Build scene nodes
  const sceneNodes: SceneNode[] = overviewNodes.map((node) => {
    const imports_out = importsOutMap.get(node.id) ?? 0;
    const imports_in = importsInMap.get(node.id) ?? 0;
    const related_tests = relatedTestsMap.get(node.id) ?? 0;

    const status: SceneNodeStatus = {};
    if (node.changed) status.changed = true;
    if (node.entrypoint) status.entrypoint = true;

    const metrics: SceneNodeMetrics = {};
    if (imports_out > 0) metrics.imports_out = imports_out;
    if (imports_in > 0) metrics.imports_in = imports_in;
    if (related_tests > 0) metrics.related_tests = related_tests;

    return {
      id: node.id,
      path: node.path,
      label: node.label,
      kind: node.kind,
      group_id: node.group,
      language: node.language,
      lines: node.lines,
      status,
      metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
    };
  });

  // Build scene edges
  const sceneEdges: SceneEdge[] = overviewEdges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    type: edge.type,
    direction: 'directed' as const,
    evidence: edge.evidence,
  }));

  // Compute camera bounds (simple: based on group count and max group size)
  const maxGroupSize = groups.length > 0
    ? Math.max(...groups.map((g) => g.counts.files))
    : 0;
  const NODE_W = 140;
  const NODE_H = 32;
  const GROUP_GAP = 24;
  const NODE_GAP = 8;
  const PADDING = 16;
  const GROUP_HEADER_H = 24;

  const boundsW = groups.length * (NODE_W + GROUP_GAP) + PADDING * 2;
  const boundsH = PADDING + GROUP_HEADER_H + maxGroupSize * (NODE_H + NODE_GAP) + PADDING;

  // Build legend
  const usedKinds = new Set(overviewNodes.map((n) => n.kind));
  const usedEdgeTypes = new Set(overviewEdges.map((e) => e.type));

  const legend: SceneLegend = {
    node_kinds: Array.from(usedKinds).map((kind) => ({
      id: kind,
      label: KIND_LABELS[kind],
      color: KIND_COLORS[kind],
    })),
    edge_types: Array.from(usedEdgeTypes).map((type) => ({
      id: type,
      label: EDGE_LABELS[type],
    })),
    status_badges: [
      { id: 'changed', label: 'Changed' },
      { id: 'entrypoint', label: 'Entrypoint' },
    ],
  };

  return {
    version: 1,
    repo_root,
    generated_at: overview.generated_at,
    source: { kind: source.kind, run_id: source.run_id },
    summary: {
      total_nodes: overviewNodes.length,
      total_edges: overviewEdges.length,
      groups: groups.length,
    },
    legend,
    groups,
    nodes: sceneNodes,
    edges: sceneEdges,
    overlays: {},
    camera_hints: {
      default_view: 'top',
      bounds: { x: 0, y: 0, width: boundsW, height: boundsH },
    },
    warnings: [...warnings],
  };
}
