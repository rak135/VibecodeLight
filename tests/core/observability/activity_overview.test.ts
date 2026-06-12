import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { markAgentTerminated, registerAgent } from '../../../src/core/coordination/agents.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';
import {
  ACTIVITY_OVERVIEW_MAX_AGENTS,
  ACTIVITY_OVERVIEW_MAX_CLAIMS,
  ACTIVITY_OVERVIEW_MAX_RECENT_TOOL_CALLS,
  getActivityObservabilityOverview,
} from '../../../src/core/observability/activity_overview.js';
import { MCP_TOOL_USAGE_LOG_RELATIVE_PATH } from '../../../src/core/observability/mcp_usage_log.js';

/**
 * Read-only activity observability overview (core).
 *
 * What breaks if removed:
 *   - the desktop GUI could lose its single read-only source of truth for
 *     "who is using VibecodeMCP, what did they call, what do they own";
 *   - unclaimed dirty files could regress into per-agent blame instead of
 *     workspace-level safety warnings;
 *   - a missing/malformed usage log or failing git could crash the overview
 *     instead of degrading with warnings;
 *   - list caps could silently drop the accurate totals.
 */

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeGitRepo(): { repoRoot: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-activity-'));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  git(['init', '-q'], repoRoot);
  git(['config', 'user.email', 't@example.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  git(['config', 'commit.gpgsign', 'false'], repoRoot);
  git(['config', 'core.autocrlf', 'false'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repoRoot);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repoRoot);
  return { repoRoot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function makePlainDir(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-activity-plain-'));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function write(repoRoot: string, rel: string, content = 'x\n'): void {
  const p = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function writeUsageLog(repoRoot: string, lines: string[]): void {
  const logPath = path.join(repoRoot, MCP_TOOL_USAGE_LOG_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
}

function usageLine(opts: {
  tool: string;
  agentId?: string;
  agentMode?: string;
  ok?: boolean;
  errorCode?: string;
  timestamp?: string;
}): string {
  return JSON.stringify({
    schema_version: 1,
    timestamp: opts.timestamp ?? '2026-06-12T10:00:00.000Z',
    request_id: null,
    transport: 'stdio',
    source: 'mcp',
    tool: opts.tool,
    repo_root: '/x',
    ...(opts.agentId ? { agent_id: opts.agentId, session_id: opts.agentId } : {}),
    ...(opts.agentMode ? { agent_mode: opts.agentMode } : {}),
    input_summary: { has_agent_id: Boolean(opts.agentId), has_intent_id: false },
    ok: opts.ok !== false,
    duration_ms: 5,
    warnings: [],
    error: opts.ok === false ? { code: opts.errorCode ?? 'X_FAILED', message: 'm', retryable: false } : null,
    output_bytes: 10,
    truncated: false,
  });
}

function registerBuildAgent(repoRoot: string, agentId: string): void {
  registerAgent(
    repoRoot,
    { agent_name: agentId, agent_type: 'custom', metadata: { operating_mode: 'build', task: 'activity test' } },
    { agentId },
  );
}

describe('activity observability overview', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  afterEach(() => repo.cleanup());

  describe('usage event grouping', () => {
    beforeEach(() => {
      repo = makePlainDir();
    });

    test('groups usage events by agent with last-tool and error counts', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      registerBuildAgent(repo.repoRoot, 'agent-b');
      writeUsageLog(repo.repoRoot, [
        usageLine({ tool: 'vibecode_session_start', agentId: 'agent-a', timestamp: '2026-06-12T10:00:00.000Z' }),
        usageLine({ tool: 'vibecode_workspace_snapshot', agentId: 'agent-a', timestamp: '2026-06-12T10:01:00.000Z' }),
        usageLine({ tool: 'vibecode_build_start', agentId: 'agent-a', ok: false, errorCode: 'NO_CLAIM_PATHS', timestamp: '2026-06-12T10:02:00.000Z' }),
        usageLine({ tool: 'vibecode_changes', agentId: 'agent-b', timestamp: '2026-06-12T10:03:00.000Z' }),
      ]);
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      const a = overview.agents.find((x) => x.agent_id === 'agent-a');
      const b = overview.agents.find((x) => x.agent_id === 'agent-b');
      expect(a?.mcp_tool_call_count).toBe(3);
      expect(a?.mcp_error_count).toBe(1);
      expect(a?.last_mcp_tool_name).toBe('vibecode_build_start');
      expect(a?.last_mcp_tool_at).toBe('2026-06-12T10:02:00.000Z');
      expect(b?.mcp_tool_call_count).toBe(1);
      expect(b?.mcp_error_count).toBe(0);
      expect(b?.last_mcp_tool_name).toBe('vibecode_changes');
    });

    test('unattributed events stay unattributed in recent_tool_calls', () => {
      writeUsageLog(repo.repoRoot, [
        usageLine({ tool: 'vibecode_project_instructions' }),
      ]);
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.recent_tool_calls).toHaveLength(1);
      expect(overview.recent_tool_calls[0]?.tool_name).toBe('vibecode_project_instructions');
      expect(overview.recent_tool_calls[0]?.agent_id).toBeUndefined();
    });

    test('missing usage log degrades to empty recent_tool_calls with a warning', () => {
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.recent_tool_calls).toEqual([]);
      expect(overview.warnings.some((w) => w.code === 'USAGE_LOG_MISSING')).toBe(true);
    });

    test('malformed usage log lines are skipped with a warning, not an exception', () => {
      writeUsageLog(repo.repoRoot, [
        'this is not json {{{',
        usageLine({ tool: 'vibecode_changes', agentId: 'agent-a' }),
        '{"valid_json_but_not_an_event": true}',
      ]);
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.recent_tool_calls).toHaveLength(1);
      expect(overview.warnings.some((w) => w.code === 'USAGE_LOG_MALFORMED_LINES')).toBe(true);
    });

    test('recent_tool_calls is capped but totals stay accurate', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      const lines: string[] = [];
      for (let i = 0; i < ACTIVITY_OVERVIEW_MAX_RECENT_TOOL_CALLS + 10; i++) {
        lines.push(usageLine({
          tool: 'vibecode_changes',
          agentId: 'agent-a',
          timestamp: `2026-06-12T10:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
        }));
      }
      writeUsageLog(repo.repoRoot, lines);
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.recent_tool_calls.length).toBe(ACTIVITY_OVERVIEW_MAX_RECENT_TOOL_CALLS);
      expect(overview.totals.tool_calls_in_window).toBe(ACTIVITY_OVERVIEW_MAX_RECENT_TOOL_CALLS + 10);
      const agent = overview.agents.find((x) => x.agent_id === 'agent-a');
      expect(agent?.mcp_tool_call_count).toBe(ACTIVITY_OVERVIEW_MAX_RECENT_TOOL_CALLS + 10);
    });
  });

  describe('agents, claims, and safety classification', () => {
    beforeEach(() => {
      repo = makeGitRepo();
    });

    test('combines agent status, tool usage, and claims', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      write(repo.repoRoot, 'src/app.ts');
      git(['add', '.'], repo.repoRoot);
      git(['commit', '-q', '-m', 'base'], repo.repoRoot);
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths: ['src/app.ts'], intent: 'work' });
      writeUsageLog(repo.repoRoot, [usageLine({ tool: 'vibecode_build_start', agentId: 'agent-a' })]);

      const overview = getActivityObservabilityOverview(repo.repoRoot);
      const agent = overview.agents.find((x) => x.agent_id === 'agent-a');
      expect(agent?.status).toBe('active');
      expect(agent?.mode).toBe('build');
      expect(agent?.name).toBe('agent-a');
      expect(typeof agent?.last_activity_at).toBe('string');
      expect(agent?.mcp_tool_call_count).toBe(1);
      expect(agent?.claimed_path_count).toBe(1);
      const claim = overview.claims.find((c) => c.path === 'src/app.ts');
      expect(claim?.owner_agent_id).toBe('agent-a');
      expect(claim?.status).toBe('clean');
      expect(typeof claim?.age_seconds).toBe('number');
    });

    test('claimed dirty path shows on the owning agent and as a dirty claim', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths: ['src/app.ts'], intent: 'work' });
      write(repo.repoRoot, 'src/app.ts', 'changed\n');

      const overview = getActivityObservabilityOverview(repo.repoRoot);
      const agent = overview.agents.find((x) => x.agent_id === 'agent-a');
      expect(agent?.dirty_claimed_path_count).toBe(1);
      expect(agent?.ready_state).toBe('ready_to_commit');
      const claim = overview.claims.find((c) => c.path === 'src/app.ts');
      expect(claim?.status).toBe('dirty');
    });

    test('unclaimed dirty files become a workspace-level warning, never per-agent blame', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      write(repo.repoRoot, 'src/unclaimed_edit.ts');

      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.workspace_safety.unclaimed_dirty_count).toBe(1);
      expect(overview.workspace_safety.has_suspicious_unclaimed_dirty).toBe(true);
      expect(overview.workspace_safety.safety_level).toBe('warning');
      const warning = overview.workspace_safety.warnings.find((w) => w.code === 'UNCLAIMED_DIRTY_FILES');
      expect(warning).toBeDefined();
      expect(warning?.sample_paths).toContain('src/unclaimed_edit.ts');
      // No per-agent blame: the unclaimed path never appears inside any agent entry.
      for (const agent of overview.agents) {
        expect(JSON.stringify(agent)).not.toContain('src/unclaimed_edit.ts');
        expect(agent.dirty_claimed_path_count).toBe(0);
      }
    });

    test('staged unclaimed files mark the workspace blocked and block agents', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      write(repo.repoRoot, 'src/staged_unclaimed.ts');
      git(['add', 'src/staged_unclaimed.ts'], repo.repoRoot);

      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.workspace_safety.staged_unclaimed_count).toBe(1);
      expect(overview.workspace_safety.safety_level).toBe('blocked');
      const agent = overview.agents.find((x) => x.agent_id === 'agent-a');
      expect(agent?.ready_state).toBe('blocked');
      expect(agent?.blockers.length).toBeGreaterThan(0);
    });

    test('generated/ignored dirty files are counted separately, not as unclaimed', () => {
      write(repo.repoRoot, '.vibecode/runs/r1/run_manifest.json', '{}');
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.workspace_safety.unclaimed_dirty_count).toBe(0);
      expect(overview.workspace_safety.has_suspicious_unclaimed_dirty).toBe(false);
    });

    test('read-only agents report ready_state read_only', () => {
      registerAgent(
        repo.repoRoot,
        { agent_name: 'RO', agent_type: 'custom', metadata: { operating_mode: 'read_only', task: 't' } },
        { agentId: 'agent-ro' },
      );
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      const agent = overview.agents.find((x) => x.agent_id === 'agent-ro');
      expect(agent?.ready_state).toBe('read_only');
      expect(agent?.mode).toBe('read_only');
    });

    test('stale coordination is summarized as counts with safe housekeeping commands', () => {
      const past = '2026-01-01T00:00:00.000Z';
      registerAgent(
        repo.repoRoot,
        { agent_name: 'Old', agent_type: 'custom', metadata: { operating_mode: 'build', task: 't' } },
        { agentId: 'agent-old', now: past },
      );
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-old', paths: ['src/old.ts'], intent: 'w', now: past });
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.stale_coordination.has_stale_state).toBe(true);
      expect(overview.stale_coordination.stale_agent_count).toBeGreaterThan(0);
      expect(overview.stale_coordination.housekeeping_commands.length).toBeGreaterThan(0);
      const agent = overview.agents.find((x) => x.agent_id === 'agent-old');
      expect(agent?.status).toBe('stale');
    });

    test('git classification failure degrades to unknown claim status and a warning', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths: ['src/app.ts'], intent: 'w' });
      const failingRunner = () => ({ ok: false, stdout: '', stderr: 'git broke', exitCode: 1 });
      const overview = getActivityObservabilityOverview(repo.repoRoot, { gitRunner: failingRunner });
      expect(overview.warnings.some((w) => w.code === 'GIT_CLASSIFICATION_UNAVAILABLE')).toBe(true);
      expect(overview.workspace_safety.safety_level).toBe('warning');
      const claim = overview.claims.find((c) => c.path === 'src/app.ts');
      expect(claim?.status).toBe('unknown');
    });

    test('overview never writes coordination or log state', () => {
      const before = fs.existsSync(path.join(repo.repoRoot, '.vibecode'));
      getActivityObservabilityOverview(repo.repoRoot);
      expect(fs.existsSync(path.join(repo.repoRoot, '.vibecode'))).toBe(before);
    });
  });

  // Cockpit v2: the live UI showed oldest stale/terminated agents first while
  // the caps silently dropped the newest entries, and historical log rows
  // leaked pre-v1 tool names. These tests pin the corrected ordering,
  // normalization, and the data-quality block the cockpit needs.
  describe('cockpit ordering and per-status counts', () => {
    beforeEach(() => {
      repo = makePlainDir();
    });

    test('active agents sort before stale and terminated agents', () => {
      const past = '2026-01-01T00:00:00.000Z';
      registerAgent(
        repo.repoRoot,
        { agent_name: 'Old', agent_type: 'custom', metadata: { operating_mode: 'build', task: 't' } },
        { agentId: 'agent-stale', now: past },
      );
      registerBuildAgent(repo.repoRoot, 'agent-term');
      markAgentTerminated(repo.repoRoot, 'agent-term');
      registerBuildAgent(repo.repoRoot, 'agent-live');

      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.agents[0]?.agent_id).toBe('agent-live');
      expect(overview.agents.map((a) => a.status)).toEqual(['active', 'stale', 'terminated']);
      expect(overview.agent_status_counts).toEqual({ active: 1, stale: 1, terminated: 1, unknown: 0 });
    });

    test('agent cap keeps the most recently active agents, not the oldest', () => {
      const total = ACTIVITY_OVERVIEW_MAX_AGENTS + 5;
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      for (let i = 0; i < total; i++) {
        registerAgent(
          repo.repoRoot,
          { agent_name: `A${i}`, agent_type: 'custom', metadata: { operating_mode: 'build', task: 't' } },
          { agentId: `agent-${i}`, now: new Date(base + i * 60_000).toISOString() },
        );
      }
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.agents).toHaveLength(ACTIVITY_OVERVIEW_MAX_AGENTS);
      expect(overview.totals.agents).toBe(total);
      const shownIds = overview.agents.map((a) => a.agent_id);
      expect(shownIds).toContain(`agent-${total - 1}`);
      expect(shownIds).not.toContain('agent-0');
      expect(overview.warnings.some((w) => w.code === 'AGENTS_TRUNCATED')).toBe(true);
    });

    test('recent MCP activity lifts an agent within its status group', () => {
      const past = '2026-01-01T00:00:00.000Z';
      const laterPast = '2026-01-01T01:00:00.000Z';
      registerAgent(
        repo.repoRoot,
        { agent_name: 'QuietButNewer', agent_type: 'custom', metadata: { operating_mode: 'build', task: 't' } },
        { agentId: 'agent-quiet', now: laterPast },
      );
      registerAgent(
        repo.repoRoot,
        { agent_name: 'OldButCalling', agent_type: 'custom', metadata: { operating_mode: 'build', task: 't' } },
        { agentId: 'agent-caller', now: past },
      );
      // agent-caller's MCP call is more recent than agent-quiet's heartbeat.
      writeUsageLog(repo.repoRoot, [
        usageLine({ tool: 'vibecode_changes', agentId: 'agent-caller', timestamp: '2026-01-02T00:00:00.000Z' }),
      ]);
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.agents[0]?.agent_id).toBe('agent-caller');
    });
  });

  describe('cockpit claim ordering and active intent', () => {
    beforeEach(() => {
      repo = makeGitRepo();
    });

    test('active claims sort before stale claims, newest first', () => {
      const past = '2026-01-01T00:00:00.000Z';
      registerAgent(
        repo.repoRoot,
        { agent_name: 'Old', agent_type: 'custom', metadata: { operating_mode: 'build', task: 't' } },
        { agentId: 'agent-old', now: past },
      );
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-old', paths: ['src/old.ts'], intent: 'old work', now: past });
      registerBuildAgent(repo.repoRoot, 'agent-new');
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-new', paths: ['src/new.ts'], intent: 'new work' });

      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.claims[0]?.path).toBe('src/new.ts');
      expect(overview.claims[0]?.status).not.toBe('stale');
      expect(overview.claims[1]?.path).toBe('src/old.ts');
      expect(overview.claims[1]?.status).toBe('stale');
    });

    test('claim cap keeps the newest claims and accurate totals', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      const older = Array.from({ length: ACTIVITY_OVERVIEW_MAX_CLAIMS / 2 + 1 }, (_, i) => `src/older/f${i}.ts`);
      const newer = Array.from({ length: ACTIVITY_OVERVIEW_MAX_CLAIMS / 2 + 1 }, (_, i) => `src/newer/f${i}.ts`);
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths: older, intent: 'older batch', now: '2026-06-12T09:00:00.000Z' });
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths: newer, intent: 'newer batch', now: '2026-06-12T10:00:00.000Z' });

      const overview = getActivityObservabilityOverview(repo.repoRoot, { now: '2026-06-12T10:01:00.000Z' });
      expect(overview.claims).toHaveLength(ACTIVITY_OVERVIEW_MAX_CLAIMS);
      expect(overview.totals.claims).toBe(older.length + newer.length);
      const shownPaths = new Set(overview.claims.map((c) => c.path));
      for (const p of newer) expect(shownPaths.has(p)).toBe(true);
      expect(overview.warnings.some((w) => w.code === 'CLAIMS_TRUNCATED')).toBe(true);
    });

    test('agent entries expose their newest active intent for the cockpit card', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths: ['src/app.ts'], intent: 'refactor parser pipeline' });
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      const agent = overview.agents.find((a) => a.agent_id === 'agent-a');
      expect(typeof agent?.active_intent_id).toBe('string');
      expect(agent?.active_intent_text).toContain('refactor parser pipeline');
    });
  });

  describe('legacy tool name normalization and data quality', () => {
    beforeEach(() => {
      repo = makePlainDir();
    });

    test('legacy pre-v1 tool names normalize to v1 names everywhere in the DTO', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      writeUsageLog(repo.repoRoot, [
        usageLine({ tool: 'vibecode_workspace_info', agentId: 'agent-a', timestamp: '2026-06-12T10:00:00.000Z' }),
        usageLine({ tool: 'vibecode_claims_add_bulk', agentId: 'agent-a', timestamp: '2026-06-12T10:01:00.000Z' }),
      ]);
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.recent_tool_calls.map((c) => c.tool_name)).toEqual([
        'vibecode_build_start',
        'vibecode_workspace_snapshot',
      ]);
      const agent = overview.agents.find((a) => a.agent_id === 'agent-a');
      expect(agent?.last_mcp_tool_name).toBe('vibecode_build_start');
      const serialized = JSON.stringify(overview);
      expect(serialized).not.toContain('vibecode_workspace_info');
      expect(serialized).not.toContain('vibecode_claims_add_bulk');
      expect(overview.data_quality.legacy_tool_name_call_count).toBe(2);
    });

    test('data quality reports a missing usage log and unavailable git', () => {
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.data_quality.usage_log).toBe('missing');
      expect(overview.data_quality.git_classification).toBe('unavailable');
      expect(overview.data_quality.coordination_state).toBe('ok');
      expect(overview.data_quality.attributed_call_count).toBe(0);
      expect(overview.data_quality.unattributed_call_count).toBe(0);
    });

    test('data quality counts attributed vs unattributed calls and malformed lines', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      writeUsageLog(repo.repoRoot, [
        usageLine({ tool: 'vibecode_changes', agentId: 'agent-a' }),
        usageLine({ tool: 'vibecode_changes', agentId: 'agent-a' }),
        usageLine({ tool: 'vibecode_project_instructions' }),
        'not json at all {{{',
      ]);
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.data_quality.usage_log).toBe('ok');
      expect(overview.data_quality.attributed_call_count).toBe(2);
      expect(overview.data_quality.unattributed_call_count).toBe(1);
      expect(overview.data_quality.malformed_line_count).toBe(1);
    });

    test('data quality reports a truncated usage log window', () => {
      const lines: string[] = [];
      // Enough rows to exceed the 512 KiB read window.
      for (let i = 0; i < 2200; i++) {
        lines.push(usageLine({ tool: 'vibecode_changes', agentId: 'agent-a' }));
      }
      writeUsageLog(repo.repoRoot, lines);
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.data_quality.usage_log).toBe('truncated');
    });

    test('data quality flags stale coordination state', () => {
      const past = '2026-01-01T00:00:00.000Z';
      registerAgent(
        repo.repoRoot,
        { agent_name: 'Old', agent_type: 'custom', metadata: { operating_mode: 'build', task: 't' } },
        { agentId: 'agent-old', now: past },
      );
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.data_quality.stale_state_present).toBe(true);
    });
  });
});
