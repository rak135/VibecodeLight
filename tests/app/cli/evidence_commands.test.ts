import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, describe, expect, test } from 'vitest';

import { createCli } from '../../../src/app/cli/index.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import { getEvidenceLogPath } from '../../../src/core/coordination/watcher_events.js';

/**
 * Phase 4C CLI evidence commands. `evidence scan` writes generated evidence
 * events from the current dirty git working tree; `evidence list` reads them.
 * Both are read-only against repo source and git state.
 */

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

const created: string[] = [];
function makeGitRepo(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repo);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repo);
  return repo;
}

afterEach(() => {
  while (created.length) {
    const d = created.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

async function runCli(argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exitCode;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
  process.exitCode = 0;
  try {
    const program = createCli();
    await program.parseAsync(['node', 'vibecode', ...argv]);
    return { stdout: logs.join('\n'), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExit;
  }
}

describe('vibecode evidence scan', () => {
  test('scan --json records evidence for a dirty unclaimed file and returns a stable envelope', async () => {
    const repo = makeGitRepo('vibecode-cli-evidence-scan-');
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude' }, { agentId: 'agent-a' });
    fs.writeFileSync(path.join(repo, 'a.ts'), 'x\n', 'utf8');

    const { stdout } = await runCli(['evidence', 'scan', '--repo', repo, '--agent', 'agent-a', '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    const found = parsed.data.events.find((e: { path: string }) => e.path === 'a.ts');
    expect(found.classification).toBe('unclaimed');
    expect(parsed.data.summary.warning_count).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(getEvidenceLogPath(repo))).toBe(true);
  });

  test('scan does not mutate git state', async () => {
    const repo = makeGitRepo('vibecode-cli-evidence-nomut-');
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude' }, { agentId: 'agent-a' });
    fs.writeFileSync(path.join(repo, 'a.ts'), 'x\n', 'utf8');
    const headBefore = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    const statusBefore = git(['status', '--porcelain=v1'], repo).stdout;

    await runCli(['evidence', 'scan', '--repo', repo, '--agent', 'agent-a', '--json']);

    expect(git(['rev-parse', 'HEAD'], repo).stdout.trim()).toBe(headBefore);
    expect(git(['status', '--porcelain=v1'], repo).stdout).toBe(statusBefore);
  });
});

describe('vibecode evidence list', () => {
  test('list --json returns recorded events after a scan', async () => {
    const repo = makeGitRepo('vibecode-cli-evidence-list-');
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude' }, { agentId: 'agent-a' });
    addFileClaim(repo, { agent_id: 'agent-a', path: 'a.ts', mode: 'exclusive' });
    fs.writeFileSync(path.join(repo, 'a.ts'), 'x\n', 'utf8');
    await runCli(['evidence', 'scan', '--repo', repo, '--agent', 'agent-a', '--json']);

    const { stdout } = await runCli(['evidence', 'list', '--repo', repo, '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    const found = parsed.data.events.find((e: { path: string }) => e.path === 'a.ts');
    expect(found.classification).toBe('claimed_by_agent');
  });

  test('list --json on a fresh repo returns an empty event list', async () => {
    const repo = makeGitRepo('vibecode-cli-evidence-empty-');
    const { stdout } = await runCli(['evidence', 'list', '--repo', repo, '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.events).toEqual([]);
  });
});
