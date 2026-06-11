import fs from 'fs';
import path from 'path';

import {
  readScanArtifactJson,
  listAllowedScanArtifacts,
} from '../runs/scan_artifacts.js';
import { resolveRunDir } from '../runs/run_resolver.js';

/**
 * Phase CodebaseMap-1: read-only 2D codebase map overview builder.
 *
 * Builds a bounded CodebaseMapOverview DTO from existing deterministic scan
 * artifacts. This module never runs the scanner, never reads source files,
 * and never mutates any state. It projects scan artifacts into a graph-shaped
 * DTO suitable for 2D visualization in the desktop renderer.
 */

export const CODEBASE_MAP_KINDS = [
  'source',
  'test',
  'doc',
  'config',
  'generated',
  'unknown',
] as const;

export type CodebaseMapNodeKind = (typeof CODEBASE_MAP_KINDS)[number];

export const CODEBASE_MAP_EDGE_TYPES = [
  'import',
  'test',
  'entrypoint',
  'folder',
  'related',
] as const;

export type CodebaseMapEdgeType = (typeof CODEBASE_MAP_EDGE_TYPES)[number];

export interface CodebaseMapNode {
  id: string;
  path: string;
  label: string;
  kind: CodebaseMapNodeKind;
  group: string;
  language?: string;
  lines?: number;
  changed?: boolean;
  entrypoint?: boolean;
}

export interface CodebaseMapEdge {
  id: string;
  from: string;
  to: string;
  type: CodebaseMapEdgeType;
  evidence?: string;
}

export interface CodebaseMapOverview {
  ok: boolean;
  repo_root: string;
  generated_at: string;
  source: {
    kind: 'current_run' | 'latest_scan' | 'workspace' | 'fallback';
    run_id?: string;
  };
  summary: {
    total_nodes: number;
    displayed_nodes: number;
    total_edges: number;
    displayed_edges: number;
    truncated: boolean;
  };
  nodes: CodebaseMapNode[];
  edges: CodebaseMapEdge[];
  warnings: string[];
}

export interface BuildCodebaseMapOptions {
  /** Maximum number of nodes to include. Default 200. */
  maxNodes?: number;
  /** Maximum number of edges to include. Default 300. */
  maxEdges?: number;
}

const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_EDGES = 300;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function classifyFileKind(item: Record<string, unknown>): CodebaseMapNodeKind {
  if (item.is_test === true || item.kind === 'test') return 'test';
  if (item.is_doc === true || item.kind === 'doc') return 'doc';
  if (item.is_config === true || item.kind === 'config') return 'config';
  if (item.kind === 'generated' || item.kind === 'asset') return 'generated';
  if (item.kind === 'source' || item.kind === 'script' || item.kind === 'manifest' || item.kind === 'schema') return 'source';
  return 'unknown';
}

function deriveGroup(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  if (parts.length <= 1) return '(root)';
  return parts[0];
}

function deriveLabel(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

function deriveLanguage(ext: unknown): string | undefined {
  if (typeof ext !== 'string') return undefined;
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.md': 'markdown',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.css': 'css',
    '.html': 'html',
    '.sh': 'shell',
    '.ps1': 'powershell',
  };
  return map[ext.toLowerCase()] ?? undefined;
}

function normalizeImportTarget(target: unknown): string | null {
  if (typeof target !== 'string') return null;
  // Skip external imports (npm packages, etc.)
  if (!target.startsWith('.') && !target.startsWith('/') && !target.startsWith('src/')) return null;
  return target;
}

