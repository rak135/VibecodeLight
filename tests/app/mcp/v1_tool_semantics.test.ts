import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildV1ArtifactReadTool,
  buildV1BuildFinishTool,
  buildV1BuildScopeTool,
  buildV1BuildStartTool,
  buildV1ChangesTool,
  buildV1CodeGraphCallersTool,
  buildV1CodeGraphExploreTool,
  buildV1CodeGraphImpactTool,
  buildV1CodeGraphSearchTool,
  buildV1HandoffTool,
  buildV1ProjectInstructionsTool,
  buildV1SessionStartTool,
  buildV1WorkspaceSnapshotTool,
} from '../../../src/app/mcp/tools/v1_contract.js';
import {
  MCP_TOOL_CONTRACTS,
  getMcpToolCatalog,
} from '../../../src/app/mcp/tool_catalog.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';
import { loadCoordinationState, writeCoordinationState } from '../../../src/core/coordination/state.js';

/**
 * VibecodeMCP Tool Contract v1 — wrapper semantics.
 *
 * What breaks if removed:
 *   - v1 wrappers could silently drop the old safety semantics they wrap
 *     (atomic claims, foreign-intent rejection, dirty-release blocks,
 *     finalize blockers, separate run/scan artifact allowlists);
 *   - v1 public outputs could leak old internal MCP tool names again;
 *   - the build flow could regain mutation paths (handoff/finish committing
 *     or transferring ownership).
 */

const OLD_NAME_PATTERN = /vibecode_(session_bootstrap|workspace_info|workspace_status|mcp_guidance|current_run|run_get|runs_list|artifacts_list|scan_summary|scan_artifact_read|git_changes|finalize_check|claim_add|claim_release|claim_status|claims_list|claims_plan|claims_add_bulk|claim_intents_list|claim_intent_release|handoff_prepare|handoff_guide|agent_register|agent_heartbeat|agent_status|agents_list|coordination_status|conflicts_list|conflict_detail|conflict_resolve|claims_reap|evidence_list|evidence_scan|tool_profile|team_status|codegraph_context|codegraph_files|codegraph_status|codegraph_usage|codegraph_callees)\b/;

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function write(repoRoot: string, rel: string, content = 'x\n'): void {
  const p = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function registerBuild(repoRoot: string, agentId: string): string {
  return registerAgent(
    repoRoot,
    { agent_name: agentId, agent_type: 'custom', metadata: { operating_mode: 'build', task: 'v1 semantics test' } },
    { agentId },
  ).agent_id;
}

function registerReadOnly(repoRoot: string, agentId: string): string {
  return registerAgent(
    repoRoot,
    { agent_name: agentId, agent_type: 'custom', metadata: { operating_mode: 'read_only', task: 'v1 semantics test' } },
    { agentId },
  ).agent_id;
}

function makeRunFixture(repoRoot: string): void {
  const runDir = path.join(repoRoot, '.vibecode', 'runs', 'r1');
  fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.vibecode', 'current'), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({ run_id: 'r1', created_at: '2026-06-12T00:00:00Z', task: 't', status: 'done', repo_root: repoRoot }, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(runDir, 'output', 'final_prompt.md'), '# final prompt body\n0123456789\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'file_inventory.json'), JSON.stringify({ files: ['a.ts'] }), 'utf8');
}

const FAKE_CODEGRAPH_STATUS = async () => ({ ok: true, available: false, initialized: false, warnings: [] });

/** Backdate an agent's heartbeat so its computed status (and its claims) go stale. */
function makeAgentStale(repoRoot: string, agentId: string): void {
  const state = loadCoordinationState(repoRoot);
  writeCoordinationState(repoRoot, {
    ...state,
    agents: state.agents.map((agent) =>
      agent.agent_id === agentId ? { ...agent, last_heartbeat_at: '2020-01-01T00:00:00.000Z' } : agent,
    ),
  });
}

describe('v1 session_start', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-v1-session-')));
  afterEach(() => repo.cleanup());

  test('registers a new build agent and recommends only v1 tools', async () => {
    const tool = buildV1SessionStartTool({ codegraphStatus: async () => ({ available: false, initialized: false, version: null }) });
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { mode: 'build', task: 'implement feature' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      ok: boolean;
      agent_id: string | null;
      mode: string;
      status: string;
      recommended_next_tools: string[];
    };
    expect(data.ok).toBe(true);
    expect(data.agent_id).toBeTruthy();
    expect(data.mode).toBe('build');
    expect(data.status).toBe('active');
    expect(data.recommended_next_tools).toContain('vibecode_workspace_snapshot');
    expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
    // The agent is actually persisted in coordination state.
    const state = loadCoordinationState(repo.repoRoot);
    expect(state.agents.some((a) => a.agent_id === data.agent_id)).toBe(true);
  });

  test('rejects an invalid mode with a structured error', async () => {
    const tool = buildV1SessionStartTool();
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { mode: 'yolo', task: 't' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });
});

describe('v1 workspace_snapshot', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-v1-snapshot-')));
  afterEach(() => repo.cleanup());

  test('reports real claim-aware safety counts, not hardcoded zeros', async () => {
    const agent = registerBuild(repo.repoRoot, 'agent-snap');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: agent, paths: ['src/mine.ts'], intent: 'snapshot test' });
    write(repo.repoRoot, 'src/mine.ts');
    write(repo.repoRoot, 'src/loose.ts');

    const tool = buildV1WorkspaceSnapshotTool({ codegraphStatus: FAKE_CODEGRAPH_STATUS });
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      workspace_safety: { unclaimed_dirty_count: number; staged_unclaimed_count: number };
      claims_summary: { owned: Array<{ path: string }>; foreign: unknown[] };
      recommended_next_tools: string[];
    };
    expect(data.workspace_safety.unclaimed_dirty_count).toBe(1);
    expect(data.claims_summary.owned.map((c) => c.path)).toContain('src/mine.ts');
    expect(data.recommended_next_tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
  });

  test('counts staged unclaimed files as blockers-in-waiting', async () => {
    write(repo.repoRoot, 'src/staged.ts');
    git(['add', 'src/staged.ts'], repo.repoRoot);

    const tool = buildV1WorkspaceSnapshotTool({ codegraphStatus: FAKE_CODEGRAPH_STATUS });
    const result = await tool.handler({ context: ctx(repo.repoRoot), arguments: {}, requestId: null });
    const data = result.structuredContent.data as { workspace_safety: { staged_unclaimed_count: number } };
    expect(data.workspace_safety.staged_unclaimed_count).toBe(1);
  });
});

