import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeTerminalContextArtifact } from '../../../src/core/context/terminal_context_writer.js';

describe('writeTerminalContextArtifact', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-tc-writer-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('writes terminal_context.json with included:true when excerpt is provided', () => {
    const runDir = path.join(tmpRoot, 'run1');
    fs.mkdirSync(runDir, { recursive: true });

    writeTerminalContextArtifact(runDir, {
      included: true,
      reason: 'user requested --include-terminal-context',
      sourceRunId: 'prev-run-001',
      sourcePath: '/some/.vibecode/runs/prev-run-001/terminal/terminal_excerpt_after.md',
      excerpt: 'npm test\n✓ 5 tests passed',
    });

    const artifactPath = path.join(runDir, 'terminal_context.json');
    expect(fs.existsSync(artifactPath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    expect(data.included).toBe(true);
    expect(data.reason).toContain('--include-terminal-context');
    expect(data.source_run_id).toBe('prev-run-001');
    expect(data.source_path).toContain('terminal_excerpt_after.md');
    expect(data.excerpt).toContain('5 tests passed');
    expect(typeof data.excerpt_char_count).toBe('number');
    expect(data.excerpt_char_count).toBeGreaterThan(0);
    expect(Array.isArray(data.warnings)).toBe(true);
  });

  test('writes terminal_context.json with included:false when not provided', () => {
    const runDir = path.join(tmpRoot, 'run2');
    fs.mkdirSync(runDir, { recursive: true });

    writeTerminalContextArtifact(runDir, {
      included: false,
      reason: 'not requested',
    });

    const artifactPath = path.join(runDir, 'terminal_context.json');
    expect(fs.existsSync(artifactPath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    expect(data.included).toBe(false);
    expect(data.reason).toBe('not requested');
    expect(data.excerpt).toBeUndefined();
    expect(data.source_run_id).toBeUndefined();
  });

  test('excerpt_char_count matches excerpt length', () => {
    const runDir = path.join(tmpRoot, 'run3');
    fs.mkdirSync(runDir, { recursive: true });
    const excerpt = 'hello world\nfoo bar';

    writeTerminalContextArtifact(runDir, {
      included: true,
      reason: 'test',
      excerpt,
    });

    const data = JSON.parse(fs.readFileSync(path.join(runDir, 'terminal_context.json'), 'utf8'));
    expect(data.excerpt_char_count).toBe(excerpt.length);
  });

  test('writes line_count when excerpt has multiple lines', () => {
    const runDir = path.join(tmpRoot, 'run4');
    fs.mkdirSync(runDir, { recursive: true });
    const excerpt = 'line1\nline2\nline3';

    writeTerminalContextArtifact(runDir, {
      included: true,
      reason: 'test',
      excerpt,
    });

    const data = JSON.parse(fs.readFileSync(path.join(runDir, 'terminal_context.json'), 'utf8'));
    expect(data.line_count).toBe(3);
  });

  test('terminal_context.json is valid JSON envelope with canonical fields', () => {
    const runDir = path.join(tmpRoot, 'run5');
    fs.mkdirSync(runDir, { recursive: true });

    writeTerminalContextArtifact(runDir, {
      included: true,
      reason: 'test',
      excerpt: 'test output',
    });

    const data = JSON.parse(fs.readFileSync(path.join(runDir, 'terminal_context.json'), 'utf8'));
    // required fields
    expect(data).toHaveProperty('included');
    expect(data).toHaveProperty('reason');
    expect(data).toHaveProperty('warnings');
  });
});

describe('flash_input.md terminal context section', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-flash-tc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeRunDir(root: string, id: string): string {
    const runDir = path.join(root, id);
    fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'user_prompt.md'), 'test task\n');
    fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify({
      run_id: id, created_at: '2025-01-01T00:00:00Z', task: 'test task', status: 'done',
    }));
    fs.writeFileSync(path.join(runDir, 'scanner_config.json'), JSON.stringify({
      run_id: id, task: 'test task', paths: { scan_out: 'scan' },
    }));
    fs.writeFileSync(path.join(runDir, 'scan', 'scan_manifest.json'), JSON.stringify({
      run_id: id, artifacts: {},
    }));
    fs.writeFileSync(path.join(runDir, 'skills', 'skills_catalog.json'), JSON.stringify({
      generated_at: 'x', skills: [], warnings: [],
    }));
    return runDir;
  }

  test('flash_input.md Terminal Context section includes excerpt when terminal_context.json has included:true', async () => {
    const { buildFlashInput } = await import('../../../src/core/context/index.js');
    const runDir = makeRunDir(tmpRoot, 'run-inc');
    const { writeTerminalContextArtifact: write } = await import('../../../src/core/context/terminal_context_writer.js');

    write(runDir, {
      included: true,
      reason: 'user requested',
      excerpt: 'test output from previous run',
    });

    const content = buildFlashInput({
      run_id: 'run-inc',
      task: 'test task',
      repo_root: tmpRoot,
      runDir,
    });

    expect(content).toContain('# Terminal Context');
    expect(content).toContain('test output from previous run');
  });

  test('flash_input.md Terminal Context section says not included when terminal_context.json has included:false', async () => {
    const { buildFlashInput } = await import('../../../src/core/context/index.js');
    const runDir = makeRunDir(tmpRoot, 'run-noinc');
    const { writeTerminalContextArtifact: write } = await import('../../../src/core/context/terminal_context_writer.js');

    write(runDir, {
      included: false,
      reason: 'not requested',
    });

    const content = buildFlashInput({
      run_id: 'run-noinc',
      task: 'test task',
      repo_root: tmpRoot,
      runDir,
    });

    expect(content).toContain('# Terminal Context');
    expect(content).toContain('not included');
  });

  test('flash_input.md Terminal Context section says not included when no terminal_context.json file exists', async () => {
    const { buildFlashInput } = await import('../../../src/core/context/index.js');
    const runDir = makeRunDir(tmpRoot, 'run-none');

    const content = buildFlashInput({
      run_id: 'run-none',
      task: 'test task',
      repo_root: tmpRoot,
      runDir,
    });

    expect(content).toContain('# Terminal Context');
    expect(content).toContain('not included');
  });
});
