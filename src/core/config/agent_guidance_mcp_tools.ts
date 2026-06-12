import type { AgentGuidanceMcpToolMetadata } from './agent_guidance_config.js';

/**
 * Settings groups for the VibecodeMCP Tool Contract v1 public tools. The
 * canonical registry lives in `src/app/mcp/tool_registry.ts`; tests assert this
 * display mapping stays in lockstep with the public registry.
 */
export const AGENT_GUIDANCE_MCP_TOOL_GROUPS: Readonly<
  Record<AgentGuidanceMcpToolMetadata['group'], readonly string[]>
> = Object.freeze({
  workspace_orientation: Object.freeze([
    'vibecode_session_start',
    'vibecode_workspace_snapshot',
    'vibecode_project_instructions',
    'vibecode_changes',
  ]),
  codegraph: Object.freeze([
    'vibecode_codegraph_search',
    'vibecode_codegraph_explore',
    'vibecode_codegraph_callers',
    'vibecode_codegraph_impact',
  ]),
  runs_artifacts: Object.freeze([
    'vibecode_run_status',
    'vibecode_artifact_read',
  ]),
  coordination: Object.freeze([
    'vibecode_build_start',
    'vibecode_build_scope',
    'vibecode_build_finish',
    'vibecode_handoff',
  ]),
});

const DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  vibecode_session_start: 'Start or resume an attributed VibecodeMCP agent session.',
  vibecode_workspace_snapshot: 'Compact bounded workspace, safety, run, and CodeGraph snapshot.',
  vibecode_project_instructions: 'Bounded project instructions and repository operating rules.',
  vibecode_run_status: 'Current/latest/specific run status and artifact availability.',
  vibecode_artifact_read: 'Unified public reader for allowlisted run and scan artifacts.',
  vibecode_changes: 'Claim-aware workspace change classification.',
  vibecode_codegraph_search: 'Find indexed symbols, files, and code entities.',
  vibecode_codegraph_explore: 'Explore a subsystem, flow, or architectural area.',
  vibecode_codegraph_callers: 'Find callers or dependencies of an indexed symbol.',
  vibecode_codegraph_impact: 'Estimate change impact for shared code or public APIs.',
  vibecode_build_start: 'Start build work and claim exact files as a work intent.',
  vibecode_build_scope: 'Add exact paths to or release clean paths from an existing work intent.',
  vibecode_build_finish: 'Run the final claim-aware safety check and return commit guard guidance.',
  vibecode_handoff: 'Prepare or consume handoff guidance without transferring ownership.',
});

export function buildAgentGuidanceMcpTools(opts: {
  availableNames?: ReadonlySet<string>;
} = {}): AgentGuidanceMcpToolMetadata[] {
  const out: AgentGuidanceMcpToolMetadata[] = [];
  for (const group of Object.keys(AGENT_GUIDANCE_MCP_TOOL_GROUPS) as Array<
    AgentGuidanceMcpToolMetadata['group']
  >) {
    for (const name of AGENT_GUIDANCE_MCP_TOOL_GROUPS[group]) {
      if (opts.availableNames && !opts.availableNames.has(name)) continue;
      out.push({
        name,
        group,
        description: DESCRIPTIONS[name] ?? '',
      });
    }
  }
  return out;
}
