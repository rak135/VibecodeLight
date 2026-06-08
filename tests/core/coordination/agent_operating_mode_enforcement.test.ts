import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent, markAgentTerminated, listAgents, heartbeatAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim, listFileClaims } from '../../../src/core/coordination/claims.js';
import { getFinalizeCheck } from '../../../src/core/coordination/finalize_check.js';
import { runCommitGuard } from '../../../src/core/coordination/commit_guard.js';
import {
  getAgentOperatingMode,
  getAgentTask,
  validateAgentMode,
  validateExistingAgentMode,
  validateModeImmutability,
  requireBuildAgent,
  isAgentOperatingMode,
} from '../../../src/core/coordination/agent_operating_mode.js';
import { CoordinationError } from '../../../src/core/coordination/errors.js';

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

describe('Phase 1A agent operating mode enforcement', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-mode-enforcement-');
  });
  afterEach(() => repo.cleanup());

  // =========================================================================
  // A. read_only claim restriction
  // =========================================================================
  describe('A. read_only claim restriction', () => {
    test('read_only agent is denied a claim with structured error', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Reader',
        agent_type: 'claude',
        metadata: { operating_mode: 'read_only', task: 'inspect code' },
      });
      const result = addFileClaim(repo.repoRoot, {
        agent_id: agent.agent_id,
        path: 'src/app.ts',
        mode: 'exclusive',
      });
      expect(result.denied).toBe(true);
      expect(result.claim).toBeNull();
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('CLAIM_DENIED');
      expect(result.error!.message).toContain('read_only');
      // No claim persisted.
      expect(listFileClaims(repo.repoRoot)).toHaveLength(0);
    });

    test('read_only agent is denied a shared claim', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Reader',
        agent_type: 'claude',
        metadata: { operating_mode: 'read_only', task: 'inspect code' },
      });
      const result = addFileClaim(repo.repoRoot, {
        agent_id: agent.agent_id,
        path: 'src/app.ts',
        mode: 'shared',
      });
      expect(result.denied).toBe(true);
      expect(result.error!.code).toBe('CLAIM_DENIED');
    });
  });

  // =========================================================================
  // B. read_only finalize restriction
  // =========================================================================
  describe('B. read_only finalize restriction', () => {
    test('read_only agent is blocked from finalize', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Reader',
        agent_type: 'claude',
        metadata: { operating_mode: 'read_only', task: 'inspect code' },
      });
      write(repo.repoRoot, 'src/app.ts');

      const result = getFinalizeCheck({
        repoRoot: repo.repoRoot,
        agent_id: agent.agent_id,
      });
      expect(result.ok).toBe(true);
      expect(result.status).toBe('blocked');
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].code).toBe('READ_ONLY_AGENT');
    });
  });

  // =========================================================================
  // C. read_only commit guard restriction
  // =========================================================================
  describe('C. read_only commit guard restriction', () => {
    test('read_only agent is blocked by commit guard before any git work', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Reader',
        agent_type: 'claude',
        metadata: { operating_mode: 'read_only', task: 'inspect code' },
      });
      write(repo.repoRoot, 'src/app.ts');

      const result = runCommitGuard({
        repoRoot: repo.repoRoot,
        agent_id: agent.agent_id,
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('blocked');
      expect(result.blocks.some((b: { code: string }) => b.code === 'READ_ONLY_AGENT')).toBe(true);
      expect(result.committed_files).toHaveLength(0);
      expect(result.staged_files).toHaveLength(0);
    });
  });

  // =========================================================================
  // D. build still works
  // =========================================================================
  describe('D. build agent still works', () => {
    test('build agent can claim files', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Builder',
        agent_type: 'codex',
        metadata: { operating_mode: 'build', task: 'fix auth' },
      });
      const result = addFileClaim(repo.repoRoot, {
        agent_id: agent.agent_id,
        path: 'src/app.ts',
        mode: 'exclusive',
      });
      expect(result.denied).toBe(false);
      expect(result.claim).toBeDefined();
      expect(result.claim!.path).toBe('src/app.ts');
    });

    test('build agent with no claims at bootstrap is not a blocker', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Builder',
        agent_type: 'codex',
        metadata: { operating_mode: 'build', task: 'fix auth' },
      });
      const result = getFinalizeCheck({
        repoRoot: repo.repoRoot,
        agent_id: agent.agent_id,
      });
      // With no changed files and no claims, finalize is ok/warning (NO_ACTIVE_CLAIMS warning
      // only when there are non-generated changes).
      expect(result.ok).toBe(true);
    });

    test('build agent can use finalize when claims are valid', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Builder',
        agent_type: 'codex',
        metadata: { operating_mode: 'build', task: 'fix auth' },
      });
      addFileClaim(repo.repoRoot, {
        agent_id: agent.agent_id,
        path: 'src/app.ts',
        mode: 'exclusive',
      });
      write(repo.repoRoot, 'src/app.ts');

      const result = getFinalizeCheck({
        repoRoot: repo.repoRoot,
        agent_id: agent.agent_id,
      });
      expect(result.ok).toBe(true);
      expect(result.status).not.toBe('blocked');
      expect(result.summary.allowed_count).toBe(1);
    });
  });

  // =========================================================================
  // E. legacy/no-mode agent bootstrap
  // =========================================================================
  describe('E. legacy/no-mode agent bootstrap', () => {
    test('agent without operating_mode has null mode in metadata', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Legacy',
        agent_type: 'custom',
      });
      expect(getAgentOperatingMode(agent)).toBeNull();
      expect(getAgentTask(agent)).toBeNull();
    });

    test('legacy agent is rejected by validateExistingAgentMode', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Legacy',
        agent_type: 'custom',
      });
      const result = validateExistingAgentMode(agent);
      expect(result).not.toBeNull();
      expect(result!.code).toBe('INVALID_AGENT_SESSION');
      expect(result!.message).toContain('operating_mode');
      expect(result!.message).toContain('task');
    });

    test('legacy agent is blocked from claiming', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Legacy',
        agent_type: 'custom',
      });
      expect(() => requireBuildAgent(agent)).toThrow(CoordinationError);
      try {
        requireBuildAgent(agent);
      } catch (err) {
        expect((err as CoordinationError).code).toBe('INVALID_AGENT_MODE');
      }
    });

    test('legacy agent is blocked from finalize', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Legacy',
        agent_type: 'custom',
      });
      const result = getFinalizeCheck({
        repoRoot: repo.repoRoot,
        agent_id: agent.agent_id,
      });
      expect(result.ok).toBe(true);
      expect(result.status).toBe('blocked');
      expect(result.blocks[0].code).toBe('INVALID_AGENT_SESSION');
    });

    test('legacy agent is blocked by commit guard', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'Legacy',
        agent_type: 'custom',
      });
      const result = runCommitGuard({
        repoRoot: repo.repoRoot,
        agent_id: agent.agent_id,
      });
      expect(result.ok).toBe(false);
      expect(result.blocks.some((b: { code: string }) => b.code === 'INVALID_AGENT_SESSION')).toBe(true);
    });
  });

  // =========================================================================
  // F. missing task/intent
  // =========================================================================
  describe('F. missing task/intent', () => {
    test('agent without task but with valid mode is invalid', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'NoTask',
        agent_type: 'codex',
        metadata: { operating_mode: 'build' },
      });
      expect(getAgentOperatingMode(agent)).toBe('build');
      expect(getAgentTask(agent)).toBeNull();
      const validation = validateAgentMode(agent);
      expect(validation.valid).toBe(false);
    });

    test('agent with empty task is invalid', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'EmptyTask',
        agent_type: 'codex',
        metadata: { operating_mode: 'build', task: '   ' },
      });
      expect(getAgentTask(agent)).toBeNull();
    });

    test('agent without mode but with task is invalid', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'NoMode',
        agent_type: 'codex',
        metadata: { task: 'fix auth' },
      });
      expect(getAgentOperatingMode(agent)).toBeNull();
      expect(getAgentTask(agent)).toBe('fix auth');
      const validation = validateAgentMode(agent);
      expect(validation.valid).toBe(false);
    });
  });

  // =========================================================================
  // G. mode immutability
  // =========================================================================
  describe('G. mode immutability', () => {
    test('validateModeImmutability allows same mode', () => {
      expect(validateModeImmutability('read_only', 'read_only')).toBeNull();
      expect(validateModeImmutability('build', 'build')).toBeNull();
    });

    test('validateModeImmutability allows undefined requested mode', () => {
      expect(validateModeImmutability('build', undefined)).toBeNull();
      expect(validateModeImmutability(null, undefined)).toBeNull();
    });

    test('validateModeImmutability rejects mode change', () => {
      const result = validateModeImmutability('read_only', 'build');
      expect(result).not.toBeNull();
      expect(result).toContain('immutable');
      expect(result).toContain('read_only');
      expect(result).toContain('build');
    });

    test('validateModeImmutability rejects invalid mode', () => {
      const result = validateModeImmutability(null, 'nope');
      expect(result).not.toBeNull();
      expect(result).toContain('invalid');
    });
  });

  // =========================================================================
  // H. shared helper correctness
  // =========================================================================
  describe('H. shared helper correctness', () => {
    test('isAgentOperatingMode accepts valid modes', () => {
      expect(isAgentOperatingMode('read_only')).toBe(true);
      expect(isAgentOperatingMode('build')).toBe(true);
    });

    test('isAgentOperatingMode rejects invalid values', () => {
      expect(isAgentOperatingMode('nope')).toBe(false);
      expect(isAgentOperatingMode(null)).toBe(false);
      expect(isAgentOperatingMode(undefined)).toBe(false);
      expect(isAgentOperatingMode(42)).toBe(false);
      expect(isAgentOperatingMode('')).toBe(false);
    });

    test('getAgentOperatingMode extracts from metadata', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'A',
        agent_type: 'codex',
        metadata: { operating_mode: 'build', task: 'x' },
      });
      expect(getAgentOperatingMode(agent)).toBe('build');
    });

    test('getAgentOperatingMode returns null for missing metadata', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'A',
        agent_type: 'codex',
      });
      expect(getAgentOperatingMode(agent)).toBeNull();
    });

    test('getAgentTask extracts from metadata', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'A',
        agent_type: 'codex',
        metadata: { operating_mode: 'build', task: 'fix auth' },
      });
      expect(getAgentTask(agent)).toBe('fix auth');
    });

    test('getAgentTask returns null for empty/whitespace task', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'A',
        agent_type: 'codex',
        metadata: { operating_mode: 'build', task: '' },
      });
      expect(getAgentTask(agent)).toBeNull();
    });

    test('validateAgentMode returns valid for complete metadata', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'A',
        agent_type: 'codex',
        metadata: { operating_mode: 'build', task: 'fix auth' },
      });
      const result = validateAgentMode(agent);
      expect(result.valid).toBe(true);
      expect(result.operating_mode).toBe('build');
      expect(result.task).toBe('fix auth');
    });

    test('validateAgentMode returns invalid for missing mode', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'A',
        agent_type: 'codex',
        metadata: { task: 'fix auth' },
      });
      expect(validateAgentMode(agent).valid).toBe(false);
    });

    test('validateAgentMode returns invalid for missing task', () => {
      const agent = registerAgent(repo.repoRoot, {
        agent_name: 'A',
        agent_type: 'codex',
        metadata: { operating_mode: 'build' },
      });
      expect(validateAgentMode(agent).valid).toBe(false);
    });
  });
});
