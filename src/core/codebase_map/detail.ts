/**
 * Codebase Map detail helpers: pure functions that derive node detail,
 * neighborhood connections, and filtered/searched node sets from an
 * existing CodebaseMapOverview DTO. These helpers are renderer-neutral
 * and testable in isolation.
 */

import type {
  CodebaseMapOverview,
  CodebaseMapNode,
  CodebaseMapEdgeType,
} from './overview.js';

export interface NodeEdgeEvidence {
  edge_id: string;
  type: CodebaseMapEdgeType;
  evidence?: string;
  direction: 'outgoing' | 'incoming';
  peer: string;
}

export interface NodeDetail {
  id: string;
  path: string;
  label: string;
  kind: CodebaseMapNode['kind'];
  group: string;
  language?: string;
  lines?: number;
  changed: boolean;
  entrypoint: boolean;
  imports_out: string[];
  imports_in: string[];
  related_tests: string[];
  edge_evidence: NodeEdgeEvidence[];
}

export interface Neighborhood {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

/**
 * Get detailed information about a single node, including its connections
 * and edge evidence. Returns null if the node is not found.
 */
export function getNodeDetail(
  overview: CodebaseMapOverview,
  nodeId: string,
): NodeDetail | null {
  const node = overview.nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const imports_out: string[] = [];
  const imports_in: string[] = [];
  const related_tests: string[] = [];
  const edge_evidence: NodeEdgeEvidence[] = [];

  for (const edge of overview.edges) {
    if (edge.from === nodeId) {
      if (edge.type === 'import') {
        imports_out.push(edge.to);
      }
      if (edge.type === 'test') {
        related_tests.push(edge.to);
      }
      edge_evidence.push({
        edge_id: edge.id,
        type: edge.type,
        evidence: edge.evidence,
        direction: 'outgoing',
        peer: edge.to,
      });
    } else if (edge.to === nodeId) {
      if (edge.type === 'import') {
        imports_in.push(edge.from);
      }
      if (edge.type === 'test') {
        related_tests.push(edge.from);
      }
      edge_evidence.push({
        edge_id: edge.id,
        type: edge.type,
        evidence: edge.evidence,
        direction: 'incoming',
        peer: edge.from,
      });
    }
  }

  return {
    id: node.id,
    path: node.path,
    label: node.label,
    kind: node.kind,
    group: node.group,
    language: node.language,
    lines: node.lines,
    changed: node.changed === true,
    entrypoint: node.entrypoint === true,
    imports_out,
    imports_in,
    related_tests,
    edge_evidence,
  };
}

/**
 * Get the connected neighborhood of a node: all directly connected nodes
 * and edges (imports in/out, tests, folder relations).
 */
export function getConnectedNeighborhood(
  overview: CodebaseMapOverview,
  nodeId: string,
): Neighborhood {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  const node = overview.nodes.find((n) => n.id === nodeId);
  if (!node) return { nodeIds, edgeIds };

  nodeIds.add(nodeId);

  for (const edge of overview.edges) {
    if (edge.from === nodeId) {
      nodeIds.add(edge.to);
      edgeIds.add(edge.id);
    } else if (edge.to === nodeId) {
      nodeIds.add(edge.from);
      edgeIds.add(edge.id);
    }
  }

  return { nodeIds, edgeIds };
}

/**
 * Filter nodes by kind/type and optional search query.
 * Special filters: 'entrypoints' and 'changed'.
 */
export function filterOverviewNodes(
  nodes: CodebaseMapNode[],
  filter: string,
  query: string,
): CodebaseMapNode[] {
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
    filtered = filtered.filter(
      (n) => n.path.toLowerCase().includes(q) || n.label.toLowerCase().includes(q),
    );
  }

  return filtered;
}

/**
 * Search nodes by path or label. Returns matching nodes.
 */
export function searchNodes(
  nodes: CodebaseMapNode[],
  query: string,
): CodebaseMapNode[] {
  if (!query) return [];
  const q = query.toLowerCase();
  return nodes.filter(
    (n) => n.path.toLowerCase().includes(q) || n.label.toLowerCase().includes(q),
  );
}

/**
 * Get the center position of a node in the layout, given its top-left position
 * and node dimensions. Returns null if the node has no recorded position.
 */
export function getNodeCenter(
  positions: Map<string, { x: number; y: number }>,
  nodeId: string,
  nodeW: number,
  nodeH: number,
): { x: number; y: number } | null {
  const pos = positions.get(nodeId);
  if (!pos) return null;
  return {
    x: pos.x + nodeW / 2,
    y: pos.y + nodeH / 2,
  };
}