describe('v1 project_instructions', () => {
  test('returns allowlisted repo instructions', async () => {
    const repo = makeRepo('vibecode-v1-instructions-');
    try {
      write(repo.repoRoot, 'AGENTS.md', '# Agent rules\nDo the right thing.\n');
      const result = await buildV1ProjectInstructionsTool().handler({
        context: ctx(repo.repoRoot),
        arguments: {},
        requestId: null,
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.tool).toBe('vibecode_project_instructions');
      expect(JSON.stringify(result.structuredContent.data)).toContain('AGENTS.md');
    } finally {
      repo.cleanup();
    }
  });
});

describe('v1 artifact_read', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-v1-artifact-');
    makeRunFixture(repo.repoRoot);
  });
  afterEach(() => repo.cleanup());

  const tool = buildV1ArtifactReadTool();

  test('artifact_type=run reads a run artifact through the run allowlist', async () => {
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { run_ref: 'r1', artifact_type: 'run', artifact_key: 'final_prompt' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { artifact_type: string; content: string; truncated: boolean };
    expect(data.artifact_type).toBe('run');
    expect(data.content).toContain('# final prompt body');
    expect(data.truncated).toBe(false);
  });

  test('artifact_type=scan reads a scan artifact through the scan allowlist', async () => {
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { run_ref: 'r1', artifact_type: 'scan', artifact_key: 'file_inventory' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { artifact_type: string; content: string };
    expect(data.artifact_type).toBe('scan');
    expect(data.content).toContain('a.ts');
  });

  test('allowlists stay separate: scan keys are not readable as run artifacts and vice versa', async () => {
    const scanViaRun = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { run_ref: 'r1', artifact_type: 'run', artifact_key: 'file_inventory' },
      requestId: null,
    });
    expect(scanViaRun.isError).toBe(true);
    expect(scanViaRun.structuredContent.error?.code).toBe('ARTIFACT_NOT_ALLOWED');

    const runViaScan = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { run_ref: 'r1', artifact_type: 'scan', artifact_key: 'final_prompt' },
      requestId: null,
    });
    expect(runViaScan.isError).toBe(true);
    expect(runViaScan.structuredContent.error?.code).toBe('ARTIFACT_NOT_ALLOWED');
  });

  test('path traversal and raw .vibecode paths are rejected for both types', async () => {
    for (const artifactType of ['run', 'scan'] as const) {
      for (const key of ['../../config.yaml', '..\\run_manifest.json', '.vibecode/coordination/state.json', 'scan/../output/final_prompt.md']) {
        const result = await tool.handler({
          context: ctx(repo.repoRoot),
          arguments: { run_ref: 'r1', artifact_type: artifactType, artifact_key: key },
          requestId: null,
        });
        expect(result.isError, `${artifactType}:${key} must fail`).toBe(true);
        expect(result.structuredContent.error?.code).toBe('ARTIFACT_NOT_ALLOWED');
      }
    }
  });

  test('continuation works through cursor/next_cursor', async () => {
    const first = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { run_ref: 'r1', artifact_type: 'run', artifact_key: 'final_prompt', max_bytes: 10 },
      requestId: null,
    });
    expect(first.isError).toBe(false);
    const firstData = first.structuredContent.data as { truncated: boolean; next_cursor?: string; content: string };
    expect(firstData.truncated).toBe(true);
    expect(firstData.next_cursor).toBeTruthy();

    const second = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { run_ref: 'r1', artifact_type: 'run', artifact_key: 'final_prompt', cursor: firstData.next_cursor },
      requestId: null,
    });
    expect(second.isError).toBe(false);
    const secondData = second.structuredContent.data as { content: string };
    const full = fs.readFileSync(path.join(repo.repoRoot, '.vibecode', 'runs', 'r1', 'output', 'final_prompt.md'), 'utf8');
    expect(firstData.content + secondData.content).toBe(full);
  });

  test('an invalid cursor is a structured INVALID_ARGUMENT', async () => {
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { run_ref: 'r1', artifact_type: 'run', artifact_key: 'final_prompt', cursor: 'not-a-number' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });
});

