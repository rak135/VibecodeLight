import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim, releaseFileClaim } from '../../../src/core/coordination/claims.js';
import {
  recordFileChangeEvidence,
  scanChangedFilesToEvidence,
  listCoordinationEvidence,
  summarizeEvidence,
} from '../../../src/core/coordination/watcher.js';
import {
  getEvidenceLogPath,
  readEvidenceEvents,
  appendEvidenceEvents,
  MAX_EVIDENCE_EVENTS,
  type CoordinationEvidenceEvent,
} from '../../../src/core/coordination/watcher_events.js';

/**
 * Phase 4C watcher evidence — non-enforcing. These tests exercise the core
 * evidence service against real coordination state and (for scan) real git
 * working trees. The watcher never mutates source files or git state and never
 * claims physical edit attribution.
 */

const T0 = '2026-01-01T00:00:00.000Z';
const T_LATER = '2026-01-01T01:00:00.000Z'; // beyond the heartbeat TTL

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeGitRepo(prefix: string, opts: { gitignoreVibecode?: boolean } = {}): string {
  const ignore = opts.gitignoreVibecode !== false;
  const root = makeDir(prefix);
  const repo = path.join(root, 'repo with spaces');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  git(['config', 'core.autocrlf', 'false'], repo);
  if (ignore) {
    fs.writeFileSync(path.join(repo, '.gitignore'), '.vibecode/\n', 'utf8');
    git(['add', '.gitignore'], repo);
  }
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repo);
  return repo;
}

function write(repo: string, rel: string, content = 'x\n'): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

const created: string[] = [];
function track(dir: string): string {
  created.push(dir);
  return dir;
}
afterEach(() => {
  while (created.length) {
    const d = created.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('recordFileChangeEvidence — classification & severity', () => {
  let repo: string;
  beforeEach(() => {
    repo = track(makeDir('vibecode-watcher-rec-'));
  });

  test('an unclaimed source path is classified unclaimed with warning severity and appended', () => {
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    const event = recordFileChangeEvidence({
      repoRoot: repo,
      path: 'src/a.ts',
      agent_id: 'agent-a',
      now: T0,
      source: 'test',
    });

    expect(event.event_type).toBe('file_changed');
    expect(event.classification).toBe('unclaimed');
    expect(event.severity).toBe('warning');
    expect(event.detector).toBe('watcher');
    expect(event.detected_at).toBe(T0);
    expect(event.path).toBe('src/a.ts');
    // Persisted to the JSONL log.
    const onDisk = readEvidenceEvents(repo);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].event_id).toBe(event.event_id);
  });

  test('a path covered by the current agent active claim is claimed_by_agent (info)', () => {
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    const added = addFileClaim(repo, { agent_id: 'agent-a', path: 'src/a.ts', mode: 'exclusive' }, { now: T0 });
    const event = recordFileChangeEvidence({ repoRoot: repo, path: 'src/a.ts', agent_id: 'agent-a', now: T0 });
    expect(event.classification).toBe('claimed_by_agent');
    expect(event.severity).toBe('info');
    expect(event.claim_id).toBe(added.claim!.claim_id);
    expect(event.owning_agent_id).toBe('agent-a');
    // The message must not claim physical edit attribution.
    expect(event.message.toLowerCase()).toContain('held an active claim');
    expect(event.message.toLowerCase()).not.toContain('edited');
  });

  test('a path claimed by another active agent is claimed_by_other_active_agent (high)', () => {
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-b', now: T0 });
    addFileClaim(repo, { agent_id: 'agent-b', path: 'src/b.ts', mode: 'exclusive' }, { now: T0 });
    const event = recordFileChangeEvidence({ repoRoot: repo, path: 'src/b.ts', agent_id: 'agent-a', now: T0 });
    expect(event.classification).toBe('claimed_by_other_active_agent');
    expect(event.severity).toBe('high');
    expect(event.owning_agent_id).toBe('agent-b');
  });

  test('a generated .vibecode path is generated_or_ignored (info), never high', () => {
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    const event = recordFileChangeEvidence({
      repoRoot: repo,
      path: '.vibecode/coordination/events.jsonl',
      agent_id: 'agent-a',
      now: T0,
    });
    expect(event.classification).toBe('generated_or_ignored');
    expect(event.severity).toBe('info');
  });

  test('a released claim does not authorize the path (unclaimed)', () => {
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    const added = addFileClaim(repo, { agent_id: 'agent-a', path: 'src/a.ts', mode: 'exclusive' }, { now: T0 });
    releaseFileClaim(repo, added.claim!.claim_id, { now: T0 });
    const event = recordFileChangeEvidence({ repoRoot: repo, path: 'src/a.ts', agent_id: 'agent-a', now: T0 });
    expect(event.classification).toBe('unclaimed');
  });

  test('a claim owned by a stale agent does not authorize the path (unclaimed)', () => {
    registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-b', now: T0 });
    addFileClaim(repo, { agent_id: 'agent-b', path: 'src/b.ts', mode: 'exclusive' }, { now: T0 });
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T_LATER });
    const event = recordFileChangeEvidence({ repoRoot: repo, path: 'src/b.ts', agent_id: 'agent-a', now: T_LATER });
    expect(event.classification).toBe('unclaimed');
  });

  test('event records are compact: no file contents/diff are stored', () => {
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    const event = recordFileChangeEvidence({ repoRoot: repo, path: 'src/a.ts', agent_id: 'agent-a', now: T0 });
    const keys = Object.keys(event);
    expect(keys).not.toContain('content');
    expect(keys).not.toContain('contents');
    expect(keys).not.toContain('diff');
    expect(JSON.stringify(event).length).toBeLessThan(1000);
  });

  test('event ids are unique across records', () => {
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    const a = recordFileChangeEvidence({ repoRoot: repo, path: 'src/a.ts', agent_id: 'agent-a', now: T0 });
    const b = recordFileChangeEvidence({ repoRoot: repo, path: 'src/b.ts', agent_id: 'agent-a', now: T0 });
    expect(a.event_id).not.toBe(b.event_id);
  });
});

