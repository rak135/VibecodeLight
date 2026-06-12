import {
  AGENT_GUIDANCE_MCP_TOOL_GROUPS,
} from '../../core/config/agent_guidance_mcp_tools.js';
import { listToolProfiles } from '../../core/agent_guidance/tool_profiles.js';
import { buildVibecodeMcpTools, type McpToolDefinition } from './tool_registry.js';

export type McpToolSideEffect =
  | 'read_only'
  | 'coordination_write'
  | 'git_mutation'
  | 'generated_state_write'
  | 'unknown';

export interface McpToolOutputContract {
  summary: string;
  structured_content_shape?: unknown;
  important_fields?: string[];
  text_output_notes?: string;
  example_response?: unknown;
}

export interface McpToolCatalogItem {
  name: string;
  title: string;
  group: string;
  summary: string;
  description: string;
  side_effect: McpToolSideEffect;
  input_schema: unknown;
  output_contract: McpToolOutputContract;
  cli_equivalents: string[];
  profiles: string[];
  safety_notes: string[];
  source_files: string[];
  test_files: string[];
}

export interface McpToolCatalog {
  tool_count: number;
  generated_from: {
    registry: true;
    schemas: true;
    profiles: true;
  };
  groups: Array<{
    id: string;
    title: string;
    tool_names: string[];
  }>;
  tools: McpToolCatalogItem[];
  warnings: string[];
}

export interface McpToolContractMetadata {
  title: string;
  summary: string;
  side_effect: McpToolSideEffect;
  output_contract: McpToolOutputContract;
  cli_equivalents?: string[];
  safety_notes: string[];
  source_files: string[];
  test_files: string[];
  description?: string;
}

const GROUP_TITLES: Record<string, string> = Object.freeze({
  workspace_orientation: 'Workspace orientation',
  codegraph: 'CodeGraph',
  runs_artifacts: 'Runs and artifacts',
  coordination: 'Coordination',
});

const STANDARD_STRUCTURED_ENVELOPE = Object.freeze({
  ok: 'boolean',
  tool: 'string',
  repo_root: 'string',
  warnings: 'string[]',
  truncated: 'boolean',
  duration_ms: 'number',
  data: 'tool-specific object',
});

function output(summary: string, important_fields: string[]): McpToolOutputContract {
  return {
    summary,
    structured_content_shape: STANDARD_STRUCTURED_ENVELOPE,
    important_fields,
    text_output_notes: 'Text output is a compact Markdown summary of the same structured data.',
  };
}

function contract(
  title: string,
  summary: string,
  side_effect: McpToolSideEffect,
  importantFields: string[],
  opts: {
    cli?: string[];
    safety: string[];
    source: string[];
    tests: string[];
    description?: string;
  },
): McpToolContractMetadata {
  return {
    title,
    summary,
    side_effect,
    output_contract: output(summary, importantFields),
    cli_equivalents: opts.cli ?? [],
    safety_notes: opts.safety,
    source_files: opts.source,
    test_files: opts.tests,
    description: opts.description,
  };
}

const READ_ONLY = 'Read-only: does not edit source files, mutate git, or write coordination state except activity attribution.';
const COORDINATION_WRITE = 'Writes only generated advisory coordination state under .vibecode/coordination; does not edit source files or mutate git.';

