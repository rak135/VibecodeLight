import { Command } from 'commander';

import {
  getToolProfile,
  isToolProfileId,
  listToolProfileSummaries,
  type ToolProfile,
  type ToolProfileSummary,
} from '../../../core/agent_guidance/tool_profiles.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface ToolsCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

/**
 * Register `vibecode tools …` commands (Phase 1B-3).
 *
 * Ships the `profile` subcommand: a thin wrapper over the shared core service
 * (`core/agent_guidance/tool_profiles`) — the same service the MCP tool
 * `vibecode_tool_profile` uses — so CLI-only agents get identical recommended
 * tool sets. Static and read-only: it touches no filesystem, shell, scanner, or
 * git. This is independent of `vibecode mcp tools` (which lists the live MCP
 * tool names); the two do not collide.
 */
export function registerToolsCommands(
  program: Command,
  dependencies: ToolsCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const tools = program
    .command('tools')
    .description('Agent tool guidance (advisory; read-only)');

  tools
    .command('profile')
    .description('Show named recommended tool sets (profiles). Omit --profile to list all profiles. Add --json for agent-readable output.')
    .option('--profile <id>', 'Profile id to show in full (omit to list all profiles)')
    .option('--json', 'Output canonical JSON envelope (recommended for agents)')
    .action((options: { profile?: string; json?: boolean }) => {
      // List mode.
      if (options.profile === undefined) {
        const profiles = listToolProfileSummaries();
        const data = { mode: 'list' as const, profiles, count: profiles.length };
        if (options.json) {
          console.log(JSON.stringify({ ok: true, data, artifacts: [], warnings: [] }));
          return;
        }
        printList(profiles);
        return;
      }

      // Single-profile mode.
      if (!isToolProfileId(options.profile)) {
        const known = listToolProfileSummaries().map((s) => s.profile_id);
        emitCliStructuredError(
          makeCliStructuredError(
            'INVALID_ARGUMENT',
            `unknown profile: ${JSON.stringify(options.profile)}`,
            '',
            known,
          ),
          { json: options.json, prefix: 'tools profile failed' },
        );
        return;
      }
      const profile = getToolProfile(options.profile);
      if (!profile) {
        emitCliStructuredError(
          makeCliStructuredError('INVALID_ARGUMENT', `unknown profile: ${options.profile}`, ''),
          { json: options.json, prefix: 'tools profile failed' },
        );
        return;
      }
      const data = { mode: 'profile' as const, profile };
      if (options.json) {
        console.log(JSON.stringify({ ok: true, data, artifacts: [], warnings: [] }));
        return;
      }
      printProfile(profile);
    });
}

function printList(profiles: ToolProfileSummary[]): void {
  console.log('tool profiles:');
  for (const p of profiles) {
    console.log(`  ${p.profile_id}: ${p.title} — ${p.purpose}`);
  }
  console.log('Run "vibecode tools profile --profile <id> --json" for one profile.');
  console.log('Add --json for agent-readable (machine-readable) output.');
}

function printProfile(profile: ToolProfile): void {
  console.log(`profile: ${profile.profile_id} (${profile.title})`);
  console.log(`purpose: ${profile.purpose}`);
  console.log('mcp_tools:');
  for (const t of profile.mcp_tools) console.log(`  ${t.name}: ${t.reason}`);
  console.log('cli_commands:');
  for (const c of profile.cli_commands) console.log(`  ${c.command}`);
  if (profile.next_steps.length > 0) {
    console.log('next_steps:');
    for (const n of profile.next_steps) console.log(`  ${n}`);
  }
  if (profile.warnings.length > 0) {
    console.log('warnings:');
    for (const w of profile.warnings) console.log(`  ${w}`);
  }
}
