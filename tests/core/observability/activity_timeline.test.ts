import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';
import { releaseClaimIntent } from '../../../src/core/coordination/intent_lifecycle.js';
import {
  ACTIVITY_TIMELINE_MAX_EVENTS,
  ACTIVITY_TIMELINE_MAX_PATHS,
  getActivityObservabilityOverview,
} from '../../../src/core/observability/activity_overview.js';
import { MCP_TOOL_USAGE_LOG_RELATIVE_PATH } from '../../../src/core/observability/mcp_usage_log.js';

/**
 * Activity timeline (Cockpit v2).
 *
 * What breaks if removed:
 *   - the desktop cockpit could lose its "what happened recently, in order"
 *     view: attributed/unattributed MCP tool calls, agent starts, and claim
 *     add/release events reconstructed from real timestamps;
 *   - the timeline cap could silently lose the true event total;
 *   - raw file contents or pre-v1 tool names could leak into the GUI.
 */

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeGitRepo(): { repoRoot: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-timeline-'));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  git(['init', '-q'], repoRoot);
  git(['config', 'user.email', 't@example.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  git(['config', 'commit.gpgsign', 'false'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repoRoot);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repoRoot);
  return { repoRoot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function makePlainDir(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-timeline-plain-'));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function writeUsageLog(repoRoot: string, lines: string[]): void {
  const logPath = path.join(repoRoot, MCP_TOOL_USAGE_LOG_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
}

function usageLine(opts: {
  tool: string;
  agentId?: string;
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
    input_summary: { has_agent_id: Boolean(opts.agentId), has_intent_id: false },
    ok: opts.ok !== false,
    duration_ms: 5,
    warnings: [],
    error: opts.ok === false ? { code: opts.errorCode ?? 'X_FAILED', message: 'm', retryable: false } : null,
    output_bytes: 10,
    truncated: false,
  });
}

function registerBuildAgent(repoRoot: string, agentId: string, now?: string): void {
  registerAgent(
    repoRoot,
    { agent_name: agentId, agent_type: 'custom', metadata: { operating_mode: 'build', task: 'timeline test' } },
    { agentId, ...(now ? { now } : {}) },
  );
}

describe('activity timeline', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  afterEach(() => repo.cleanup());

  describe('tool call events', () => {
    beforeEach(() => {
      repo = makePlainDir();
    });

    test('includes attributed and unattributed MCP tool calls, newest first', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      writeUsageLog(repo.repoRoot, [
        usageLine({ tool: 'vibecode_workspace_snapshot', agentId: 'agent-a', timestamp: '2026-06-12T10:00:00.000Z' }),
        usageLine({ tool: 'vibecode_project_instructions', timestamp: '2026-06-12T10:01:00.000Z' }),
        usageLine({ tool: 'vibecode_build_start', agentId: 'agent-a', ok: false, errorCode: 'NO_CLAIM_PATHS', timestamp: '2026-06-12T10:02:00.000Z' }),
      ]);
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      const calls = overview.timeline.filter((e) => e.kind === 'mcp_tool_call');
      expect(calls).toHaveLength(3);
      expect(calls[0]?.tool_name).toBe('vibecode_build_start');
      expect(calls[0]?.ok).toBe(false);
      expect(calls[0]?.severity).toBe('error');
      expect(calls[0]?.agent_id).toBe('agent-a');
      expect(calls[1]?.tool_name).toBe('vibecode_project_instructions');
      expect(calls[1]?.agent_id).toBeUndefined();
      expect(calls[2]?.tool_name).toBe('vibecode_workspace_snapshot');
      // Strictly newest-first across the whole timeline.
      const times = overview.timeline.map((e) => Date.parse(e.timestamp));
      for (let i = 1; i < times.length; i++) expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]!);
      for (const event of overview.timeline) {
        expect(typeof event.summary).toBe('string');
        expect(event.summary.length).toBeGreaterThan(0);
      }
    });

    test('caps timeline events but preserves the true total', () => {
      const lines: string[] = [];
      const extra = 20;
      for (let i = 0; i < ACTIVITY_TIMELINE_MAX_EVENTS + extra; i++) {
        const minute = String(Math.floor(i / 60)).padStart(2, '0');
        const second = String(i % 60).padStart(2, '0');
        lines.push(usageLine({ tool: 'vibecode_changes', timestamp: `2026-06-12T10:${minute}:${second}.000Z` }));
      }
      writeUsageLog(repo.repoRoot, lines);
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      expect(overview.timeline).toHaveLength(ACTIVITY_TIMELINE_MAX_EVENTS);
      expect(overview.totals.timeline_events).toBeGreaterThanOrEqual(ACTIVITY_TIMELINE_MAX_EVENTS + extra);
      expect(overview.warnings.some((w) => w.code === 'TIMELINE_TRUNCATED')).toBe(true);
    });
  });

  describe('coordination events', () => {
    beforeEach(() => {
      repo = makeGitRepo();
    });

    test('includes agent_started, claim_added, and claim_released events from coordination state', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a', '2026-06-12T09:00:00.000Z');
      addBulkClaims({
        repoRoot: repo.repoRoot,
        agent_id: 'agent-a',
        paths: ['src/app.ts', 'src/lib.ts'],
        intent: 'implement feature',
        now: '2026-06-12T09:01:00.000Z',
      });
      const intents = JSON.parse(
        fs.readFileSync(path.join(repo.repoRoot, '.vibecode/coordination/state.json'), 'utf8'),
      ).intents as { intent_id: string }[];
      releaseClaimIntent({
        repoRoot: repo.repoRoot,
        agent_id: 'agent-a',
        intent_id: intents[0]!.intent_id,
        now: '2026-06-12T09:30:00.000Z',
      });

      const overview = getActivityObservabilityOverview(repo.repoRoot, { now: '2026-06-12T09:31:00.000Z' });
      const started = overview.timeline.find((e) => e.kind === 'agent_started');
      expect(started?.agent_id).toBe('agent-a');
      expect(started?.timestamp).toBe('2026-06-12T09:00:00.000Z');

      const added = overview.timeline.find((e) => e.kind === 'claim_added');
      expect(added?.agent_id).toBe('agent-a');
      expect(added?.intent_id).toBe(intents[0]!.intent_id);
      expect(added?.path_count).toBe(2);
      expect(added?.paths).toContain('src/app.ts');

      const released = overview.timeline.find((e) => e.kind === 'claim_released');
      expect(released?.agent_id).toBe('agent-a');
      expect(released?.timestamp).toBe('2026-06-12T09:30:00.000Z');
      expect(released?.intent_id).toBe(intents[0]!.intent_id);
    });

    test('limits paths per event to a small sample while keeping the true count', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      const paths = Array.from({ length: ACTIVITY_TIMELINE_MAX_PATHS + 3 }, (_, i) => `src/many/f${i}.ts`);
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths, intent: 'wide work' });
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      const added = overview.timeline.find((e) => e.kind === 'claim_added');
      expect(added?.path_count).toBe(paths.length);
      expect(added?.paths?.length).toBeLessThanOrEqual(ACTIVITY_TIMELINE_MAX_PATHS);
    });

    test('never includes raw file contents or legacy tool names', () => {
      registerBuildAgent(repo.repoRoot, 'agent-a');
      fs.mkdirSync(path.join(repo.repoRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo.repoRoot, 'src/secret.ts'), 'VERY_SECRET_FILE_CONTENT_MARKER\n', 'utf8');
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths: ['src/secret.ts'], intent: 'work' });
      writeUsageLog(repo.repoRoot, [
        usageLine({ tool: 'vibecode_workspace_info', agentId: 'agent-a' }),
      ]);
      const overview = getActivityObservabilityOverview(repo.repoRoot);
      const serialized = JSON.stringify(overview.timeline);
      expect(serialized).not.toContain('VERY_SECRET_FILE_CONTENT_MARKER');
      expect(serialized).not.toContain('vibecode_workspace_info');
      expect(serialized).toContain('vibecode_workspace_snapshot');
    });
  });
});