describe('v1 changes', () => {
  test('returns claim-aware classification', async () => {
    const repo = makeRepo('vibecode-v1-changes-');
    try {
      const agent = registerBuild(repo.repoRoot, 'agent-chg');
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: agent, paths: ['src/mine.ts'], intent: 'changes test' });
      write(repo.repoRoot, 'src/mine.ts');
      write(repo.repoRoot, 'src/loose.ts');

      const result = await buildV1ChangesTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { agent_id: agent },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.tool).toBe('vibecode_changes');
      const data = result.structuredContent.data as {
        summary: { claimed_by_agent: number; unclaimed: number };
        files: Array<{ path: string; classification: string }>;
      };
      expect(data.summary.claimed_by_agent).toBe(1);
      expect(data.summary.unclaimed).toBe(1);
      expect(data.files.find((f) => f.path === 'src/mine.ts')?.classification).toBe('claimed_by_agent');
      expect(data.files.find((f) => f.path === 'src/loose.ts')?.classification).toBe('unclaimed');
      expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
    } finally {
      repo.cleanup();
    }
  });
});

describe('v1 build flow', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-v1-build-')));
  afterEach(() => repo.cleanup());

  test('build_start claims exact paths atomically under one intent', async () => {
    const agent = registerBuild(repo.repoRoot, 'agent-b1');
    const result = await buildV1BuildStartTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent, task: 'add alpha', paths: ['src/alpha.ts', 'tests/alpha.test.ts'] },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { ok: boolean; intent_id: string; claimed_paths: string[]; recommended_next_tools: string[] };
    expect(data.ok).toBe(true);
    expect(data.intent_id).toBeTruthy();
    expect(data.claimed_paths).toEqual(['src/alpha.ts', 'tests/alpha.test.ts']);
    expect(data.recommended_next_tools).toContain('vibecode_changes');
    expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
    expect(loadCoordinationState(repo.repoRoot).claims).toHaveLength(2);
  });

  test('build_start dry_run creates nothing', async () => {
    const agent = registerBuild(repo.repoRoot, 'agent-b2');
    const result = await buildV1BuildStartTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent, task: 'plan only', paths: ['src/alpha.ts'], dry_run: true },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    expect(loadCoordinationState(repo.repoRoot).claims).toHaveLength(0);
  });

  test('build_start rejects a read-only agent', async () => {
    const agent = registerReadOnly(repo.repoRoot, 'agent-ro');
    const result = await buildV1BuildStartTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent, task: 'nope', paths: ['src/alpha.ts'] },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('READ_ONLY_AGENT');
    expect(loadCoordinationState(repo.repoRoot).claims).toHaveLength(0);
  });

  test('build_start blocks directories, globs, .git and .vibecode paths without creating claims', async () => {
    const agent = registerBuild(repo.repoRoot, 'agent-b3');
    fs.mkdirSync(path.join(repo.repoRoot, 'src'), { recursive: true });
    for (const bad of ['src', 'src/*.ts', '.git/config', '.vibecode/coordination/state.json']) {
      const result = await buildV1BuildStartTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { agent_id: agent, task: 'bad paths', paths: [bad, 'src/good.ts'] },
        requestId: null,
      });
      // Atomic deny: either a structured error or a blocked result; never claims.
      if (!result.isError) {
        const data = result.structuredContent.data as { ok: boolean; claimed_paths: string[]; denied_paths: string[] };
        expect(data.ok, `path ${bad} must block`).toBe(false);
        expect(data.claimed_paths).toEqual([]);
        expect(data.denied_paths.length).toBeGreaterThan(0);
      }
      expect(loadCoordinationState(repo.repoRoot).claims, `path ${bad} must create no claims`).toHaveLength(0);
    }
  });

  test('build_start blocks a foreign active claim atomically', async () => {
    const a = registerBuild(repo.repoRoot, 'agent-a');
    const b = registerBuild(repo.repoRoot, 'agent-b');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: b, paths: ['src/beta.ts'], intent: 'b owns beta' });
    const before = loadCoordinationState(repo.repoRoot).claims.length;

    const result = await buildV1BuildStartTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: a, task: 'conflict', paths: ['src/alpha.ts', 'src/beta.ts'] },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { ok: boolean; claimed_paths: string[]; denied_paths: string[] };
    expect(data.ok).toBe(false);
    expect(data.claimed_paths).toEqual([]);
    expect(data.denied_paths).toContain('src/beta.ts');
    expect(loadCoordinationState(repo.repoRoot).claims.length).toBe(before);
  });

  test('build_scope rejects foreign intent mutation', async () => {
    const a = registerBuild(repo.repoRoot, 'agent-a');
    const b = registerBuild(repo.repoRoot, 'agent-b');
    const owned = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: a, paths: ['src/alpha.ts'], intent: 'a owns' });

    const addAttempt = await buildV1BuildScopeTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: b, intent_id: owned.intent_id, add_paths: ['src/sneaky.ts'] },
      requestId: null,
    });
    expect(addAttempt.isError).toBe(true);
    expect(addAttempt.structuredContent.error?.code).toBe('INTENT_FORBIDDEN');

    const releaseAttempt = await buildV1BuildScopeTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: b, intent_id: owned.intent_id, release_paths: ['src/alpha.ts'] },
      requestId: null,
    });
    expect(releaseAttempt.isError).toBe(true);
    expect(releaseAttempt.structuredContent.error?.code).toBe('INTENT_FORBIDDEN');
    // Nothing changed for the owner.
    const state = loadCoordinationState(repo.repoRoot);
    expect(state.claims.filter((c) => c.status === 'active')).toHaveLength(1);
  });

  test('build_scope adds exact paths and releases only clean owned paths', async () => {
    const agent = registerBuild(repo.repoRoot, 'agent-scope');
    const start = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: agent, paths: ['src/clean.ts', 'src/dirty.ts'], intent: 'scope test' });
    write(repo.repoRoot, 'src/dirty.ts');

    const result = await buildV1BuildScopeTool().handler({
      context: ctx(repo.repoRoot),
      arguments: {
        agent_id: agent,
        intent_id: start.intent_id ?? '',
        add_paths: ['src/extra.ts'],
        release_paths: ['src/clean.ts'],
      },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { added_claims: Array<{ path: string }>; released_claims: string[]; blocked: string[] };
    expect(data.added_claims.map((c) => c.path)).toEqual(['src/extra.ts']);
    expect(data.released_claims).toEqual(['src/clean.ts']);
    expect(data.blocked).toEqual([]);

    // A dirty release path is blocked and stays active.
    const dirtyRelease = await buildV1BuildScopeTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent, intent_id: start.intent_id ?? '', release_paths: ['src/dirty.ts'] },
      requestId: null,
    });
    expect(dirtyRelease.isError).toBe(false);
    const dirtyData = dirtyRelease.structuredContent.data as { released_claims: string[]; blocked: string[] };
    expect(dirtyData.released_claims).toEqual([]);
    expect(dirtyData.blocked).toEqual(['src/dirty.ts']);
    const state = loadCoordinationState(repo.repoRoot);
    expect(state.claims.find((c) => c.path === 'src/dirty.ts' && c.status === 'active')).toBeTruthy();
  });

  test('build_finish blocks unclaimed dirty files and does not commit', async () => {
    const agent = registerBuild(repo.repoRoot, 'agent-fin');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: agent, paths: ['src/mine.ts'], intent: 'finish test' });
    write(repo.repoRoot, 'src/mine.ts');
    write(repo.repoRoot, 'src/loose.ts');
    const headBefore = git(['rev-parse', 'HEAD'], repo.repoRoot).stdout.trim();

    const result = await buildV1BuildFinishTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      status: string;
      unclaimed_dirty_files: Array<{ path: string }>;
      commit_guard: { allowed: boolean };
    };
    expect(data.status).toBe('blocked');
    expect(data.unclaimed_dirty_files.map((f) => f.path)).toContain('src/loose.ts');
    expect(data.commit_guard.allowed).toBe(false);
    // build_finish never commits.
    expect(git(['rev-parse', 'HEAD'], repo.repoRoot).stdout.trim()).toBe(headBefore);
    expect(git(['status', '--porcelain', '-uall'], repo.repoRoot).stdout).toContain('src/loose.ts');
    expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
  });

  test('build_finish blocks staged unclaimed files', async () => {
    const agent = registerBuild(repo.repoRoot, 'agent-staged');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: agent, paths: ['src/mine.ts'], intent: 'staged test' });
    write(repo.repoRoot, 'src/mine.ts');
    write(repo.repoRoot, 'src/staged.ts');
    git(['add', 'src/staged.ts'], repo.repoRoot);

    const result = await buildV1BuildFinishTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { status: string; staged_blockers: Array<{ path: string }> };
    expect(data.status).toBe('blocked');
    expect(data.staged_blockers.map((f) => f.path)).toContain('src/staged.ts');
  });

  test('build_finish returns the exact CLI commit guard command when ready', async () => {
    const agent = registerBuild(repo.repoRoot, 'agent-ready');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: agent, paths: ['src/mine.ts'], intent: 'ready test' });
    write(repo.repoRoot, 'src/mine.ts');

    const result = await buildV1BuildFinishTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { status: string; commit_guard: { allowed: boolean; command: string | null; reason: string } };
    expect(data.status).toBe('ready_to_commit');
    expect(data.commit_guard.allowed).toBe(true);
    expect(data.commit_guard.command).toContain('vibecode commit guard');
    expect(data.commit_guard.command).toContain(`--agent ${agent}`);
    expect(data.commit_guard.command).toContain('--message');
    expect(data.commit_guard.reason).toBeTruthy();
    // The dogfood gap: the human-readable text must carry the exact command too,
    // so agents that only read text content never have to infer it.
    const text = result.content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
    expect(text).toContain('vibecode commit guard');
    expect(text).toContain(`--agent ${agent}`);

    // include_commit_guard_command=false suppresses the command but keeps readiness.
    const suppressed = await buildV1BuildFinishTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent, include_commit_guard_command: false },
      requestId: null,
    });
    const suppressedData = suppressed.structuredContent.data as { status: string; commit_guard: { allowed: boolean; command: string | null; reason: string } };
    expect(suppressedData.status).toBe('ready_to_commit');
    expect(suppressedData.commit_guard.allowed).toBe(true);
    expect(suppressedData.commit_guard.command).toBeNull();
    expect(suppressedData.commit_guard.reason).toBeTruthy();
  });

  test('blocked build_finish never returns a commit command, but explains why', async () => {
    const agent = registerBuild(repo.repoRoot, 'agent-blocked-guard');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: agent, paths: ['src/mine.ts'], intent: 'blocked guard test' });
    write(repo.repoRoot, 'src/mine.ts');
    write(repo.repoRoot, 'src/loose.ts');

    const result = await buildV1BuildFinishTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent, include_commit_guard_command: true },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { status: string; commit_guard: { allowed: boolean; command: string | null; reason: string } };
    expect(data.status).toBe('blocked');
    expect(data.commit_guard.allowed).toBe(false);
    expect(data.commit_guard.command).toBeNull();
    expect(data.commit_guard.reason).toBeTruthy();
  });

  test('build_finish releases clean claims only when release_clean_claims=true with intent_id', async () => {
    const agent = registerBuild(repo.repoRoot, 'agent-rel');
    const start = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: agent, paths: ['src/clean.ts'], intent: 'release test' });

    // Without the flag, nothing is released.
    await buildV1BuildFinishTool().handler({ context: ctx(repo.repoRoot), arguments: { agent_id: agent }, requestId: null });
    expect(loadCoordinationState(repo.repoRoot).claims.filter((c) => c.status === 'active')).toHaveLength(1);

    const result = await buildV1BuildFinishTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent, intent_id: start.intent_id ?? '', release_clean_claims: true },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    expect(loadCoordinationState(repo.repoRoot).claims.filter((c) => c.status === 'active')).toHaveLength(0);
  });

  test('build_finish with an unknown agent is blocked, never ready', async () => {
    const result = await buildV1BuildFinishTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'ghost' },
      requestId: null,
    });
    // The finalize core reports unknown agents as a conservative blocked
    // result (structured success), mirroring the old finalize_check semantics.
    if (result.isError) {
      expect(result.structuredContent.error?.code).toBeTruthy();
    } else {
      const data = result.structuredContent.data as { status: string; commit_guard: { allowed: boolean }; blockers: Array<{ code: string }> };
      expect(data.status).toBe('blocked');
      expect(data.commit_guard.allowed).toBe(false);
      expect(data.blockers.some((b) => b.code === 'AGENT_NOT_FOUND')).toBe(true);
    }
    expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
  });
});

