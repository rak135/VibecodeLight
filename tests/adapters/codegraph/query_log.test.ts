import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CODEGRAPH_QUERY_LOG_SCHEMA_VERSION,
  logCodeGraphQuery,
  resolveCodeGraphLogPaths,
  type CodeGraphQueryLogEvent,
} from '../../../src/adapters/codegraph/codegraph_query_log.js';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cgquerylog-repo-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  return repo;
}

function makeRunDir(repoRoot: string, runId: string): void {
  fs.mkdirSync(path.join(repoRoot, '.vibecode', 'runs', runId, 'terminal'), { recursive: true });
}

function readJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function makeBaseEvent(
  repoRoot: string,
  overrides: Partial<CodeGraphQueryLogEvent> = {},
): CodeGraphQueryLogEvent {
  return {
    schema_version: CODEGRAPH_QUERY_LOG_SCHEMA_VERSION,
    timestamp: '2026-06-01T00:00:00.000Z',
    run_id: null,
    tool: 'codegraph',
    subcommand: 'search',
    repo_root: repoRoot,
    command: ['codegraph', 'query', '--path', repoRoot, 'desktop settings'],
    input: { query: 'desktop settings' },
    ok: true,
    exit_code: 0,
    duration_ms: 42,
    warnings: [],
    error: null,
    result_summary: {
      stdout_bytes: 12,
      stderr_bytes: 0,
      parsed_json: false,
      items: null,
      truncated: false,
    },
    ...overrides,
  };
}

