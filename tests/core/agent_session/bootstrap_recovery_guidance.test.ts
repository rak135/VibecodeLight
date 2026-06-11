import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import { getSessionBootstrap } from '../../../src/core/agent_session/bootstrap.js';
import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';

/**
 * Phase 3C — recovery/resume guidance carried by session bootstrap (integration).
 *
 * What breaks if removed:
 *   - bootstrap could stop carrying the recovery section a resuming agent
 *     relies on to choose its first safe action;
 *   - the resume classification could disagree with the REAL working tree and
 *     coordination state (claims, intents, staged files) that bootstrap loads;
 *   - terminated/missing agent resumes could silently regain edit guidance.
 */
function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  git(['config', 'core.autocrlf', 'false'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repo);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repo);
  return repo;
}

function write(repo: string, rel: string, content = 'x\n'): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

const STUB_CODEGRAPH = async () => ({ available: false, initialized: false, version: null });
const baseOpts = { codegraphStatus: STUB_CODEGRAPH } as const;

function registerBuild(repo: string, agentId: string): void {
  registerAgent(
    repo,
    { agent_name: agentId, agent_type: 'claude', metadata: { operating_mode: 'build', task: 'phase 3c' } },
    { agentId },
  );
}

describe('session bootstrap — recovery guidance (Phase 3C)', () => {
  test('unregistered orientation: not_registered with register-only guidance', async () => {
    const repo = makeRepo('vibecode-rec-unreg-');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    const r = result.runtime_awareness.recovery;
    expect(r.resume_state).toBe('not_registered');
    expect(r.requires_new_agent).toBe(true);
    expect(r.recommended_cli_commands.some((c) => c.includes('--register'))).toBe(true);
  });

  test('active build agent, clean tree, no claims: ready_to_claim', async () => {
    const repo = makeRepo('vibecode-rec-claim-');
    registerBuild(repo, 'agent-me');
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const r = result.runtime_awareness.recovery;
    expect(r.resume_state).toBe('ready_to_claim');
    expect(r.has_active_claims).toBe(false);
    expect(r.recommended_cli_commands.some((c) => c.includes('--profile build_pre_edit'))).toBe(true);
  });

  test('clean active claim without dirty files: ready_to_release (intent) — never another agent\'s', async () => {
    const repo = makeRepo('vibecode-rec-release-');
    registerBuild(repo, 'agent-me');
    addBulkClaims({ repoRoot: repo, agent_id: 'agent-me', intent: 'done work', paths: ['src/done.ts'] });
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const r = result.runtime_awareness.recovery;
    expect(r.resume_state).toBe('ready_to_release');
    expect(r.has_active_claims).toBe(true);
    const release = r.recommended_cli_commands.filter((c) => c.includes('intent-release'));
    expect(release.length).toBeGreaterThan(0);
    for (const c of release) {
      expect(c).toContain('--agent agent-me');
      expect(c).toContain('--dry-run');
    }
  });

  test('clean own claim WITHOUT an intent: ready_to_continue', async () => {
    const repo = makeRepo('vibecode-rec-cont-');
    registerBuild(repo, 'agent-me');
    addFileClaim(repo, { agent_id: 'agent-me', path: 'src/mine.ts', mode: 'exclusive' });
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const r = result.runtime_awareness.recovery;
    expect(r.resume_state).toBe('ready_to_continue');
    expect(r.has_active_claims).toBe(true);
    expect(r.has_active_intents).toBe(false);
  });

  test('dirty claimed file: ready_to_commit with the exact guard dry-run command', async () => {
    const repo = makeRepo('vibecode-rec-commit-');
    registerBuild(repo, 'agent-me');
    addFileClaim(repo, { agent_id: 'agent-me', path: 'src/mine.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const r = result.runtime_awareness.recovery;
    expect(r.resume_state).toBe('ready_to_commit');
    expect(r.has_dirty_claimed_files).toBe(true);
    expect(
      r.recommended_cli_commands.some((c) => c === 'vibecode commit guard --agent agent-me --dry-run --json'),
    ).toBe(true);
  });

  test('dirty claimed + unstaged unclaimed: isolated_commit_possible, skipped files never called safe', async () => {
    const repo = makeRepo('vibecode-rec-isolated-');
    registerBuild(repo, 'agent-me');
    addFileClaim(repo, { agent_id: 'agent-me', path: 'src/mine.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    write(repo, 'src/unrelated-wip.ts');
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const r = result.runtime_awareness.recovery;
    expect(r.resume_state).toBe('isolated_commit_possible');
    expect(r.confidence).toBe('medium');
    expect(r.has_unclaimed_dirty_files).toBe(true);
    expect(r.warnings.some((w) => w.code === 'ISOLATED_COMMIT_LIKELY')).toBe(true);
  });

  test('staged unclaimed file: blocked_by_staged_unclaimed with a block notice', async () => {
    const repo = makeRepo('vibecode-rec-staged-');
    registerBuild(repo, 'agent-me');
    addFileClaim(repo, { agent_id: 'agent-me', path: 'src/mine.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    write(repo, 'src/unrelated-staged.ts');
    git(['add', '--', 'src/unrelated-staged.ts'], repo);
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const r = result.runtime_awareness.recovery;
    expect(r.resume_state).toBe('blocked_by_staged_unclaimed');
    expect(r.has_staged_blockers).toBe(true);
    expect(r.blockers.some((b) => b.code === 'STAGED_UNCLAIMED_FILES_BLOCKED')).toBe(true);
    expect(r.recommended_cli_commands.join(' ')).not.toContain('commit guard');
  });

  test('terminated agent: bootstrap blocks AND the recovery section says terminated/register-new', async () => {
    const repo = makeRepo('vibecode-rec-term-');
    registerBuild(repo, 'agent-dead');
    markAgentTerminated(repo, 'agent-dead');
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-dead', ...baseOpts });
    expect(result.ok).toBe(false);
    const r = result.runtime_awareness.recovery;
    expect(r.resume_state).toBe('terminated');
    expect(r.requires_new_agent).toBe(true);
    expect(r.can_continue_existing_agent).toBe(false);
    expect(r.recommended_cli_commands.join(' ')).not.toContain('heartbeat');
  });

  test('read_only agent: read_only_observe_only', async () => {
    const repo = makeRepo('vibecode-rec-ro-');
    registerAgent(
      repo,
      { agent_name: 'RO', agent_type: 'claude', metadata: { operating_mode: 'read_only', task: 'review' } },
      { agentId: 'agent-ro' },
    );
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-ro', ...baseOpts });
    const r = result.runtime_awareness.recovery;
    expect(r.resume_state).toBe('read_only_observe_only');
    expect(r.recommended_cli_commands.join(' ')).not.toContain('commit guard');
  });

  test('recovery carries the static MCP stale-server CLI-fallback guidance', async () => {
    const repo = makeRepo('vibecode-rec-mcp-');
    registerBuild(repo, 'agent-me');
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const r = result.runtime_awareness.recovery;
    expect(r.mcp_stale_guidance.join(' ')).toContain('vibecode mcp tools --json');
    // No false stale-server warning in a normal session.
    expect(r.warnings.some((w) => /server|mcp/i.test(w.code))).toBe(false);
  });
});