describe('v1 handoff', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-v1-handoff-')));
  afterEach(() => repo.cleanup());

  test('mode=prepare preserves prepare semantics without mutating state', async () => {
    const agent = registerBuild(repo.repoRoot, 'agent-h1');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: agent, paths: ['src/mine.ts'], intent: 'handoff test' });
    const before = JSON.stringify(loadCoordinationState(repo.repoRoot).claims);

    const result = await buildV1HandoffTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { mode: 'prepare', agent_id: agent },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.tool).toBe('vibecode_handoff');
    const data = result.structuredContent.data as {
      ownership_transferred: boolean;
      must_claim_explicitly: boolean;
      handoff: Record<string, unknown>;
    };
    expect(data.ownership_transferred).toBe(false);
    expect(data.must_claim_explicitly).toBe(true);
    expect(data.handoff).toBeTruthy();
    expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
    // Read-only: no claim was released, transferred, or created.
    expect(JSON.stringify(loadCoordinationState(repo.repoRoot).claims)).toBe(before);
  });

  test('mode=guide preserves guide semantics for a next agent', async () => {
    const previous = registerBuild(repo.repoRoot, 'agent-prev');
    const result = await buildV1HandoffTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { mode: 'guide', from_agent_id: previous },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.tool).toBe('vibecode_handoff');
    const data = result.structuredContent.data as { ownership_transferred: boolean; must_claim_explicitly: boolean; handoff: Record<string, unknown> };
    expect(data.ownership_transferred).toBe(false);
    expect(data.must_claim_explicitly).toBe(true);
    expect(data.handoff).toBeTruthy();
    expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
  });

  test('an invalid mode is a structured error', async () => {
    const result = await buildV1HandoffTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { mode: 'transfer' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });
});

