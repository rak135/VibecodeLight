import fs from 'fs';
import os from 'os';
import path from 'path';

import { FlashToolRunner } from '../../../src/adapters/llm/tool_runner';

function makeWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-tool-runner-'));
  const runId = '20260101-000000-tools';
  const runDir = path.join(workspaceRoot, '.vibecode', 'runs', runId);
  fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), 'hello searchable workspace text\n', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'nested.txt'), 'needle in nested file\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'scan_manifest.json'), '{"ok":true}\n', 'utf8');
  return { workspaceRoot, runId, runDir };
}

describe('FlashToolRunner', () => {
  let workspaceRoot: string;
  let runDir: string;

  beforeEach(() => {
    ({ workspaceRoot, runDir } = makeWorkspace());
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test('read_file can read a repo file inside workspace', () => {
    const tools = new FlashToolRunner({ workspaceRoot, runDir });

    const content = tools.readFile('README.md');

    expect(content).toContain('hello searchable workspace text');
  });

  test('read_file refuses path traversal outside workspace', () => {
    const tools = new FlashToolRunner({ workspaceRoot, runDir });

    expect(() => tools.readFile('../../etc/passwd')).toThrow(/outside workspace|refused/i);
    expect(tools.getToolCalls().at(-1)?.status).toBe('refused');
  });

  test('list_dir lists workspace directory entries', () => {
    const tools = new FlashToolRunner({ workspaceRoot, runDir });

    const entries = tools.listDir('.');

    expect(entries).toContain('README.md');
    expect(entries).toContain('nested.txt');
  });

  test('read_artifact reads allowed run artifacts', () => {
    const tools = new FlashToolRunner({ workspaceRoot, runDir });

    const content = tools.readArtifact('scan/scan_manifest.json');

    expect(content).toContain('"ok":true');
  });

  test('search_text finds text inside allowed workspace files', () => {
    const tools = new FlashToolRunner({ workspaceRoot, runDir });

    const results = tools.searchText('needle');

    expect(results.some((result) => result.path === 'nested.txt' && result.lineText.includes('needle'))).toBe(true);
  });

  test('all tools are read-only and do not write files', () => {
    const before = new Set(fs.readdirSync(workspaceRoot, { recursive: true }).map(String));
    const tools = new FlashToolRunner({ workspaceRoot, runDir });

    tools.readFile('README.md');
    tools.listDir('.');
    tools.readArtifact('scan/scan_manifest.json');
    tools.searchText('needle');

    const after = new Set(fs.readdirSync(workspaceRoot, { recursive: true }).map(String));
    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(workspaceRoot, 'SKILLS', 'mutated.txt'))).toBe(false);
  });

  test('tool call log records successful calls', () => {
    const tools = new FlashToolRunner({ workspaceRoot, runDir });

    tools.readFile('README.md');

    const [call] = tools.getToolCalls();
    expect(call.tool).toBe('read_file');
    expect(call.status).toBe('ok');
    expect(call.pathAccessed).toBe(path.join(workspaceRoot, 'README.md'));
    expect(call.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('tool call log records failed/refused calls', () => {
    const tools = new FlashToolRunner({ workspaceRoot, runDir });

    expect(() => tools.readFile('missing.txt')).toThrow();
    expect(() => tools.readFile('../../etc/passwd')).toThrow();

    const calls = tools.getToolCalls();
    expect(calls.some((call) => call.status === 'error')).toBe(true);
    expect(calls.some((call) => call.status === 'refused')).toBe(true);
  });
});
