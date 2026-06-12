import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';
import {
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
});