describe('v1 stale coordination summarization', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-v1-stale-')));
  afterEach(() => repo.cleanup());

  test('workspace_snapshot summarizes stale agents/claims as compact counts', async () => {
    const ghost = registerBuild(repo.repoRoot, 'agent-ghost');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: ghost, paths: ['src/abandoned.ts'], intent: 'left behind' });
    makeAgentStale(repo.repoRoot, ghost);
    const live = registerBuild(repo.repoRoot, 'agent-live');

    const result = await buildV1WorkspaceSnapshotTool({ codegraphStatus: FAKE_CODEGRAPH_STATUS }).handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: live },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      stale_coordination: {
        has_stale_state: boolean;
        stale_agents_count: number;
        stale_active_claims_count: number;
        recommended_cli_commands: string[];
      };
    };
    expect(data.stale_coordination.has_stale_state).toBe(true);
    expect(data.stale_coordination.stale_agents_count).toBeGreaterThanOrEqual(1);
    expect(data.stale_coordination.stale_active_claims_count).toBeGreaterThanOrEqual(1);
    // Recommendations stay CLI housekeeping commands; never old MCP tool names.
    for (const cmd of data.stale_coordination.recommended_cli_commands) {
      expect(cmd).toMatch(/^vibecode /);
    }
    expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
  });

  test('stale foreign coordination never turns ready_to_commit into blocked', async () => {
    const ghost = registerBuild(repo.repoRoot, 'agent-ghost');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: ghost, paths: ['src/abandoned.ts'], intent: 'left behind' });
    makeAgentStale(repo.repoRoot, ghost);

    const live = registerBuild(repo.repoRoot, 'agent-live');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: live, paths: ['src/mine.ts'], intent: 'live work' });
    write(repo.repoRoot, 'src/mine.ts');

    const result = await buildV1BuildFinishTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: live },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { status: string; commit_guard: { allowed: boolean; command: string | null } };
    expect(data.status).toBe('ready_to_commit');
    expect(data.commit_guard.allowed).toBe(true);
    expect(data.commit_guard.command).toContain('vibecode commit guard');
    expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
  });

  test('session_start carries a compact stale summary without per-item sample dumps', async () => {
    const ghost = registerBuild(repo.repoRoot, 'agent-ghost');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: ghost, paths: ['src/abandoned.ts'], intent: 'left behind' });
    makeAgentStale(repo.repoRoot, ghost);

    const result = await buildV1SessionStartTool({ codegraphStatus: async () => ({ available: false, initialized: false, version: null }) }).handler({
      context: ctx(repo.repoRoot),
      arguments: { mode: 'build', task: 'stale summary test' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      stale_coordination: { has_stale_state: boolean; stale_agents_count: number; samples?: unknown } | null;
    };
    expect(data.stale_coordination?.has_stale_state).toBe(true);
    expect(data.stale_coordination?.stale_agents_count).toBeGreaterThanOrEqual(1);
    expect(data.stale_coordination && 'samples' in data.stale_coordination).toBe(false);
    expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
  });
});

