/** Codebase Map panel renderer module. */

export interface CodebaseMapNode {
  id: string;
  path: string;
  label: string;
  kind: 'source' | 'test' | 'doc' | 'config' | 'generated' | 'unknown';
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
  type: 'import' | 'test' | 'entrypoint' | 'folder' | 'related';
  evidence?: string;
}

export interface CodebaseMapSummary {
  total_nodes: number;
  displayed_nodes: number;
  total_edges: number;
  displayed_edges: number;
  truncated: boolean;
}

export interface CodebaseMapOverview {
  ok: boolean;
  repo_root: string;
  generated_at: string;
  source: { kind: string; run_id?: string };
  summary: CodebaseMapSummary;
  nodes: CodebaseMapNode[];
  edges: CodebaseMapEdge[];
  warnings: string[];
}

export interface CodebaseMapPanelModule {
  open(): void;
  close(): void;
  refresh(): Promise<void>;
}

declare global {
  interface Window {
    CodebaseMapPanel?: CodebaseMapPanelModule;
  }
}
