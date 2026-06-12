import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildHandoffGuideTool } from '../../../src/app/mcp/tools/handoff_guide.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';
import type { NextAgentHandoffGuide } from '../../../src/core/agent_session/handoff_guide.js';
import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';

/**
 * Phase 4B — `vibecode_handoff_guide` MCP tool contract.
 *
 * What breaks if removed:
 *   - the tool could accept unknown/unbounded input or a missing from_agent_id;
 *   - missing previous/next agents could become tool errors (or worse,
 *     mutations) instead of safe onboarding states inside the guide;
 *   - the guide could silently start transferring ownership (registration,
 *     heartbeat, claim, or release side effects);
 *   - the canonical envelope or the registry registration could drift from the
 *     CLI parity surface.
 */

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

function registerBuildAgent(repoRoot: string, name = 'A'): string {
  return registerAgent(repoRoot, {
    agent_name: name,
    agent_type: 'claude',
    metadata: { operating_mode: 'build', task: `phase 4b test ${name}` },
  }).agent_id;
}

describe('VibecodeMCP handoff_guide tool', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-handoff-guide-mcp-');
  });
  afterEach(() => repo.cleanup());

  test('is registered in the canonical tool name list', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).not.toContain('vibecode_handoff_guide');
    expect(buildHandoffGuideTool().name).toBe('vibecode_handoff_guide');
  });

  test('input schema is additionalProperties=false, from_agent_id required', () => {
    const schema = buildHandoffGuideTool().inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'for_agent_id',
      'from_agent_id',
      'max_items',
    ]);
    expect(schema.required).toEqual(['from_agent_id']);
  });

  test('rejects an unknown field with INVALID_ARGUMENT', async () => {
    const result = await buildHandoffGuideTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { from_agent_id: 'a', repo: '/etc/passwd' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('rejects a missing/empty from_agent_id with INVALID_ARGUMENT', async () => {
    for (const args of [{}, { from_agent_id: '' }, { from_agent_id: '   ' }]) {
      const result = await buildHandoffGuideTool().handler({
        context: ctx(repo.repoRoot),
        arguments: args,
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    }
  });

  test('rejects invalid and over-cap max_items with INVALID_ARGUMENT', async () => {
    for (const maxItems of [0, -1, 1.5, 'ten', 51]) {
      const result = await buildHandoffGuideTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { from_agent_id: 'agent-x', max_items: maxItems },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    }
  });

  test('ready previous agent without for_agent_id: next_agent_not_registered in an ok envelope', async () => {
    const fromId = registerBuildAgent(repo.repoRoot);
    const result = await buildHandoffGuideTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { from_agent_id: fromId },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.tool).toBe('vibecode_handoff_guide');
    const data = result.structuredContent.data as NextAgentHandoffGuide;
    expect(data.from_agent_id).toBe(fromId);
    expect(data.for_agent_id).toBeNull();
    expect(data.handoff_source.handoff_state).toBe('ready_to_handoff');
    expect(data.onboarding.onboarding_state).toBe('next_agent_not_registered');
    expect(data.onboarding.ownership_transferred).toBe(false);
    expect(data.do_not_do.length).toBeGreaterThan(0);
    expect(result.content[0].text).toContain('Onboarding:');
  });

  test('--for-agent equivalent: active build next agent gets ready_for_new_agent with its own commands', async () => {
    const fromId = registerBuildAgent(repo.repoRoot, 'A');
    const forId = registerBuildAgent(repo.repoRoot, 'B');
    const result = await buildHandoffGuideTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { from_agent_id: fromId, for_agent_id: forId },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as NextAgentHandoffGuide;
    expect(data.onboarding.onboarding_state).toBe('ready_for_new_agent');
    expect(data.onboarding.can_continue_now).toBe(true);
    expect(data.next_agent_cli_commands.join(' ')).toContain(forId);
  });

  test('same-agent guide routes to session recovery, not cross-agent continuation', async () => {
    const fromId = registerBuildAgent(repo.repoRoot, 'A');
    const result = await buildHandoffGuideTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { from_agent_id: fromId, for_agent_id: fromId },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as NextAgentHandoffGuide;
    expect(data.onboarding.same_agent_resume).toBe(true);
    expect(data.onboarding.onboarding_state).toBe('same_agent_resume');
    expect(data.onboarding.can_continue_now).toBe(false);
    expect(data.onboarding.ownership_transferred).toBe(false);
    expect(data.onboarding.must_claim_explicitly).toBe(true);
    const next = data.next_agent_cli_commands.join(' ');
    expect(next).toContain('session_recovery');
    expect(next).not.toContain('claims plan');
    expect(next).not.toContain('build_pre_edit');
    const text = result.content[0].text;
    expect(text).toMatch(/same-agent resume/i);
    expect(text).not.toMatch(/ready_for_new_agent|ready for new agent/i);
  });

  test('previous agent with active claims: previous_agent_ready_after_release, no mutation of state or tree', async () => {
    const fromId = registerBuildAgent(repo.repoRoot);
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: fromId, intent: 'work', paths: ['src/mine.ts'] });

    const statePath = path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json');
    const stateBefore = fs.readFileSync(statePath, 'utf8');
    const treeBefore = git(['status', '--porcelain'], repo.repoRoot).stdout;

    const result = await buildHandoffGuideTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { from_agent_id: fromId },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as NextAgentHandoffGuide;
    expect(data.onboarding.onboarding_state).toBe('previous_agent_ready_after_release');
    expect(data.blocked_paths).toContain('src/mine.ts');
    // Strictly read-only: coordination state and working tree untouched.
    expect(fs.readFileSync(statePath, 'utf8')).toBe(stateBefore);
    expect(git(['status', '--porcelain'], repo.repoRoot).stdout).toBe(treeBefore);
  });

  test('claim-only previous agent uses claim-release guidance, not intent-release guidance', async () => {
    const fromId = registerBuildAgent(repo.repoRoot);
    addFileClaim(repo.repoRoot, { agent_id: fromId, path: 'src/claim-only.ts', mode: 'exclusive' });

    const result = await buildHandoffGuideTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { from_agent_id: fromId },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as NextAgentHandoffGuide;
    expect(data.onboarding.onboarding_state).toBe('previous_agent_ready_after_release');
    expect(data.onboarding.can_continue_now).toBe(false);
    expect(data.required_before_continue).toContain('previous_agent_release_claims');
    expect(data.required_before_continue).not.toContain('previous_agent_release_intents');
    const prev = data.previous_agent_cli_commands.join(' ');
    expect(prev).toContain('claims release --claim <claim_id> --json');
    expect(prev).not.toContain('intent-release');
    expect(result.content[0].text).not.toContain('intent-release');
  });

  test('dirty claimed file: previous_agent_not_ready guidance', async () => {
    const fromId = registerBuildAgent(repo.repoRoot);
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: fromId, intent: 'work', paths: ['src/mine.ts'] });
    write(repo.repoRoot, 'src/mine.ts');

    const result = await buildHandoffGuideTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { from_agent_id: fromId },
      requestId: null,
    });
    const data = result.structuredContent.data as NextAgentHandoffGuide;
    expect(data.onboarding.onboarding_state).toBe('previous_agent_not_ready');
    expect(data.required_before_continue).toContain('previous_agent_commit_or_revert');
  });

  test('missing previous agent returns a safe onboarding state, not an error or mutation', async () => {
    const result = await buildHandoffGuideTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { from_agent_id: 'agent-never-existed' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as NextAgentHandoffGuide;
    expect(data.handoff_source.handoff_state).toBe('terminated_or_missing_agent');
    expect(data.warnings.some((w) => w.code === 'PREVIOUS_AGENT_UNAVAILABLE')).toBe(true);
  });

  test('missing for_agent_id returns next_agent_not_registered with a not-found warning', async () => {
    const fromId = registerBuildAgent(repo.repoRoot);
    const result = await buildHandoffGuideTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { from_agent_id: fromId, for_agent_id: 'agent-ghost' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as NextAgentHandoffGuide;
    expect(data.onboarding.onboarding_state).toBe('next_agent_not_registered');
    expect(data.warnings.some((w) => w.code === 'NEXT_AGENT_NOT_FOUND')).toBe(true);
  });

  test('terminated previous agent with leftover claims: housekeeping required, never a transfer', async () => {
    const fromId = registerBuildAgent(repo.repoRoot);
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: fromId, intent: 'work', paths: ['src/mine.ts'] });
    markAgentTerminated(repo.repoRoot, fromId);

    const result = await buildHandoffGuideTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { from_agent_id: fromId },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as NextAgentHandoffGuide;
    // A terminated agent's claims compute to `stale`, so the live system routes
    // this through stale-coordination housekeeping (dry-run-first reap) — never
    // a transfer of the leftover claims.
    expect(data.onboarding.onboarding_state).toBe('stale_coordination_requires_housekeeping');
    expect(data.onboarding.ownership_transferred).toBe(false);
    expect(data.next_agent_cli_commands.join(' ')).toContain('claims reap --dry-run');
    expect(data.warnings.some((w) => w.code === 'PREVIOUS_AGENT_UNAVAILABLE')).toBe(true);
  });

  test('guide never registers or heartbeats: coordination state stays untouched', async () => {
    const fromId = registerBuildAgent(repo.repoRoot);
    const statePath = path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json');
    const before = fs.readFileSync(statePath, 'utf8');
    await buildHandoffGuideTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { from_agent_id: fromId, for_agent_id: 'agent-ghost' },
      requestId: null,
    });
    expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
  });
});
