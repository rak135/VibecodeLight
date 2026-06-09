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

describe('tool profiles — deterministic bootstrap recommendations', () => {
  const base: BootstrapProfileContext = {
    registered: true,
    operatingMode: 'build',
    hasClaimedDirtyFiles: false,
    scanAvailable: false,
    artifactsAvailable: false,
    hasConflictsOrStaleClaims: false,
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
