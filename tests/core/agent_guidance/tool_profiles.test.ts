import { describe, expect, test } from 'vitest';

import {
  TOOL_PROFILE_IDS,
  getToolProfile,
  isToolProfileId,
  listToolProfiles,
  listToolProfileSummaries,
  recommendBootstrapToolProfiles,
  toolProfileMcpToolNames,
  type BootstrapProfileContext,
} from '../../../src/core/agent_guidance/tool_profiles.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';

/**
 * Phase 1B-3: tool profiles core contract.
 *
 * What breaks if removed:
 *   - a profile could reference a renamed/removed MCP tool (stale guidance);
 *   - profile lists could grow unbounded or duplicate ids/tools;
 *   - the deterministic bootstrap recommendation logic could silently change.
 */

const KEY_PROFILES = [
  'read_only_orientation',
  'build_pre_edit',
  'build_post_edit',
  'scan_inspection',
  'artifact_continuation',
  'safe_commit',
  'conflict_resolution',
  'coordination_housekeeping',
  'runtime_preflight',
  'session_recovery',
  'team_handoff',
];

describe('tool profiles — structure', () => {
  test('lists all profiles in canonical order', () => {
    const profiles = listToolProfiles();
    expect(profiles.map((p) => p.profile_id)).toEqual([...TOOL_PROFILE_IDS]);
  });

  test('the key profiles all exist', () => {
    const ids = listToolProfiles().map((p) => p.profile_id);
    for (const id of KEY_PROFILES) {
      expect(ids).toContain(id);
    }
  });

  test('gets each profile by id and rejects an unknown id', () => {
    for (const id of TOOL_PROFILE_IDS) {
      const profile = getToolProfile(id);
      expect(profile).not.toBeNull();
      expect(profile?.profile_id).toBe(id);
    }
    expect(getToolProfile('does_not_exist')).toBeNull();
    expect(getToolProfile('')).toBeNull();
    expect(isToolProfileId('build_pre_edit')).toBe(true);
    expect(isToolProfileId('nope')).toBe(false);
    expect(isToolProfileId(42)).toBe(false);
  });

  test('every profile has a non-empty title and purpose', () => {
    for (const p of listToolProfiles()) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.purpose.length).toBeGreaterThan(0);
      expect(p.when_to_use.length).toBeGreaterThan(0);
    }
  });

  test('every profile has bounded, non-empty tool/command lists', () => {
    for (const p of listToolProfiles()) {
      expect(p.mcp_tools.length).toBeGreaterThan(0);
      expect(p.mcp_tools.length).toBeLessThanOrEqual(12);
      expect(p.cli_commands.length).toBeGreaterThan(0);
      expect(p.cli_commands.length).toBeLessThanOrEqual(12);
      for (const tool of p.mcp_tools) {
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool.reason.length).toBeGreaterThan(0);
      }
      for (const cmd of p.cli_commands) {
        expect(cmd.command.startsWith('vibecode ')).toBe(true);
        expect(cmd.command).toContain('--json');
        expect(cmd.reason.length).toBeGreaterThan(0);
      }
    }
  });

  test('no duplicate profile ids', () => {
    const ids = listToolProfiles().map((p) => p.profile_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('no duplicate MCP tool name within a single profile', () => {
    for (const p of listToolProfiles()) {
      const names = p.mcp_tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test('summaries are compact (id/title/purpose only) and cover every profile', () => {
    const summaries = listToolProfileSummaries();
    expect(summaries.map((s) => s.profile_id)).toEqual([...TOOL_PROFILE_IDS]);
    for (const s of summaries) {
      expect(Object.keys(s).sort()).toEqual(['profile_id', 'purpose', 'title']);
    }
  });
});

describe('tool profiles — no stale tool names', () => {
  test('every MCP tool referenced by any profile exists in the canonical registry', () => {
    const registry = new Set(VIBECODE_MCP_TOOL_NAMES);
    for (const name of toolProfileMcpToolNames()) {
      expect(registry.has(name)).toBe(true);
    }
  });

  test('profiles never reference an MCP commit/shell/git-write tool (no such tool exists)', () => {
    // Commit mutation is CLI-only by design; a profile must not invent an MCP commit tool.
    for (const name of toolProfileMcpToolNames()) {
      expect(name).not.toMatch(/commit/i);
    }
  });
});

describe('tool profiles — dogfood polish guidance', () => {
  // A1: comma-valued --sections must be shown as ONE quoted argument so the
  // example is correct under PowerShell/pnpm.
  test('scan-related --sections examples are passed as one quoted argument', () => {
    const sectionsCommands = listToolProfiles()
      .flatMap((p) => p.cli_commands)
      .filter((c) => c.command.includes('--sections'));
    expect(sectionsCommands.length).toBeGreaterThan(0);
    for (const c of sectionsCommands) {
      // Quoted as a single arg, e.g. --sections "files,commands,tests,symbols".
      expect(c.command).toMatch(/--sections "[^"]+"/);
      // Never quote each section separately.
      expect(c.command).not.toMatch(/--sections "\w+"\s+"\w+"/);
    }
  });

  // A2: npm/pnpm/yarn install or package changes can modify lockfiles, which
  // then block finalize. Build/commit profiles must warn about claiming a
  // deliberate lockfile change or reverting an accidental one.
  test('build_pre_edit and safe_commit warn about lockfile changes', () => {
    for (const id of ['build_pre_edit', 'safe_commit'] as const) {
      const profile = getToolProfile(id);
      expect(profile).not.toBeNull();
      const warnings = (profile?.warnings ?? []).join(' ').toLowerCase();
      expect(warnings).toMatch(/lockfile|package-lock/);
    }
  });
});

describe('tool profiles — Phase 3A isolated commit guidance', () => {
  test('safe_commit explains isolated commits, skipped unclaimed files, and staged-unclaimed blocks', () => {
    const profile = getToolProfile('safe_commit');
    expect(profile).not.toBeNull();
    const text = [...(profile?.next_steps ?? []), ...(profile?.warnings ?? [])].join(' ').toLowerCase();
    // Isolated commit semantics: only claimed files are staged; unrelated
    // unclaimed dirty files are skipped with a warning and stay dirty.
    expect(text).toContain('unclaimed');
    expect(text).toContain('skipped');
    expect(text).toMatch(/stay|remain/);
    // Staged unclaimed/foreign files block: unstage/review them, never commit them.
    expect(text).toMatch(/unstage/);
    // Never bypass the guard without explicit human direction.
    expect(text).toContain('bypass');
  });

  test('build_post_edit mentions that commit guard can skip unrelated unclaimed dirty files', () => {
    const profile = getToolProfile('build_post_edit');
    expect(profile).not.toBeNull();
    const text = [...(profile?.next_steps ?? []), ...(profile?.warnings ?? [])].join(' ').toLowerCase();
    expect(text).toContain('unclaimed');
    expect(text).toMatch(/skip/);
  });
});

describe('tool profiles — coordination_housekeeping (Phase 2C)', () => {
  test('coordination_housekeeping profile exists with heartbeat + housekeeping commands', () => {
    const profile = getToolProfile('coordination_housekeeping');
    expect(profile).not.toBeNull();
    const toolNames = profile!.mcp_tools.map((t) => t.name);
    expect(toolNames).toContain('vibecode_session_start');
    expect(toolNames).toContain('vibecode_workspace_snapshot');
    expect(toolNames).toContain('vibecode_changes');
    expect(toolNames).toContain('vibecode_handoff');

    const commands = profile!.cli_commands.map((c) => c.command);
    expect(commands.some((c) => c.includes('agents heartbeat --agent <agent_id>'))).toBe(true);
    expect(commands.some((c) => c.includes('claims intents list'))).toBe(true);
    expect(commands.some((c) => c.includes('claims list'))).toBe(true);
    expect(commands.some((c) => c.includes('claims reap --dry-run'))).toBe(true);
  });

  test('coordination_housekeeping warns against cross-agent release, force cleanup, and raw state edits', () => {
    const profile = getToolProfile('coordination_housekeeping');
    const warnings = (profile?.warnings ?? []).join(' ').toLowerCase();
    expect(warnings).toContain('another agent');
    expect(warnings).toMatch(/force|automatic/);
    expect(warnings).toContain('.vibecode');
    expect(warnings).toContain('unclaimed');
  });

  test('coordination_housekeeping only recommends release-by-intent for your own clean intents', () => {
    const profile = getToolProfile('coordination_housekeeping');
    const text = [
      ...(profile?.next_steps ?? []),
      ...(profile?.warnings ?? []),
      ...(profile?.cli_commands.map((c) => c.reason) ?? []),
    ].join(' ').toLowerCase();
    expect(text).toContain('own');
  });
});

describe('tool profiles — runtime_preflight (Phase 3B)', () => {
  test('runtime_preflight exists with bootstrap/heartbeat/server-identity guidance', () => {
    const profile = getToolProfile('runtime_preflight');
    expect(profile).not.toBeNull();
    const toolNames = profile!.mcp_tools.map((t) => t.name);
    expect(toolNames).toContain('vibecode_session_start');
    expect(toolNames).toContain('vibecode_workspace_snapshot');
    expect(toolNames).toContain('vibecode_changes');
    expect(toolNames).toContain('vibecode_build_finish');

    const commands = profile!.cli_commands.map((c) => c.command);
    expect(commands.some((c) => c.includes('session bootstrap --agent <agent_id>'))).toBe(true);
    expect(commands.some((c) => c.includes('agents heartbeat --agent <agent_id>'))).toBe(true);
    expect(commands.some((c) => c.includes('mcp tools'))).toBe(true);
    expect(commands.some((c) => c.includes('commit guard --agent <agent_id> --dry-run'))).toBe(true);
  });

  test('runtime_preflight teaches stale-server detection and CLI fallback', () => {
    const profile = getToolProfile('runtime_preflight');
    const text = [
      ...(profile?.next_steps ?? []),
      ...(profile?.warnings ?? []),
      ...(profile?.mcp_tools.map((t) => t.reason) ?? []),
      ...(profile?.cli_commands.map((c) => c.reason) ?? []),
    ].join(' ').toLowerCase();
    expect(text).toMatch(/stale/);
    expect(text).toMatch(/restart|reconnect/);
    expect(text).toContain('cli fallback');
    expect(text).toMatch(/tool_count|tool count/);
  });

  test('runtime_preflight stays read-only: no release/reap/resolve commands', () => {
    const profile = getToolProfile('runtime_preflight');
    const commands = (profile?.cli_commands ?? []).map((c) => c.command).join(' ');
    expect(commands).not.toContain('intent-release');
    expect(commands).not.toContain('claims reap');
    expect(commands).not.toContain('conflicts resolve');
    // The only commit-guard reference is the dry-run preview.
    const guardCommands = (profile?.cli_commands ?? []).filter((c) => c.command.includes('commit guard'));
    for (const c of guardCommands) expect(c.command).toContain('--dry-run');
  });
});

describe('tool profiles — session_recovery (Phase 3C)', () => {
  test('session_recovery exists with bootstrap-first resume guidance and real commands', () => {
    const profile = getToolProfile('session_recovery');
    expect(profile).not.toBeNull();
    const toolNames = profile!.mcp_tools.map((t) => t.name);
    expect(toolNames).toContain('vibecode_session_start');
    expect(toolNames).toContain('vibecode_workspace_snapshot');
    expect(toolNames).toContain('vibecode_changes');
    expect(toolNames).toContain('vibecode_build_finish');
    expect(toolNames).toContain('vibecode_build_scope');

    const commands = profile!.cli_commands.map((c) => c.command);
    expect(commands.some((c) => c.includes('session bootstrap --agent <agent_id>'))).toBe(true);
    expect(commands.some((c) => c.includes('agents heartbeat --agent <agent_id>'))).toBe(true);
    expect(commands.some((c) => c.includes('--register'))).toBe(true);
    expect(commands.some((c) => c.includes('git changes --agent <agent_id>'))).toBe(true);
    expect(commands.some((c) => c.includes('finalize check --agent <agent_id>'))).toBe(true);
    expect(commands.some((c) => c.includes('commit guard --agent <agent_id> --dry-run'))).toBe(true);
    expect(commands.some((c) => c.includes('mcp tools'))).toBe(true);
  });

  test('session_recovery teaches the resume rules: heartbeat-first, no terminated reuse, no released-claim reuse', () => {
    const profile = getToolProfile('session_recovery');
    const text = [
      ...(profile?.when_to_use ?? []),
      ...(profile?.next_steps ?? []),
      ...(profile?.warnings ?? []),
      ...(profile?.mcp_tools.map((t) => t.reason) ?? []),
      ...(profile?.cli_commands.map((c) => c.reason) ?? []),
    ].join(' ').toLowerCase();
    expect(text).toContain('terminated');
    expect(text).toMatch(/released claim|re-claim|reuse/);
    expect(text).toMatch(/new agent|register/);
    expect(text).toContain('cli fallback');
    expect(text).toMatch(/restart|reconnect/);
    expect(text).toContain('.vibecode');
  });

  test('session_recovery forbids automatic recovery: no force, no cross-agent release, no auto cleanup', () => {
    const profile = getToolProfile('session_recovery');
    const warnings = (profile?.warnings ?? []).join(' ').toLowerCase();
    expect(warnings).toMatch(/never|no /);
    expect(warnings).toMatch(/ownership transfer|another agent/);
    expect(warnings).toMatch(/force|automatic/);
    const commands = (profile?.cli_commands ?? []).map((c) => c.command).join(' ');
    expect(commands).not.toMatch(/--force/);
    // Releases and guard runs are dry-run-first in the recovery flow.
    const guardCommands = (profile?.cli_commands ?? []).filter((c) => c.command.includes('commit guard'));
    for (const c of guardCommands) expect(c.command).toContain('--dry-run');
    const releaseCommands = (profile?.cli_commands ?? []).filter((c) => c.command.includes('intent-release'));
    for (const c of releaseCommands) expect(c.command).toContain('--dry-run');
  });
});

describe('tool profiles — team_handoff (Phase 4A)', () => {
  test('team_handoff exists with handoff-prepare-first guidance and real commands', () => {
    const profile = getToolProfile('team_handoff');
    expect(profile).not.toBeNull();
    const toolNames = profile!.mcp_tools.map((t) => t.name);
    expect(toolNames).toContain('vibecode_handoff');
    expect(toolNames).toContain('vibecode_session_start');
    expect(toolNames).toContain('vibecode_changes');
    expect(toolNames).toContain('vibecode_build_start');

    const commands = profile!.cli_commands.map((c) => c.command);
    expect(commands.some((c) => c.includes('handoff prepare --agent <agent_id>'))).toBe(true);
    expect(commands.some((c) => c.includes('commit guard --agent <agent_id> --dry-run'))).toBe(true);
    expect(commands.some((c) => c.includes('intent-release') && c.includes('--dry-run'))).toBe(true);
    expect(commands.some((c) => c.includes('claims release --claim <claim_id> --json'))).toBe(true);
    expect(commands.some((c) => c.includes('--register'))).toBe(true);
  });

  test('team_handoff teaches the Phase 4B consumer side: handoff guide before continuing', () => {
    const profile = getToolProfile('team_handoff');
    const toolNames = profile!.mcp_tools.map((t) => t.name);
    expect(toolNames).toContain('vibecode_handoff');

    const commands = profile!.cli_commands.map((c) => c.command);
    expect(commands.some((c) => c.includes('handoff guide --from-agent <from_agent_id>'))).toBe(true);

    const text = [
      ...(profile?.next_steps ?? []),
      ...(profile?.mcp_tools.map((t) => t.reason) ?? []),
      ...(profile?.cli_commands.map((c) => c.reason) ?? []),
    ].join(' ').toLowerCase();
    // Producer runs prepare before ending; consumer runs guide before continuing.
    expect(text).toMatch(/handoff guide/);
    expect(text).toMatch(/before continuing|before starting/);
    expect(text).toMatch(/not ready.*(do not|wait)|do not proceed/);
    expect(text).toMatch(/different next agent|different agent/);
    expect(text).toMatch(/same-agent|same agent/);
    expect(text).toContain('session_recovery');
  });

  test('team_handoff teaches the boundary rules: no transfer, no cross-agent release, no raw bypass', () => {
    const profile = getToolProfile('team_handoff');
    const text = [
      ...(profile?.when_to_use ?? []),
      ...(profile?.next_steps ?? []),
      ...(profile?.warnings ?? []),
      ...(profile?.mcp_tools.map((t) => t.reason) ?? []),
      ...(profile?.cli_commands.map((c) => c.reason) ?? []),
    ].join(' ').toLowerCase();
    expect(text).toMatch(/ownership transfer/);
    expect(text).toMatch(/another agent/);
    expect(text).toContain('.vibecode');
    expect(text).toMatch(/register/);
    expect(text).toMatch(/commit|revert/);
    expect(text).toMatch(/session_recovery|same agent/);
    expect(text).toMatch(/conflict_resolution|runtime_preflight/);
    expect(text).toMatch(/active claims/);
    expect(text).toMatch(/claim-release|claims release|release.*claims/);
  });

  test('team_handoff guard/release examples are dry-run-first and never forced', () => {
    const profile = getToolProfile('team_handoff');
    const commands = (profile?.cli_commands ?? []).map((c) => c.command).join(' ');
    expect(commands).not.toMatch(/--force/);
    const guardCommands = (profile?.cli_commands ?? []).filter((c) => c.command.includes('commit guard'));
    expect(guardCommands.length).toBeGreaterThan(0);
    for (const c of guardCommands) expect(c.command).toContain('--dry-run');
  });
});

describe('tool profiles — deterministic bootstrap recommendations', () => {
  const base: BootstrapProfileContext = {
    registered: true,
    operatingMode: 'build',
    hasClaimedDirtyFiles: false,
    scanAvailable: false,
    artifactsAvailable: false,
    hasConflictsOrStaleClaims: false,
    hasStaleCoordination: false,
  };

  function ids(ctx: BootstrapProfileContext): string[] {
    return recommendBootstrapToolProfiles(ctx).map((r) => r.profile_id);
  }

  test('not-registered context recommends read_only_orientation', () => {
    expect(ids({ ...base, registered: false, operatingMode: null })).toContain('read_only_orientation');
  });

  test('read_only agent recommends read_only_orientation', () => {
    expect(ids({ ...base, operatingMode: 'read_only' })).toContain('read_only_orientation');
  });

  test('build agent with no claimed dirty files recommends build_pre_edit', () => {
    const result = ids({ ...base, operatingMode: 'build', hasClaimedDirtyFiles: false });
    expect(result).toContain('build_pre_edit');
    expect(result).not.toContain('build_post_edit');
  });

  test('build agent with claimed dirty files recommends build_post_edit and safe_commit', () => {
    const result = ids({ ...base, operatingMode: 'build', hasClaimedDirtyFiles: true });
    expect(result).toContain('build_post_edit');
    expect(result).toContain('safe_commit');
    expect(result).not.toContain('build_pre_edit');
  });

  test('scan availability adds scan_inspection; artifacts add artifact_continuation', () => {
    const result = ids({ ...base, scanAvailable: true, artifactsAvailable: true });
    expect(result).toContain('scan_inspection');
    expect(result).toContain('artifact_continuation');
  });

  test('conflicts/stale claims add conflict_resolution', () => {
    expect(ids({ ...base, hasConflictsOrStaleClaims: true })).toContain('conflict_resolution');
  });

  test('stale coordination state adds coordination_housekeeping (Phase 2C)', () => {
    expect(ids({ ...base, hasStaleCoordination: true })).toContain('coordination_housekeeping');
    expect(ids(base)).not.toContain('coordination_housekeeping');
  });

  test('recommendations are deduplicated and reference real profile ids', () => {
    const recs = recommendBootstrapToolProfiles({
      ...base,
      operatingMode: 'build',
      hasClaimedDirtyFiles: true,
      scanAvailable: true,
      artifactsAvailable: true,
      hasConflictsOrStaleClaims: true,
    });
    const recIds = recs.map((r) => r.profile_id);
    expect(new Set(recIds).size).toBe(recIds.length);
    for (const rec of recs) {
      expect(isToolProfileId(rec.profile_id)).toBe(true);
      expect(rec.reason.length).toBeGreaterThan(0);
    }
  });
});