export const MCP_TOOL_CONTRACTS: Readonly<Record<string, McpToolContractMetadata>> = Object.freeze({
  vibecode_session_start: contract(
    'Session start',
    'Start or resume an attributed agent session.',
    'generated_state_write',
    ['agent_id', 'session_id', 'mode', 'status', 'last_activity_at', 'recommended_next_tools'],
    {
      cli: ['vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json'],
      safety: ['Writes only generated session metadata and activity timestamps; no source or git mutation.'],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/core/agent_session/bootstrap.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts'],
    },
  ),
  vibecode_workspace_snapshot: contract(
    'Workspace snapshot',
    'Return a compact bounded workspace overview.',
    'read_only',
    ['repo', 'agent', 'workspace_safety', 'claims_summary', 'run', 'codegraph'],
    {
      cli: ['vibecode doctor --json', 'vibecode git changes --json'],
      safety: [READ_ONLY],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/app/mcp/tools/workspace_status.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts'],
    },
  ),
  vibecode_project_instructions: contract(
    'Project instructions',
    'Return relevant project instructions, repository rules, and operating constraints.',
    'read_only',
    ['instructions', 'conflicts', 'warnings'],
    {
      safety: [READ_ONLY],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/app/mcp/tools/project_instructions.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts', 'tests/app/mcp/workspace_tools.test.ts'],
    },
  ),
  vibecode_run_status: contract(
    'Run status',
    'Return current/latest/specific run status and artifact availability.',
    'read_only',
    ['run_id', 'created_at', 'task', 'scan_available', 'artifacts'],
    {
      cli: ['vibecode runs show current --json'],
      safety: [READ_ONLY],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/app/mcp/tools/run_get.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts'],
    },
  ),
  vibecode_artifact_read: contract(
    'Artifact read',
    'Read allowlisted run and scan artifacts through one public API.',
    'read_only',
    ['artifact_type', 'artifact_key', 'content', 'truncated', 'next_cursor'],
    {
      cli: ['vibecode runs artifact-read --run current --artifact <artifact> --json', 'vibecode scan artifact-read --run current --artifact <artifact> --json'],
      safety: ['Read-only; preserves separate internal allowlists for run artifacts and scan artifacts.'],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/app/mcp/tools/artifact_read.ts', 'src/app/mcp/tools/scan_artifact_read.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts', 'tests/app/mcp/artifact_read_continuation.test.ts'],
    },
  ),
  vibecode_changes: contract(
    'Changes',
    'Return claim-aware workspace change classification.',
    'read_only',
    ['summary', 'files', 'blockers', 'warnings', 'recommended_next_tools'],
    {
      cli: ['vibecode git changes --agent <agent_id> --json'],
      safety: [READ_ONLY, 'Unclaimed dirty files are workspace safety alarms, not proof of which agent edited them.'],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/app/mcp/tools/git_changes.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts', 'tests/app/mcp/git_changes_tool.test.ts'],
    },
  ),
  vibecode_codegraph_search: contract(
    'CodeGraph search',
    'Find indexed symbols, files, and code entities.',
    'read_only',
    ['results', 'codegraph_stale', 'warnings'],
    {
      cli: ['vibecode codegraph search "<query>" --json'],
      safety: [READ_ONLY],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/app/mcp/tools/codegraph_search.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts', 'tests/app/mcp/codegraph_tools.test.ts'],
    },
  ),
  vibecode_codegraph_explore: contract(
    'CodeGraph explore',
    'Explore a subsystem, flow, or architectural area.',
    'read_only',
    ['summary', 'key_files', 'key_symbols', 'relationships', 'suggested_reads'],
    {
      cli: ['vibecode codegraph context "<topic>" --json'],
      safety: [READ_ONLY],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/app/mcp/tools/codegraph_context.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts', 'tests/app/mcp/codegraph_tools.test.ts'],
    },
  ),
  vibecode_codegraph_callers: contract(
    'CodeGraph callers',
    'Find who calls or depends on a symbol before changing it.',
    'read_only',
    ['callers', 'warnings'],
    {
      cli: ['vibecode codegraph callers "<symbol>" --json'],
      safety: [READ_ONLY],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/app/mcp/tools/codegraph_symbol.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts', 'tests/app/mcp/codegraph_tools.test.ts'],
    },
  ),
  vibecode_codegraph_impact: contract(
    'CodeGraph impact',
    'Estimate impact before changing shared code or public APIs.',
    'read_only',
    ['impacted_files', 'impacted_symbols', 'test_candidates', 'risk_level', 'warnings'],
    {
      cli: ['vibecode codegraph impact "<target>" --json'],
      safety: [READ_ONLY],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/app/mcp/tools/codegraph_symbol.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts', 'tests/app/mcp/codegraph_tools.test.ts'],
    },
  ),
  vibecode_build_start: contract(
    'Build start',
    'Start build work and claim exact files.',
    'coordination_write',
    ['intent_id', 'claimed_paths', 'denied_paths', 'warnings', 'blockers'],
    {
      cli: ['vibecode claims add-bulk --agent <agent_id> --intent "<task>" --path <path> --json'],
      safety: [COORDINATION_WRITE, 'Requires a build-mode agent and exact paths; rejects directories, globs, generated paths, and active foreign claims.'],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/core/coordination/bulk_claims.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts', 'tests/app/mcp/claims_bulk_tools.test.ts'],
    },
  ),
  vibecode_build_scope: contract(
    'Build scope',
    'Modify an existing build scope by adding or releasing exact paths.',
    'coordination_write',
    ['intent_id', 'added_claims', 'released_claims', 'blocked', 'warnings'],
    {
      cli: ['vibecode claims add-bulk --agent <agent_id> --intent-id <intent_id> --path <path> --json'],
      safety: [COORDINATION_WRITE, 'Same-agent intent only; no directory/glob inference; dirty release paths are blocked.'],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/core/coordination/bulk_claims.ts', 'src/core/coordination/intent_lifecycle.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts'],
    },
  ),
  vibecode_build_finish: contract(
    'Build finish',
    'Run final claim-aware safety checks and return commit guard guidance.',
    'read_only',
    ['status', 'owned_dirty_files', 'unclaimed_dirty_files', 'staged_blockers', 'commit_guard'],
    {
      cli: ['vibecode finalize check --agent <agent_id> --json', 'vibecode commit guard --agent <agent_id> --dry-run --json'],
      safety: ['Does not commit. Optional release_clean_claims only releases clean claims owned by the same agent/intent.'],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/core/coordination/finalize_check.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts', 'tests/app/mcp/finalize_tool.test.ts'],
    },
  ),
  vibecode_handoff: contract(
    'Handoff',
    'Prepare or consume handoff guidance without transferring ownership.',
    'read_only',
    ['handoff_state', 'ownership_transferred', 'must_claim_explicitly', 'summary', 'claimed_paths'],
    {
      cli: ['vibecode handoff prepare --agent <agent_id> --json', 'vibecode handoff guide --from-agent <agent_id> --json'],
      safety: [READ_ONLY, 'Visibility only; ownership_transferred=false and the next agent must claim explicitly.'],
      source: ['src/app/mcp/tools/v1_contract.ts', 'src/core/agent_session/handoff_packet.ts', 'src/core/agent_session/handoff_guide.ts'],
      tests: ['tests/app/mcp/v1_tool_contract.test.ts', 'tests/app/mcp/handoff_tool.test.ts', 'tests/app/mcp/handoff_guide_tool.test.ts'],
    },
  ),
});

