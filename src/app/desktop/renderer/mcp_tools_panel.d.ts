// Type declarations for the plain-JS MCP tool catalog renderer module.
//
// The renderer accepts the desktop bridge catalog DTO as data and does not
// maintain its own tool list.

export type McpToolSideEffect =
  | 'read_only'
  | 'coordination_write'
  | 'git_mutation'
  | 'generated_state_write'
  | 'unknown';

export interface McpToolCatalogItem {
  name: string;
  title: string;
  group: string;
  summary: string;
  description: string;
  side_effect: McpToolSideEffect;
  input_schema: unknown;
  output_contract: {
    summary: string;
    structured_content_shape?: unknown;
    important_fields?: string[];
    text_output_notes?: string;
    example_response?: unknown;
  };
  cli_equivalents: string[];
  profiles: string[];
  safety_notes: string[];
  source_files: string[];
  test_files: string[];
}

export interface McpToolCatalog {
  tool_count: number;
  generated_from: {
    registry: boolean;
    schemas: boolean;
    profiles: boolean;
  };
  groups: Array<{
    id: string;
    title: string;
    tool_names: string[];
  }>;
  tools: McpToolCatalogItem[];
  warnings: string[];
}

export interface McpToolCatalogRenderOptions {
  query?: string;
  group?: string;
  sideEffect?: 'all' | 'read_only' | 'writes' | 'git' | McpToolSideEffect;
  profile?: string;
  selectedName?: string;
}

export interface McpToolsPanelModule {
  filterTools(catalog: McpToolCatalog | null | undefined, options?: McpToolCatalogRenderOptions): McpToolCatalogItem[];
  renderCatalogHtml(catalog: McpToolCatalog | null | undefined, options?: McpToolCatalogRenderOptions): string;
}

declare const McpToolsPanel: McpToolsPanelModule;
export default McpToolsPanel;
