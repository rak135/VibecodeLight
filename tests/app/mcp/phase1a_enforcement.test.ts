import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildSessionBootstrapTool } from '../../../src/app/mcp/tools/session_bootstrap.js';
import { buildGitChangesTool } from '../../../src/app/mcp/tools/git_changes.js';
import { buildClaimAddTool } from '../../../src/app/mcp/tools/claims.js';
import { buildFinalizeCheckTool } from '../../../src/app/mcp/tools/finalize_check.js';
import { buildAgentRegisterTool } from '../../../src/app/mcp/tools/agents.js';
import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { HARD_MAX_BOOTSTRAP_ITEMS, HARD_MAX_GIT_CHANGES_FILES } from '../../../src/app/mcp/schemas.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';
import type { SessionBootstrapResult } from '../../../src/core/agent_session/bootstrap.js';

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

const tool = () => buildSessionBootstrapTool({ codegraphStatus: async () => ({ available: false, initialized: false, version: null }) });

describe('Phase 1A MCP input validation / hard caps', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-phase1a-mcp-');
  });
  afterEach(() => repo.cleanup());

  // =========================================================================
  // H. input validation / caps — MCP session_bootstrap
  // =========================================================================
  describe('MCP session_bootstrap input validation', () => {
    test('rejects register: "true" (string) with INVALID_ARGUMENT', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { register: 'true' },
        requestId: null,
      });
      // register: "true" (string) is caught by explicit type validation.
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
      expect(result.structuredContent.error?.message).toContain('register');
    });

    test('rejects max_items: "bad" (string) with INVALID_ARGUMENT', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { max_items: 'bad' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
      expect(result.structuredContent.error?.message).toContain('max_items');
    });

    test('rejects max_items: 0 with INVALID_ARGUMENT', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { max_items: 0 },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    });

    test('rejects max_items: -5 with INVALID_ARGUMENT', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { max_items: -5 },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    });

    test(`rejects max_items above hard max (${HARD_MAX_BOOTSTRAP_ITEMS}) with INVALID_ARGUMENT`, async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { max_items: HARD_MAX_BOOTSTRAP_ITEMS + 1 },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
      expect(result.structuredContent.error?.message).toContain('exceeds maximum');
    });

    test('accepts max_items at hard max', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { max_items: HARD_MAX_BOOTSTRAP_ITEMS },
        requestId: null,
      });
      expect(result.isError).toBe(false);
    });

    test('rejects invalid operating_mode with INVALID_ARGUMENT', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { register: true, agent_mode: 'invalid_mode', task: 'x' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    });

    test('rejects empty task when register=true with INVALID_ARGUMENT', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { register: true, agent_mode: 'build', task: '' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    });

    test('rejects agent_mode as non-string', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { register: true, agent_mode: 42, task: 'x' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    });
  });

  // =========================================================================
  // H. input validation / caps — MCP git_changes
  // =========================================================================
  describe('MCP git_changes input validation', () => {
    test('rejects max_files: "nope" (string) with INVALID_ARGUMENT', async () => {
      const result = await buildGitChangesTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { max_files: 'nope' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    });

    test('rejects max_files: 0 with INVALID_ARGUMENT', async () => {
      const result = await buildGitChangesTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { max_files: 0 },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    });

    test('rejects max_files: -3 with INVALID_ARGUMENT', async () => {
      const result = await buildGitChangesTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { max_files: -3 },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    });

    test(`rejects max_files above hard max (${HARD_MAX_GIT_CHANGES_FILES}) with INVALID_ARGUMENT`, async () => {
      const result = await buildGitChangesTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { max_files: HARD_MAX_GIT_CHANGES_FILES + 1 },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
      expect(result.structuredContent.error?.message).toContain('exceeds maximum');
    });

    test('accepts max_files at hard max', async () => {
      const result = await buildGitChangesTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { max_files: HARD_MAX_GIT_CHANGES_FILES },
        requestId: null,
      });
      expect(result.isError).toBe(false);
    });
  });

  // =========================================================================
  // I. mode-aware recommendations
  // =========================================================================
  describe('I. mode-aware recommendations', () => {
    test('read_only bootstrap does not recommend claim_add as normal next tool', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { register: true, agent_mode: 'read_only', task: 'inspect code' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as SessionBootstrapResult;
      expect(data.current_agent?.operating_mode).toBe('read_only');
      expect(data.recommended_next_tools).not.toContain('vibecode_build_start');
      expect(data.recommended_next_tools).toContain('vibecode_changes');
      expect(data.recommended_next_tools).toContain('vibecode_project_instructions');
    });

    test('build bootstrap recommends claim workflow', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { register: true, agent_mode: 'build', task: 'fix auth' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as SessionBootstrapResult;
      expect(data.current_agent?.operating_mode).toBe('build');
      expect(data.recommended_next_tools).toContain('vibecode_build_start');
      expect(data.recommended_next_tools).toContain('vibecode_build_finish');
      expect(data.recommended_next_tools).toContain('vibecode_changes');
    });

    test('unregistered bootstrap shows claim guidance for onboarding', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: {},
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as SessionBootstrapResult;
      expect(data.current_agent).toBeNull();
      // Unregistered sees both for guidance.
      expect(data.recommended_next_tools).toContain('vibecode_build_start');
      expect(data.recommended_next_tools).toContain('vibecode_changes');
    });
  });

  // =========================================================================
  // E. legacy agent bootstrap via MCP
  // =========================================================================
  describe('E. legacy agent bootstrap via MCP', () => {
    test('bootstrap with active legacy agent_id (no mode/task) returns blocker', async () => {
      // Register via the old path (no mode/task in metadata).
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Legacy',
        agent_type: 'custom',
      });
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { agent_id: agent.agent_id },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('SESSION_BOOTSTRAP_FAILED');
    });

    test('bootstrap with stale legacy agent_id returns blocker', async () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Legacy',
        agent_type: 'custom',
      }, { now: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { agent_id: agent.agent_id },
        requestId: null,
      });
      expect(result.isError).toBe(true);
    });

    test('terminated agent_id remains terminated', async () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'A',
        agent_type: 'claude',
        metadata: { operating_mode: 'build', task: 'x' },
      });
      markAgentTerminated(repo.repoRoot, agent.agent_id);
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { agent_id: agent.agent_id },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('AGENT_TERMINATED');
    });
  });

  // =========================================================================
  // read_only claim via MCP
  // =========================================================================
  describe('read_only claim via MCP', () => {
    test('claim_add for read_only agent returns CLAIM_DENIED with read_only reason', async () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Reader',
        agent_type: 'claude',
        metadata: { operating_mode: 'read_only', task: 'inspect' },
      });
      const result = await buildClaimAddTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { agent_id: agent.agent_id, path: 'src/app.ts', mode: 'exclusive' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      // The claim is denied; the READ_ONLY_AGENT reason is surfaced in the details.
      expect(result.structuredContent.error?.code).toBe('CLAIM_DENIED');
      const details = result.structuredContent.error?.details as { reason?: string } | undefined;
      expect(details?.reason).toBe('READ_ONLY_AGENT');
    });
  });

  // =========================================================================
  // read_only finalize via MCP
  // =========================================================================
  describe('read_only finalize via MCP', () => {
    test('finalize for read_only agent returns blocked status', async () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Reader',
        agent_type: 'claude',
        metadata: { operating_mode: 'read_only', task: 'inspect' },
      });
      const result = await buildFinalizeCheckTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { agent_id: agent.agent_id },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { status: string; blocks: Array<{ code: string }> };
      expect(data.status).toBe('blocked');
      expect(data.blocks[0].code).toBe('READ_ONLY_AGENT');
    });
  });

  // =========================================================================
  // Fix 3: MCP agent_register requires mode/task
  // =========================================================================
  describe('MCP agent_register requires mode/task', () => {
    test('register without agent_mode fails with INVALID_ARGUMENT', async () => {
      const result = await buildAgentRegisterTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { name: 'Bot', type: 'codex', task: 'do work' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
      expect(result.structuredContent.error?.message).toContain('agent_mode');
    });

    test('register without task fails with INVALID_ARGUMENT', async () => {
      const result = await buildAgentRegisterTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { name: 'Bot', type: 'codex', agent_mode: 'build' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
      expect(result.structuredContent.error?.message).toContain('task');
    });

    test('register with valid agent_mode and task succeeds', async () => {
      const result = await buildAgentRegisterTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { name: 'Bot', type: 'codex', agent_mode: 'build', task: 'implement feature' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const agent = result.structuredContent.data as { agent: { metadata?: { operating_mode?: string; task?: string } } };
      expect(agent.agent.metadata?.operating_mode).toBe('build');
      expect(agent.agent.metadata?.task).toBe('implement feature');
    });

    test('register with invalid agent_mode fails with INVALID_ARGUMENT', async () => {
      const result = await buildAgentRegisterTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { name: 'Bot', type: 'codex', agent_mode: 'observer', task: 'x' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    });

    test('register with empty/whitespace task fails with INVALID_ARGUMENT', async () => {
      const result = await buildAgentRegisterTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { name: 'Bot', type: 'codex', agent_mode: 'build', task: '   ' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
      expect(result.structuredContent.error?.message).toContain('task');
    });

    test('bootstrap register flow still works', async () => {
      const result = await tool().handler({
        context: ctx(repo.repoRoot),
        arguments: { register: true, agent_mode: 'build', task: 'fix auth' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as SessionBootstrapResult;
      expect(data.current_agent?.operating_mode).toBe('build');
      expect(data.current_agent?.task).toBe('fix auth');
    });
  });
});