function buildToolToGroup(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [group, names] of Object.entries(AGENT_GUIDANCE_MCP_TOOL_GROUPS)) {
    for (const name of names) out.set(name, group);
  }
  return out;
}

function buildProfilesByTool(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const profile of listToolProfiles()) {
    for (const tool of profile.mcp_tools) {
      const current = out.get(tool.name) ?? [];
      current.push(profile.profile_id);
      out.set(tool.name, current);
    }
  }
  return out;
}

function makeItem(
  registryTool: McpToolDefinition,
  group: string,
  metadata: McpToolContractMetadata,
  profiles: string[],
): McpToolCatalogItem {
  return {
    name: registryTool.name,
    title: metadata.title,
    group,
    summary: metadata.summary,
    description: metadata.description ?? registryTool.description,
    side_effect: metadata.side_effect,
    input_schema: registryTool.inputSchema,
    output_contract: metadata.output_contract,
    cli_equivalents: [...(metadata.cli_equivalents ?? [])],
    profiles: [...profiles],
    safety_notes: [...metadata.safety_notes],
    source_files: [...metadata.source_files],
    test_files: [...metadata.test_files],
  };
}

export function getMcpToolCatalog(): McpToolCatalog {
  const registryTools = buildVibecodeMcpTools();
  const registryNames = registryTools.map((tool) => tool.name);
  const registryNameSet = new Set(registryNames);
  const toolToGroup = buildToolToGroup();
  const profilesByTool = buildProfilesByTool();
  const warnings: string[] = [];

  for (const name of registryNames) {
    if (!MCP_TOOL_CONTRACTS[name]) warnings.push(`MISSING_TOOL_CONTRACT: ${name}`);
    if (!toolToGroup.has(name)) warnings.push(`MISSING_TOOL_GROUP: ${name}`);
  }
  for (const name of Object.keys(MCP_TOOL_CONTRACTS)) {
    if (!registryNameSet.has(name)) warnings.push(`UNKNOWN_TOOL_CONTRACT: ${name}`);
  }

  const tools = registryTools.map((tool) =>
    makeItem(
      tool,
      toolToGroup.get(tool.name) ?? 'unknown',
      MCP_TOOL_CONTRACTS[tool.name],
      profilesByTool.get(tool.name) ?? [],
    ),
  );

  const groupedInRegistryOrder = new Map<string, string[]>();
  for (const name of registryNames) {
    const group = toolToGroup.get(name) ?? 'unknown';
    const current = groupedInRegistryOrder.get(group) ?? [];
    current.push(name);
    groupedInRegistryOrder.set(group, current);
  }
  const groups = [...groupedInRegistryOrder.entries()].map(([id, names]) => ({
    id,
    title: GROUP_TITLES[id] ?? id,
    tool_names: names,
  }));

  return {
    tool_count: registryTools.length,
    generated_from: { registry: true, schemas: true, profiles: true },
    groups,
    tools,
    warnings,
  };
}

export function getMcpToolDetail(name: string): McpToolCatalogItem | null {
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  return getMcpToolCatalog().tools.find((tool) => tool.name === name) ?? null;
}
