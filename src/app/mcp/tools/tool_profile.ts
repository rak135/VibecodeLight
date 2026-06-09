import {
  getToolProfile,
  isToolProfileId,
  listToolProfileSummaries,
  type ToolProfile,
  type ToolProfileSummary,
} from '../../../core/agent_guidance/tool_profiles.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateNonEmptyString,
  TOOL_PROFILE_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

/**
 * Phase 1B-3 — `vibecode_tool_profile`.
 *
 * Return a named, deterministic recommended tool set for a common agent
 * situation (read-only orientation, before/after editing, scan inspection,
 * artifact continuation, safe commit, conflict resolution). Thin wrapper over
 * the shared core service (`core/agent_guidance/tool_profiles`) — the same
 * service the `vibecode tools profile` CLI command uses, so MCP and CLI return
 * identical data. Static and read-only: no filesystem reads, no shell, no
 * scanner, no git, no mutation. Omit `profile` to list profiles; pass a profile
 * id to get one. Unknown ids are rejected with INVALID_ARGUMENT.
 */
const TOOL_NAME = 'vibecode_tool_profile';
const ALLOWED_KEYS = new Set(['profile']);

function renderList(summaries: ToolProfileSummary[]): string {
  const lines: string[] = ['# Vibecode tool profiles', ''];
  lines.push('Named recommended tool sets. Call again with profile:<id> for the full set.');
  lines.push('');
  for (const s of summaries) {
    lines.push(`- ${s.profile_id}: ${s.title} — ${s.purpose}`);
  }
  return lines.join('\n');
}

function renderProfile(profile: ToolProfile): string {
  const lines: string[] = [`# Tool profile: ${profile.profile_id}`, ''];
  lines.push(profile.title);
  lines.push(`purpose: ${profile.purpose}`);
  if (profile.when_to_use.length > 0) {
    lines.push('', 'when_to_use:');
    for (const w of profile.when_to_use) lines.push(`  - ${w}`);
  }
  lines.push('', 'mcp_tools:');
  for (const t of profile.mcp_tools) lines.push(`  - ${t.name}: ${t.reason}`);
  lines.push('', 'cli_commands:');
  for (const c of profile.cli_commands) lines.push(`  - ${c.command}`);
  if (profile.next_steps.length > 0) {
    lines.push('', 'next_steps:');
    for (const n of profile.next_steps) lines.push(`  - ${n}`);
  }
  if (profile.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const w of profile.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

export function buildToolProfileTool(): McpToolDefinition {
  const inputSchema: JsonSchema = TOOL_PROFILE_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode tool profile',
    description:
      'Return a named, deterministic recommended tool set for a common agent situation (read_only_orientation, build_pre_edit, build_post_edit, scan_inspection, artifact_continuation, safe_commit, conflict_resolution). Omit profile to list all profiles with short descriptions; pass a profile id to get its recommended MCP tools + CLI fallbacks, when-to-use, next steps, and warnings. Static and read-only — no filesystem, shell, scanner, or git access.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = (code: McpErrorCode, message: string): McpToolFormattedResult =>
        formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(code, message),
        });

      const args = (input.arguments ?? {}) as Record<string, unknown>;
      const unknown = rejectUnknownKeys(args, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);

      try {
        // No profile → list mode.
        if (args.profile === undefined || args.profile === null) {
          const profiles = listToolProfileSummaries();
          const data = { mode: 'list' as const, profiles, count: profiles.length };
          return formatSimpleSuccess({
            tool: TOOL_NAME,
            repoRoot: input.context.repoRoot,
            text: renderList(profiles),
            data,
            warnings: [],
            durationMs: Date.now() - started,
          });
        }

        // Profile supplied → single-profile mode.
        const profileId = validateNonEmptyString(args.profile, 'profile');
        if (!profileId.ok) return fail('INVALID_ARGUMENT', profileId.message);
        if (!isToolProfileId(profileId.value)) {
          const known = listToolProfileSummaries().map((s) => s.profile_id);
          return fail(
            'INVALID_ARGUMENT',
            `unknown profile: ${JSON.stringify(profileId.value)}. Known profiles: ${known.join(', ')}.`,
          );
        }
        const profile = getToolProfile(profileId.value);
        if (!profile) return fail('INVALID_ARGUMENT', `unknown profile: ${profileId.value}`);
        const data = { mode: 'profile' as const, profile };
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderProfile(profile),
          data,
          warnings: [],
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('TOOL_PROFILE_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