describe('v1 codegraph literal-search boundary and freshness', () => {
  test('codegraph_search metadata says indexed symbol/file search, points literals to grep/rg', () => {
    const tool = buildV1CodeGraphSearchTool();
    expect(tool.description).toMatch(/indexed/i);
    expect(tool.description).toMatch(/grep|rg/);
    expect(tool.description).toMatch(/not a literal|not.*literal text/i);
  });

  test('workspace_snapshot exposes codegraph availability and bounded index freshness', async () => {
    const repo = makeRepo('vibecode-v1-cgfresh-');
    try {
      const result = await buildV1WorkspaceSnapshotTool({ codegraphStatus: FAKE_CODEGRAPH_STATUS }).handler({
        context: ctx(repo.repoRoot),
        arguments: {},
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        codegraph: { available: boolean; initialized: boolean; index_freshness: string; literal_search: string } | null;
      };
      expect(data.codegraph).toBeTruthy();
      expect(data.codegraph?.available).toBe(false);
      expect(['not_indexed', 'unknown']).toContain(data.codegraph?.index_freshness);
      expect(data.codegraph?.index_freshness).toBe('not_indexed');
      expect(data.codegraph?.literal_search).toMatch(/grep|rg/);
    } finally {
      repo.cleanup();
    }
  });

  test('workspace_snapshot reports stale freshness when codegraph status shows pending changes', async () => {
    const repo = makeRepo('vibecode-v1-cgstale-');
    try {
      const fakeStatus = async () => ({ ok: true, available: true, initialized: true, warnings: [] });
      const fakeStatusRunner = () => ({
        ok: true,
        stdout: JSON.stringify({ initialized: true, pendingChanges: { added: 3, modified: 1, removed: 0 } }),
        stderr: '',
        exitCode: 0,
      });
      const result = await buildV1WorkspaceSnapshotTool({
        codegraphStatus: fakeStatus,
        codegraphStatusRunner: fakeStatusRunner,
      }).handler({
        context: ctx(repo.repoRoot),
        arguments: {},
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        codegraph: {
          available: boolean;
          initialized: boolean;
          index_freshness: string;
          pending_sync_count: number;
          freshness_source: string;
          recommended_action: string;
          literal_search: string;
        } | null;
      };
      expect(data.codegraph).toBeTruthy();
      expect(data.codegraph?.available).toBe(true);
      expect(data.codegraph?.initialized).toBe(true);
      expect(data.codegraph?.index_freshness).toBe('stale');
      expect(data.codegraph?.pending_sync_count).toBe(4);
      expect(data.codegraph?.freshness_source).toBe('codegraph_status');
      expect(data.codegraph?.recommended_action).toBe('run_codegraph_sync');
      expect(data.codegraph?.literal_search).toMatch(/grep|rg/);
    } finally {
      repo.cleanup();
    }
  });

  test('workspace_snapshot reports fresh freshness when codegraph status shows no pending changes', async () => {
    const repo = makeRepo('vibecode-v1-cgfreshok-');
    try {
      const fakeStatus = async () => ({ ok: true, available: true, initialized: true, warnings: [] });
      const fakeStatusRunner = () => ({
        ok: true,
        stdout: JSON.stringify({ initialized: true, pendingChanges: { added: 0, modified: 0, removed: 0 } }),
        stderr: '',
        exitCode: 0,
      });
      const result = await buildV1WorkspaceSnapshotTool({
        codegraphStatus: fakeStatus,
        codegraphStatusRunner: fakeStatusRunner,
      }).handler({
        context: ctx(repo.repoRoot),
        arguments: {},
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        codegraph: {
          available: boolean;
          initialized: boolean;
          index_freshness: string;
          pending_sync_count: number;
          freshness_source: string;
          recommended_action: string;
        } | null;
      };
      expect(data.codegraph).toBeTruthy();
      expect(data.codegraph?.index_freshness).toBe('fresh');
      expect(data.codegraph?.pending_sync_count).toBe(0);
      expect(data.codegraph?.freshness_source).toBe('codegraph_status');
      expect(data.codegraph?.recommended_action).toBe('none');
    } finally {
      repo.cleanup();
    }
  });

  test('workspace_snapshot reports unknown freshness when codegraph status command fails', async () => {
    const repo = makeRepo('vibecode-v1-cgfail-');
    try {
      const fakeStatus = async () => ({ ok: true, available: true, initialized: true, warnings: [] });
      const fakeStatusRunner = () => ({
        ok: false,
        stdout: '',
        stderr: 'status command failed',
        exitCode: 1,
      });
      const result = await buildV1WorkspaceSnapshotTool({
        codegraphStatus: fakeStatus,
        codegraphStatusRunner: fakeStatusRunner,
      }).handler({
        context: ctx(repo.repoRoot),
        arguments: {},
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        codegraph: {
          available: boolean;
          initialized: boolean;
          index_freshness: string;
          pending_sync_count: number | null;
          freshness_source: string;
          recommended_action: string;
        } | null;
      };
      expect(data.codegraph).toBeTruthy();
      expect(data.codegraph?.index_freshness).toBe('unknown');
      expect(data.codegraph?.pending_sync_count).toBeNull();
      expect(data.codegraph?.freshness_source).toBe('status_command_failed');
      expect(data.codegraph?.recommended_action).toBe('run_codegraph_status');
    } finally {
      repo.cleanup();
    }
  });

  test('workspace_snapshot reports not_indexed when codegraph is not initialized', async () => {
    const repo = makeRepo('vibecode-v1-cgnotinit-');
    try {
      const fakeStatus = async () => ({ ok: true, available: true, initialized: false, warnings: [] });
      const result = await buildV1WorkspaceSnapshotTool({
        codegraphStatus: fakeStatus,
      }).handler({
        context: ctx(repo.repoRoot),
        arguments: {},
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        codegraph: {
          available: boolean;
          initialized: boolean;
          index_freshness: string;
          pending_sync_count: number | null;
          freshness_source: string;
          recommended_action: string;
        } | null;
      };
      expect(data.codegraph).toBeTruthy();
      expect(data.codegraph?.index_freshness).toBe('not_indexed');
      expect(data.codegraph?.pending_sync_count).toBeNull();
      expect(data.codegraph?.freshness_source).toBe('no_index');
      expect(data.codegraph?.recommended_action).toBe('run_codegraph_init');
    } finally {
      repo.cleanup();
    }
  });

  test('workspace_snapshot does not trigger automatic sync', async () => {
    const repo = makeRepo('vibecode-v1-cgnosync-');
    try {
      const syncCalls: string[][] = [];
      const fakeStatus = async () => ({ ok: true, available: true, initialized: true, warnings: [] });
      const fakeStatusRunner = (_cmd: string, args: string[]) => {
        syncCalls.push(args);
        return {
          ok: true,
          stdout: JSON.stringify({ initialized: true, pendingChanges: { added: 5, modified: 0, removed: 0 } }),
          stderr: '',
          exitCode: 0,
        };
      };
      await buildV1WorkspaceSnapshotTool({
        codegraphStatus: fakeStatus,
        codegraphStatusRunner: fakeStatusRunner,
      }).handler({
        context: ctx(repo.repoRoot),
        arguments: {},
        requestId: null,
      });
      // Only 'status --json' should be called, never 'sync'
      expect(syncCalls.every((args) => !args.includes('sync'))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  test('codegraph_search catalog important_fields do NOT include codegraph_stale', () => {
    const contract = MCP_TOOL_CONTRACTS.vibecode_codegraph_search;
    expect(contract).toBeTruthy();
    const fields = contract.output_contract.important_fields ?? [];
    expect(fields).not.toContain('codegraph_stale');
    expect(fields).not.toContain('stale');
  });

  test('codegraph_search catalog important_fields reference actual data shape', () => {
    const contract = MCP_TOOL_CONTRACTS.vibecode_codegraph_search;
    const fields = contract.output_contract.important_fields ?? [];
    expect(fields).toContain('data.parsed_json');
    expect(fields).toContain('data.score_meta');
    expect(fields).toContain('warnings');
  });

  test('codegraph_search catalog safety notes explicitly say NOT a literal grep replacement', () => {
    const contract = MCP_TOOL_CONTRACTS.vibecode_codegraph_search;
    const safetyText = contract.safety_notes.join(' ');
    expect(safetyText).toMatch(/NOT.*literal|not.*literal/i);
    expect(safetyText).toMatch(/grep|rg/);
  });

  test('codegraph_search catalog safety notes say freshness is in workspace_snapshot', () => {
    const contract = MCP_TOOL_CONTRACTS.vibecode_codegraph_search;
    const safetyText = contract.safety_notes.join(' ');
    expect(safetyText).toMatch(/workspace_snapshot/i);
    expect(safetyText).toMatch(/freshness|index_freshness/i);
  });

  test('codegraph_search output contains no stale field in structured data', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-v1-cgnostale-'));
    fs.mkdirSync(path.join(repoRoot, '.codegraph'), { recursive: true });
    try {
      const FAKE_BINARY = { command: 'codegraph', source: 'PATH_FALLBACK' as const, configured: null };
      const tool = buildV1CodeGraphSearchTool({
        binary: FAKE_BINARY,
        runner: () => ({
          ok: true,
          stdout: JSON.stringify([{ score: 0.9, node: { name: 'foo', kind: 'function', filePath: 'src/foo.ts' } }]),
          stderr: '',
          exitCode: 0,
        }),
      });
      const result = await tool.handler({
        context: { repoRoot },
        arguments: { query: 'foo' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as Record<string, unknown>;
      expect(data).not.toHaveProperty('codegraph_stale');
      expect(data).not.toHaveProperty('stale');
      expect(data).toHaveProperty('parsed_json');
      expect(data).toHaveProperty('score_meta');
      const jsonStr = JSON.stringify(result.structuredContent);
      expect(jsonStr).not.toMatch(/codegraph_stale/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('codegraph_search output contains no old MCP tool names', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-v1-cgnames-'));
    fs.mkdirSync(path.join(repoRoot, '.codegraph'), { recursive: true });
    try {
      const FAKE_BINARY = { command: 'codegraph', source: 'PATH_FALLBACK' as const, configured: null };
      const tool = buildV1CodeGraphSearchTool({
        binary: FAKE_BINARY,
        runner: () => ({
          ok: true,
          stdout: JSON.stringify([{ score: 1.0, node: { name: 'bar' } }]),
          stderr: '',
          exitCode: 0,
        }),
      });
      const result = await tool.handler({
        context: { repoRoot },
        arguments: { query: 'bar' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('v1 codegraph wrappers', () => {
  function makeCodegraphRepo(): { repoRoot: string; cleanup: () => void } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-v1-cg-'));
    fs.mkdirSync(path.join(repoRoot, '.codegraph'), { recursive: true });
    return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
  }

  const FAKE_BINARY = { command: 'codegraph', source: 'PATH_FALLBACK' as const, configured: null };

  test('search maps query/max_results onto the proven CodeGraph search service', async () => {
    const { repoRoot, cleanup } = makeCodegraphRepo();
    try {
      const calls: string[][] = [];
      const tool = buildV1CodeGraphSearchTool({
        binary: FAKE_BINARY,
        runner: (_cmd, args) => {
          calls.push([...args]);
          return { ok: true, stdout: JSON.stringify([{ score: 0.9, node: { name: 'foo' } }]), stderr: '', exitCode: 0 };
        },
      });
      const result = await tool.handler({
        context: { repoRoot },
        arguments: { query: 'foo', max_results: 7 },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.tool).toBe('vibecode_codegraph_search');
      const args = calls[calls.length - 1];
      expect(args[0]).toBe('query');
      expect(args).toContain('--limit');
      expect(args).toContain('7');
    } finally {
      cleanup();
    }
  });

  test('explore maps topic+paths onto the old context behavior and is retagged', async () => {
    const { repoRoot, cleanup } = makeCodegraphRepo();
    try {
      const calls: string[][] = [];
      const tool = buildV1CodeGraphExploreTool({
        binary: FAKE_BINARY,
        runner: (_cmd, args) => {
          calls.push([...args]);
          return { ok: true, stdout: 'context output', stderr: '', exitCode: 0 };
        },
      });
      const result = await tool.handler({
        context: { repoRoot },
        arguments: { topic: 'claim lifecycle', paths: ['src/core/coordination'] },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.tool).toBe('vibecode_codegraph_explore');
      const flat = calls.flat().join(' ');
      expect(flat).toContain('claim lifecycle');
      expect(flat).toContain('src/core/coordination');
      expect(JSON.stringify(result.structuredContent)).not.toMatch(OLD_NAME_PATTERN);
    } finally {
      cleanup();
    }
  });

  test('callers and impact map symbol/targets onto the proven symbol services', async () => {
    const { repoRoot, cleanup } = makeCodegraphRepo();
    try {
      const callersCalls: string[][] = [];
      const callers = buildV1CodeGraphCallersTool({
        binary: FAKE_BINARY,
        runner: (_cmd, args) => {
          callersCalls.push([...args]);
          return { ok: true, stdout: '[]', stderr: '', exitCode: 0 };
        },
      });
      const callersResult = await callers.handler({
        context: { repoRoot },
        arguments: { symbol: 'finalizeCheck' },
        requestId: null,
      });
      expect(callersResult.isError).toBe(false);
      expect(callersResult.structuredContent.tool).toBe('vibecode_codegraph_callers');
      expect(callersCalls.flat().join(' ')).toContain('finalizeCheck');

      const impactCalls: string[][] = [];
      const impact = buildV1CodeGraphImpactTool({
        binary: FAKE_BINARY,
        runner: (_cmd, args) => {
          impactCalls.push([...args]);
          return { ok: true, stdout: '[]', stderr: '', exitCode: 0 };
        },
      });
      const impactResult = await impact.handler({
        context: { repoRoot },
        arguments: { targets: [{ symbol: 'finalizeCheck', path: 'src/core/coordination/finalize_check.ts' }] },
        requestId: null,
      });
      expect(impactResult.isError).toBe(false);
      expect(impactResult.structuredContent.tool).toBe('vibecode_codegraph_impact');
      expect(impactCalls.flat().join(' ')).toContain('finalizeCheck');

      const badImpact = await impact.handler({ context: { repoRoot }, arguments: { targets: [] }, requestId: null });
      expect(badImpact.isError).toBe(true);
      expect(badImpact.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });
});