describe('events.jsonl storage — resilient & bounded', () => {
  let repo: string;
  beforeEach(() => {
    repo = track(makeDir('vibecode-watcher-store-'));
  });

  test('malformed JSONL lines are skipped without throwing', () => {
    const logPath = getEvidenceLogPath(repo);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const good: CoordinationEvidenceEvent = {
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
    fs.writeFileSync(logPath, `${JSON.stringify(good)}\n{ this is : not json\n\n`, 'utf8');
    const events = readEvidenceEvents(repo);
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe('evt-good');
  });

  test('reading a missing log returns [] and does not create the file', () => {
    expect(readEvidenceEvents(repo)).toEqual([]);
    expect(fs.existsSync(getEvidenceLogPath(repo))).toBe(false);
  });

  test('retention caps the log at MAX_EVIDENCE_EVENTS, keeping the newest', () => {
    const total = MAX_EVIDENCE_EVENTS + 5;
    const events: CoordinationEvidenceEvent[] = Array.from({ length: total }, (_, i) => ({
      event_id: `evt-${i}`,
      event_type: 'file_changed',
      detected_at: T0,
      path: `src/f${i}.ts`,
      classification: 'unclaimed',
      severity: 'warning',
      message: 'x',
      detector: 'watcher',
      evidence: { source: 'test' },
    }));
    appendEvidenceEvents(repo, events);
    const onDisk = readEvidenceEvents(repo);
    expect(onDisk).toHaveLength(MAX_EVIDENCE_EVENTS);
    expect(onDisk[onDisk.length - 1].event_id).toBe(`evt-${total - 1}`);
    expect(onDisk[0].event_id).toBe('evt-5');
  });
});

describe('scanChangedFilesToEvidence — manual scan over real git', () => {
  test('a dirty unclaimed file produces unclaimed evidence', () => {
    const repo = track(makeGitRepo('vibecode-watcher-scan-unc-'));
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    write(repo, 'src/a.ts');
    const result = scanChangedFilesToEvidence({ repoRoot: repo, agent_id: 'agent-a', now: T0, source: 'manual_scan' });
    expect(result.ok).toBe(true);
    const found = result.events.find((e) => e.path === 'src/a.ts');
    expect(found?.classification).toBe('unclaimed');
    expect(found?.evidence.source).toBe('manual_scan');
    expect(readEvidenceEvents(repo).some((e) => e.path === 'src/a.ts')).toBe(true);
  });

  test('a dirty claimed file produces claimed_by_agent evidence', () => {
    const repo = track(makeGitRepo('vibecode-watcher-scan-clm-'));
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    addFileClaim(repo, { agent_id: 'agent-a', path: 'src/a.ts', mode: 'exclusive' }, { now: T0 });
    write(repo, 'src/a.ts');
    const result = scanChangedFilesToEvidence({ repoRoot: repo, agent_id: 'agent-a', now: T0 });
    expect(result.events.find((e) => e.path === 'src/a.ts')?.classification).toBe('claimed_by_agent');
  });

  test('a clean repo produces no events', () => {
    const repo = track(makeGitRepo('vibecode-watcher-scan-clean-'));
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    const result = scanChangedFilesToEvidence({ repoRoot: repo, agent_id: 'agent-a', now: T0 });
    expect(result.ok).toBe(true);
    expect(result.events).toEqual([]);
    expect(readEvidenceEvents(repo)).toEqual([]);
  });

  test('a generated .vibecode change produces an info event, never high', () => {
    const repo = track(makeGitRepo('vibecode-watcher-scan-gen-', { gitignoreVibecode: false }));
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    write(repo, path.join('.vibecode', 'changed.json'), '{}\n');
    const result = scanChangedFilesToEvidence({ repoRoot: repo, agent_id: 'agent-a', now: T0 });
    const found = result.events.find((e) => e.path === '.vibecode/changed.json');
    expect(found?.classification).toBe('generated_or_ignored');
    expect(found?.severity).toBe('info');
    expect(result.events.every((e) => e.severity !== 'high')).toBe(true);
  });

  test('scan does not mutate git state', () => {
    const repo = track(makeGitRepo('vibecode-watcher-scan-nomut-'));
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    write(repo, 'src/a.ts');
    git(['add', '--', 'src/a.ts'], repo);
    const headBefore = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    const statusBefore = git(['status', '--porcelain=v1'], repo).stdout;

    scanChangedFilesToEvidence({ repoRoot: repo, agent_id: 'agent-a', now: T0 });

    expect(git(['rev-parse', 'HEAD'], repo).stdout.trim()).toBe(headBefore);
    expect(git(['status', '--porcelain=v1'], repo).stdout).toBe(statusBefore);
  });

  test('scan does not create or modify the source file it observes', () => {
    const repo = track(makeGitRepo('vibecode-watcher-scan-src-'));
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
    write(repo, 'src/a.ts', 'original\n');
    scanChangedFilesToEvidence({ repoRoot: repo, agent_id: 'agent-a', now: T0 });
    expect(fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8')).toBe('original\n');
  });

  test('a failed git read returns ok:false with warnings and writes no events', () => {
    const dir = track(makeDir('vibecode-watcher-scan-nogit-'));
    const result = scanChangedFilesToEvidence({ repoRoot: dir, now: T0 });
    expect(result.ok).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(readEvidenceEvents(dir)).toEqual([]);
  });
});

describe('listCoordinationEvidence & summarizeEvidence', () => {
  let repo: string;
  beforeEach(() => {
    repo = track(makeDir('vibecode-watcher-list-'));
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a', now: T0 });
  });

  test('list returns appended events and honors limit (newest last)', () => {
    recordFileChangeEvidence({ repoRoot: repo, path: 'src/a.ts', agent_id: 'agent-a', now: T0 });
    recordFileChangeEvidence({ repoRoot: repo, path: 'src/b.ts', agent_id: 'agent-a', now: T0 });
    recordFileChangeEvidence({ repoRoot: repo, path: 'src/c.ts', agent_id: 'agent-a', now: T0 });
    const all = listCoordinationEvidence({ repoRoot: repo });
    expect(all.map((e) => e.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const limited = listCoordinationEvidence({ repoRoot: repo, limit: 2 });
    expect(limited.map((e) => e.path)).toEqual(['src/b.ts', 'src/c.ts']);
  });

  test('summarize counts severities and reports last_event_at', () => {
    // agent-b is active at T_LATER so its claim authorizes nobody-but-itself.
    registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-b', now: T_LATER });
    addFileClaim(repo, { agent_id: 'agent-b', path: 'src/other.ts', mode: 'exclusive' }, { now: T_LATER });
    recordFileChangeEvidence({ repoRoot: repo, path: 'src/a.ts', agent_id: 'agent-a', now: T0 }); // unclaimed -> warning
    recordFileChangeEvidence({ repoRoot: repo, path: 'src/other.ts', agent_id: 'agent-a', now: T_LATER }); // high

    const summary = summarizeEvidence(listCoordinationEvidence({ repoRoot: repo }));
    expect(summary.recent_count).toBe(2);
    expect(summary.warning_count).toBe(1);
    expect(summary.high_count).toBe(1);
    expect(summary.last_event_at).toBe(T_LATER);
  });

  test('summarize of an empty log is all zeros with null last_event_at', () => {
    const summary = summarizeEvidence(listCoordinationEvidence({ repoRoot: repo }));
    expect(summary).toEqual({ recent_count: 0, warning_count: 0, high_count: 0, last_event_at: null });
  });
});