function resolveRelativeImport(fromPath: string, importTarget: string): string | null {
  if (!importTarget.startsWith('.')) return importTarget;
  const fromDir = fromPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const parts = (fromDir + '/' + importTarget).replace(/\\/g, '/').split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

/**
 * Build a CodebaseMapOverview from scan artifacts in the given run directory.
 * Returns a bounded, read-only graph DTO.
 */
export function buildCodebaseMapOverview(
  repoRoot: string,
  runDir: string,
  options: BuildCodebaseMapOptions = {},
): CodebaseMapOverview {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES;

  const warnings: string[] = [];

  // Check if scan artifacts exist
  const inventory = listAllowedScanArtifacts(runDir);
  const hasScanArtifacts = inventory.some((a) => a.available);
  if (!hasScanArtifacts) {
    return {
      ok: true,
      repo_root: repoRoot,
      generated_at: new Date().toISOString(),
      source: { kind: 'fallback' },
      summary: { total_nodes: 0, displayed_nodes: 0, total_edges: 0, displayed_edges: 0, truncated: false },
      nodes: [],
      edges: [],
      warnings: ['No scan artifacts available. Run a scan first to populate the codebase map.'],
    };
  }

  // Read scan artifacts
  const fileInventoryResult = readScanArtifactJson(runDir, 'file_inventory');
  const importsResult = readScanArtifactJson(runDir, 'imports');
  const entrypointsResult = readScanArtifactJson(runDir, 'entrypoints');
  const testsResult = readScanArtifactJson(runDir, 'tests');
  const gitStatusResult = readScanArtifactJson(runDir, 'git_status');

  // Build nodes from file inventory
  const allNodes: CodebaseMapNode[] = [];
  const nodeIdSet = new Set<string>();

  const fileInventory = asArray(fileInventoryResult.value);
  for (const rawEntry of fileInventory) {
    const entry = asRecord(rawEntry);
    const filePath = typeof entry.path === 'string' ? entry.path : '';
    if (!filePath) continue;

    const nodeId = filePath;
    if (nodeIdSet.has(nodeId)) continue;
    nodeIdSet.add(nodeId);

    const kind = classifyFileKind(entry);
    const group = deriveGroup(filePath);
    const label = deriveLabel(filePath);
    const language = deriveLanguage(entry.extension);
    const lines = typeof entry.lines === 'number' ? entry.lines : undefined;

    allNodes.push({
      id: nodeId,
      path: filePath,
      label,
      kind,
      group,
      ...(language !== undefined ? { language } : {}),
      ...(lines !== undefined ? { lines } : {}),
    });
  }

  // Mark entrypoints
  const entrypoints = asArray(asRecord(entrypointsResult.value).entrypoints);
  const entrypointPaths = new Set<string>();
  for (const raw of entrypoints) {
    const rec = asRecord(raw);
    const epPath = typeof rec.path === 'string' ? rec.path : undefined;
    const epName = typeof rec.name === 'string' ? rec.name : undefined;
    // Try to find matching node
    if (epPath) {
      entrypointPaths.add(epPath);
    } else if (epName) {
      // Try to match by name in path
      for (const node of allNodes) {
        if (node.path.includes(epName) || node.label === epName) {
          entrypointPaths.add(node.path);
        }
      }
    }
  }
  for (const node of allNodes) {
    if (entrypointPaths.has(node.path)) {
      node.entrypoint = true;
    }
  }

  // Mark changed files
  const gitStatus = asRecord(gitStatusResult.value);
  const changedPaths = new Set<string>();
  for (const p of [...asArray(gitStatus.modified), ...asArray(gitStatus.untracked), ...asArray(gitStatus.staged)]) {
    if (typeof p === 'string') changedPaths.add(p);
  }
  for (const node of allNodes) {
    if (changedPaths.has(node.path)) {
      node.changed = true;
    }
  }

  // Build edges
  const allEdges: CodebaseMapEdge[] = [];
  const edgeIdSet = new Set<string>();

  // Import edges
  const imports = asArray(asRecord(importsResult.value).imports);
  for (const raw of imports) {
    const rec = asRecord(raw);
    const fromPath = typeof rec.from_path === 'string' ? rec.from_path : '';
    const importTarget = normalizeImportTarget(rec.import_target);
    if (!fromPath || !importTarget) continue;

    // Resolve relative imports against the importing file's directory
    const resolvedTarget = resolveRelativeImport(fromPath, importTarget);
    if (!resolvedTarget) continue;

    // Try to resolve import target to a known node
    const possiblePaths = [
      resolvedTarget,
      resolvedTarget + '.ts',
      resolvedTarget + '.tsx',
      resolvedTarget + '.js',
      resolvedTarget + '.jsx',
      resolvedTarget + '/index.ts',
      resolvedTarget + '/index.js',
    ];
    let toPath: string | null = null;
    for (const candidate of possiblePaths) {
      if (nodeIdSet.has(candidate)) {
        toPath = candidate;
        break;
      }
    }
    if (!toPath) continue;

    const edgeId = `${fromPath}->${toPath}:import`;
    if (edgeIdSet.has(edgeId)) continue;
    edgeIdSet.add(edgeId);

    allEdges.push({
      id: edgeId,
      from: fromPath,
      to: toPath,
      type: 'import',
      evidence: typeof rec.kind === 'string' ? rec.kind : undefined,
    });
  }

  // Test edges
  const tests = asArray(asRecord(testsResult.value).tests);
  for (const raw of tests) {
    const rec = asRecord(raw);
    const testPath = typeof rec.path === 'string' ? rec.path : '';
    const targets = asArray(rec.likely_targets);
    for (const target of targets) {
      if (typeof target !== 'string' || !testPath) continue;
      if (!nodeIdSet.has(target)) continue;

      const edgeId = `${testPath}->${target}:test`;
      if (edgeIdSet.has(edgeId)) continue;
      edgeIdSet.add(edgeId);

      allEdges.push({
        id: edgeId,
        from: testPath,
        to: target,
        type: 'test',
        evidence: 'test-target',
      });
    }
  }

  // Folder edges (connect files in the same top-level group)
  const groupMembers = new Map<string, string[]>();
  for (const node of allNodes) {
    const existing = groupMembers.get(node.group) ?? [];
    existing.push(node.id);
    groupMembers.set(node.group, existing);
  }
  for (const [group, members] of groupMembers) {
    if (group === '(root)' || members.length <= 1) continue;
    // Connect first member to others (star pattern, limited)
    const hub = members[0];
    const maxFolderEdges = 10;
    let folderEdgeCount = 0;
    for (let i = 1; i < members.length && folderEdgeCount < maxFolderEdges; i++) {
      const edgeId = `${hub}->${members[i]}:folder`;
      if (!edgeIdSet.has(edgeId)) {
        edgeIdSet.add(edgeId);
        allEdges.push({
          id: edgeId,
          from: hub,
          to: members[i],
          type: 'folder',
          evidence: group,
        });
        folderEdgeCount++;
      }
    }
  }

  // Determine source kind
  let sourceKind: CodebaseMapOverview['source']['kind'] = 'fallback';
  let runId: string | undefined;
  if (hasScanArtifacts) {
    // Try to extract run_id from run dir
    const manifestPath = path.join(runDir, 'run_manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.run_id === 'string') {
        runId = manifest.run_id;
        sourceKind = 'latest_scan';
      }
    } catch {
      sourceKind = 'workspace';
    }
  }

  // Apply caps
  const totalNodes = allNodes.length;
  const totalEdges = allEdges.length;
  const displayedNodes = Math.min(totalNodes, maxNodes);
  const displayedEdges = Math.min(totalEdges, maxEdges);
  const truncated = totalNodes > maxNodes || totalEdges > maxEdges;

  if (truncated) {
    warnings.push(
      `Map truncated: showing ${displayedNodes}/${totalNodes} nodes and ${displayedEdges}/${totalEdges} edges.`,
    );
  }

  return {
    ok: true,
    repo_root: repoRoot,
    generated_at: new Date().toISOString(),
    source: { kind: sourceKind, ...(runId !== undefined ? { run_id: runId } : {}) },
    summary: {
      total_nodes: totalNodes,
      displayed_nodes: displayedNodes,
      total_edges: totalEdges,
      displayed_edges: displayedEdges,
      truncated,
    },
    nodes: allNodes.slice(0, maxNodes),
    edges: allEdges.slice(0, maxEdges),
    warnings,
  };
}

/**
 * Resolve a run directory from a selector (latest/current/explicit) and build
 * the codebase map overview. This is the main entry point for bridge/CLI use.
 */
export function getCodebaseMapOverview(
  repoRoot: string,
  runSelector: string = 'latest',
  options: BuildCodebaseMapOptions = {},
): CodebaseMapOverview {
  try {
    const resolved = resolveRunDir(repoRoot, runSelector);
    return buildCodebaseMapOverview(repoRoot, resolved.runDir, options);
  } catch (err) {
    return {
      ok: true,
      repo_root: repoRoot,
      generated_at: new Date().toISOString(),
      source: { kind: 'fallback' },
      summary: { total_nodes: 0, displayed_nodes: 0, total_edges: 0, displayed_edges: 0, truncated: false },
      nodes: [],
      edges: [],
      warnings: [`Failed to resolve run: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}