describe('codegraph query logger', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeRepo();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('writes a workspace-level JSONL event', () => {
    const event = makeBaseEvent(tmpRoot);
    const r = logCodeGraphQuery({ repoRoot: tmpRoot, event });
    expect(r.workspaceLogWritten).toBe(true);
    expect(r.runLogWritten).toBe(false);
    expect(r.warnings).toEqual([]);

    const workspaceLog = path.join(tmpRoot, '.vibecode', 'logs', 'codegraph_queries.jsonl');
    expect(fs.existsSync(workspaceLog)).toBe(true);
    const rows = readJsonl(workspaceLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      schema_version: 1,
      tool: 'codegraph',
      subcommand: 'search',
      repo_root: tmpRoot,
      ok: true,
      duration_ms: 42,
    });
  });

  test('writes a run-scoped JSONL event when run_id is provided and the run dir exists', () => {
    const runId = 'run-abc';
    makeRunDir(tmpRoot, runId);
    const event = makeBaseEvent(tmpRoot, { run_id: runId });
    const r = logCodeGraphQuery({ repoRoot: tmpRoot, runId, event });

    expect(r.workspaceLogWritten).toBe(true);
    expect(r.runLogWritten).toBe(true);
    expect(r.warnings).toEqual([]);

    const runLog = path.join(tmpRoot, '.vibecode', 'runs', runId, 'terminal', 'codegraph_queries.jsonl');
    expect(fs.existsSync(runLog)).toBe(true);
    const rows = readJsonl(runLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subcommand: 'search', run_id: runId });
  });

  test('does not create a fake run dir when run_id directory does not exist', () => {
    const runId = 'does-not-exist';
    const event = makeBaseEvent(tmpRoot, { run_id: runId });
    const r = logCodeGraphQuery({ repoRoot: tmpRoot, runId, event });

    expect(r.workspaceLogWritten).toBe(true);
    expect(r.runLogWritten).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/RUN_LOG_SKIPPED_RUN_NOT_FOUND/);

    expect(fs.existsSync(path.join(tmpRoot, '.vibecode', 'runs', runId))).toBe(false);
  });

  test('invalid run_id cannot write a run-scoped log outside .vibecode/runs', () => {
    const runId = '../../outside';
    const outside = path.resolve(tmpRoot, '.vibecode', 'runs', runId);
    fs.mkdirSync(path.join(outside, 'terminal'), { recursive: true });
    const event = makeBaseEvent(tmpRoot, { run_id: runId });

    const r = logCodeGraphQuery({ repoRoot: tmpRoot, runId, event });

    expect(r.workspaceLogWritten).toBe(true);
    expect(r.runLogWritten).toBe(false);
    expect(r.runLogPath).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/RUN_LOG_SKIPPED_INVALID_RUN_ID/);
    expect(fs.existsSync(path.join(outside, 'terminal', 'codegraph_queries.jsonl'))).toBe(false);
  });

  test('appends multiple events to the same workspace log without overwriting', () => {
    const e1 = makeBaseEvent(tmpRoot, { duration_ms: 1 });
    const e2 = makeBaseEvent(tmpRoot, { duration_ms: 2, subcommand: 'context' });
    const e3 = makeBaseEvent(tmpRoot, { duration_ms: 3, subcommand: 'files' });
    logCodeGraphQuery({ repoRoot: tmpRoot, event: e1 });
    logCodeGraphQuery({ repoRoot: tmpRoot, event: e2 });
    logCodeGraphQuery({ repoRoot: tmpRoot, event: e3 });

    const workspaceLog = path.join(tmpRoot, '.vibecode', 'logs', 'codegraph_queries.jsonl');
    const rows = readJsonl(workspaceLog);
    expect(rows).toHaveLength(3);
    expect((rows[0] as { subcommand: string }).subcommand).toBe('search');
    expect((rows[1] as { subcommand: string }).subcommand).toBe('context');
    expect((rows[2] as { subcommand: string }).subcommand).toBe('files');
  });

  test('creates parent directories for both workspace and run logs', () => {
    const runId = 'run-xyz';
    makeRunDir(tmpRoot, runId);
    expect(fs.existsSync(path.join(tmpRoot, '.vibecode', 'logs'))).toBe(false);
    logCodeGraphQuery({ repoRoot: tmpRoot, runId, event: makeBaseEvent(tmpRoot, { run_id: runId }) });
    expect(fs.existsSync(path.join(tmpRoot, '.vibecode', 'logs'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, '.vibecode', 'runs', runId, 'terminal'))).toBe(true);
  });

  test('tolerates write failures without throwing and returns warnings', () => {
    const origAppend = fs.appendFileSync;
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('EACCES synthetic');
    });
    try {
      const r = logCodeGraphQuery({ repoRoot: tmpRoot, event: makeBaseEvent(tmpRoot) });
      expect(r.workspaceLogWritten).toBe(false);
      expect(r.warnings.join(' ')).toMatch(/CODEGRAPH_QUERY_LOG_WRITE_FAILED/);
    } finally {
      spy.mockRestore();
      // sanity: original still callable
      expect(origAppend).toBeTypeOf('function');
    }
  });

  test('records no stdout/stderr text in event by default (callers only pass byte counts)', () => {
    const event = makeBaseEvent(tmpRoot, {
      result_summary: { stdout_bytes: 12345, stderr_bytes: 6, parsed_json: true, items: 3, truncated: false },
    });
    logCodeGraphQuery({ repoRoot: tmpRoot, event });
    const workspaceLog = path.join(tmpRoot, '.vibecode', 'logs', 'codegraph_queries.jsonl');
    const raw = fs.readFileSync(workspaceLog, 'utf8');
    const parsed = JSON.parse(raw.trim());
    expect(parsed).not.toHaveProperty('stdout');
    expect(parsed).not.toHaveProperty('stderr');
    expect(parsed).not.toHaveProperty('stdoutText');
    expect(parsed).not.toHaveProperty('stderrText');
    expect(parsed.result_summary.stdout_bytes).toBe(12345);
    expect(parsed.result_summary.items).toBe(3);
  });

  test('event includes duration_ms, command, subcommand, repo_root, ok, result_summary', () => {
    logCodeGraphQuery({ repoRoot: tmpRoot, event: makeBaseEvent(tmpRoot) });
    const rows = readJsonl(path.join(tmpRoot, '.vibecode', 'logs', 'codegraph_queries.jsonl'));
    const ev = rows[0] as Record<string, unknown>;
    expect(ev.duration_ms).toBeDefined();
    expect(ev.command).toBeDefined();
    expect(ev.subcommand).toBeDefined();
    expect(ev.repo_root).toBeDefined();
    expect(ev.ok).toBeDefined();
    expect(ev.result_summary).toBeDefined();
  });

  test('failures are still logged with ok=false and an error block', () => {
    const event = makeBaseEvent(tmpRoot, {
      ok: false,
      exit_code: 1,
      error: { code: 'CODEGRAPH_QUERY_FAILED', message: 'index lock' },
      result_summary: { stdout_bytes: 0, stderr_bytes: 18, parsed_json: false, items: null, truncated: false },
    });
    logCodeGraphQuery({ repoRoot: tmpRoot, event });
    const rows = readJsonl(path.join(tmpRoot, '.vibecode', 'logs', 'codegraph_queries.jsonl'));
    expect(rows[0]).toMatchObject({
      ok: false,
      exit_code: 1,
      error: { code: 'CODEGRAPH_QUERY_FAILED', message: 'index lock' },
    });
  });

  test('resolveCodeGraphLogPaths returns the canonical paths under .vibecode', () => {
    const paths = resolveCodeGraphLogPaths(tmpRoot, 'r1');
    expect(paths.workspaceLog).toBe(path.join(tmpRoot, '.vibecode', 'logs', 'codegraph_queries.jsonl'));
    expect(paths.runLog).toBe(
      path.join(tmpRoot, '.vibecode', 'runs', 'r1', 'terminal', 'codegraph_queries.jsonl'),
    );
  });

  test('never writes outside .vibecode/logs or .vibecode/runs/<run_id>/terminal', () => {
    const runId = 'guard-run';
    makeRunDir(tmpRoot, runId);
    logCodeGraphQuery({ repoRoot: tmpRoot, runId, event: makeBaseEvent(tmpRoot, { run_id: runId }) });
    const entries = fs.readdirSync(tmpRoot).sort();
    expect(entries).toEqual(['.vibecode', 'README.md'].sort());
    const vibecodeEntries = fs.readdirSync(path.join(tmpRoot, '.vibecode')).sort();
    expect(vibecodeEntries.every((e) => e === 'logs' || e === 'runs')).toBe(true);
  });
});
