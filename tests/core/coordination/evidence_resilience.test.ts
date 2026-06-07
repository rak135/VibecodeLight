import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, describe, expect, test } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { getCoordinationStatus } from '../../../src/core/coordination/status.js';
import { scanChangedFilesToEvidence } from '../../../src/core/coordination/watcher.js';
import { getEvidenceLogPath } from '../../../src/core/coordination/watcher_events.js';

/**
 * Phase 4C review "can wait" follow-ups, folded into Phase 4D:
 *   1. coordination status survives a deliberately corrupt events.jsonl and
 *      still returns an evidence summary;
 *   2. an evidence scan with a traversal run_id cannot create paths outside the
 *      repo (the run resolver rejects it; evidence is non-enforcing so it keeps
 *      the raw run id rather than failing).
 */

const T0 = '2026-01-01T00:00:00.000Z';

const created: string[] = [];
function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeGitRepo(prefix: string): string {
  const root = makeDir(prefix);
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

describe('coordination status — resilient to a corrupt evidence log', () => {
  test('a corrupt events.jsonl still yields a safe evidence summary', () => {
    const repo = makeDir('vibecode-evidence-corrupt-');
    const logPath = getEvidenceLogPath(repo);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const good = {
      event_id: 'evt-good',
      event_type: 'file_changed',
      detected_at: T0,
      path: 'src/a.ts',
      classification: 'unclaimed',
      severity: 'warning',
      message: 'x',
      detector: 'watcher',
      evidence: { source: 'test' },
    };
    fs.writeFileSync(logPath, `${JSON.stringify(good)}\n{ broken json\n\nnot-even-json\n`, 'utf8');

    const status = getCoordinationStatus(repo, { now: T0 });
    // The corrupt lines are skipped; the one good warning is summarized.
    expect(status.evidence.recent_count).toBe(1);
    expect(status.evidence.warning_count).toBe(1);
    expect(status.evidence.last_event_at).toBe(T0);
  });
});

describe('evidence scan — traversal run_id cannot escape the repo', () => {
  test('a traversal run_id is handled safely and creates no outside paths', () => {
    const repo = makeGitRepo('vibecode-evidence-traversal-');
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude' }, { agentId: 'agent-a', now: T0 });
    fs.writeFileSync(path.join(repo, 'a.ts'), 'x\n', 'utf8');

    const sentinel = path.join(repo, '..', 'PWNED');
    expect(() =>
      scanChangedFilesToEvidence({ repoRoot: repo, agent_id: 'agent-a', run_id: '../../PWNED', now: T0 }),
    ).not.toThrow();

    // The scan still records evidence for the dirty file...
    const result = scanChangedFilesToEvidence({ repoRoot: repo, agent_id: 'agent-a', run_id: '../../PWNED', now: T0 });
    expect(result.ok).toBe(true);
    expect(result.events.some((e) => e.path === 'a.ts')).toBe(true);
    // ...but no path was ever created outside the repo from the traversal id.
    expect(fs.existsSync(sentinel)).toBe(false);
  });
});
