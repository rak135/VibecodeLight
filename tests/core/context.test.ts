import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildFlashInputManifest,
  buildFlashInput,
  getPreviousRunSummary,
} from '../../src/core/context/index.js';

// Helpers
function makeTmpRunDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-ctx-test-'));
  fs.mkdirSync(path.join(tmp, 'scan'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'flash'), { recursive: true });
  return tmp;
}

function writeRequiredArtifacts(runDir: string, runId = 'test-run-id'): void {
  fs.writeFileSync(path.join(runDir, 'user_prompt.md'), 'test task\n');
  fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify({
    run_id: runId,
    created_at: '2025-01-01T00:00:00.000Z',
    task: 'test task',
    status: 'done',
  }));
  fs.writeFileSync(path.join(runDir, 'scanner_config.json'), JSON.stringify({
    run_id: runId,
    repo_root: '/repo',
    task: 'test task',
    paths: { scan_out: 'scan' },
  }));
  fs.writeFileSync(path.join(runDir, 'scan', 'scan_manifest.json'), JSON.stringify({
    run_id: runId,
    artifacts: {},
  }));
  fs.writeFileSync(path.join(runDir, 'skills', 'skills_catalog.json'), JSON.stringify({
    generated_at: '2025-01-01T00:00:00.000Z',
    skills: [],
    warnings: [],
  }));
}

describe('buildFlashInputManifest', () => {
  test('references all required scan artifacts', () => {
    const runDir = makeTmpRunDir();
    writeRequiredArtifacts(runDir);

    const manifest = buildFlashInputManifest({
      run_id: 'test-run-id',
      task: 'test task',
      repo_root: '/repo',
      runDir,
    });

    expect(manifest.required_inputs).toHaveProperty('user_prompt', 'user_prompt.md');
    expect(manifest.required_inputs).toHaveProperty('run_manifest', 'run_manifest.json');
    expect(manifest.required_inputs).toHaveProperty('scanner_config', 'scanner_config.json');
    expect(manifest.required_inputs).toHaveProperty('scan_manifest', 'scan/scan_manifest.json');
    expect(manifest.required_inputs).toHaveProperty('skills_catalog', 'skills/skills_catalog.json');
    expect(manifest.optional_inputs).not.toHaveProperty('scanner_config');

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('manifest includes artifacts map for saved required inputs and present optional inputs', () => {
    const runDir = makeTmpRunDir();
    writeRequiredArtifacts(runDir);
    fs.writeFileSync(path.join(runDir, 'scan', 'repo_tree.txt'), 'tree artifact\n');

    const manifest = buildFlashInputManifest({
      run_id: 'test-run-id',
      task: 'test task',
      repo_root: '/repo',
      runDir,
    });

    expect(manifest.artifacts).toMatchObject({
      user_prompt: 'user_prompt.md',
      run_manifest: 'run_manifest.json',
      scanner_config: 'scanner_config.json',
      scan_manifest: 'scan/scan_manifest.json',
      skills_catalog: 'skills/skills_catalog.json',
      repo_tree: 'scan/repo_tree.txt',
    });
    expect(manifest.artifacts).not.toHaveProperty('file_inventory');

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('missing required artifact produces structured diagnostic', () => {
    const runDir = makeTmpRunDir();
    // Only write partial artifacts - missing scanner_config.json, scan_manifest.json, and skills_catalog.json
    fs.writeFileSync(path.join(runDir, 'user_prompt.md'), 'test task\n');
    fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify({ run_id: 'x', created_at: 'x', task: 'x', status: 'done' }));

    expect(() => buildFlashInputManifest({
      run_id: 'test-run-id',
      task: 'test task',
      repo_root: '/repo',
      runDir,
    })).toThrow(/scanner_config\.json/);

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('missing optional artifact records warning', () => {
    const runDir = makeTmpRunDir();
    writeRequiredArtifacts(runDir);
    // Do NOT write any optional artifacts like scan/repo_tree.txt

    const manifest = buildFlashInputManifest({
      run_id: 'test-run-id',
      task: 'test task',
      repo_root: '/repo',
      runDir,
    });

    expect(Array.isArray(manifest.warnings)).toBe(true);
    expect(manifest.warnings.some((w) => w.includes('repo_tree'))).toBe(true);

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('skills_catalog.json is included as a required input', () => {
    const runDir = makeTmpRunDir();
    writeRequiredArtifacts(runDir);

    const manifest = buildFlashInputManifest({
      run_id: 'test-run-id',
      task: 'test task',
      repo_root: '/repo',
      runDir,
    });

    expect(manifest.required_inputs.skills_catalog).toBe('skills/skills_catalog.json');

    fs.rmSync(runDir, { recursive: true, force: true });
  });
});

describe('buildFlashInput', () => {
  test('flash_input.md includes all required sections', () => {
    const runDir = makeTmpRunDir();
    writeRequiredArtifacts(runDir);

    const content = buildFlashInput({
      run_id: 'test-run-id',
      task: 'test task',
      repo_root: '/repo',
      runDir,
      previousRunSummary: undefined,
    });

    const sections = [
      '# Task',
      '# Run Metadata',
      '# Git State',
      '# Repository Tree',
      '# File Inventory Summary',
      '# Manifests and Dependencies',
      '# Environment',
      '# Commands',
      '# Tooling',
      '# Repository Instructions',
      '# Documentation',
      '# Architecture Documents',
      '# Symbols',
      '# Imports',
      '# Entrypoints',
      '# Tests',
      '# Schemas',
      '# Keyword Hits',
      '# Recent History',
      '# Skills Catalog',
      '# Previous Run Summary',
      '# Flash Instructions',
    ];

    for (const section of sections) {
      expect(content).toMatch(new RegExp(`^${section}$`, 'm'));
    }

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('flash input builder reads saved artifacts and does not re-scan repository', () => {
    const runDir = makeTmpRunDir();
    writeRequiredArtifacts(runDir);
    // Write a known optional artifact so we can verify it was read
    fs.writeFileSync(
      path.join(runDir, 'scan', 'repo_tree.txt'),
      'my-unique-repo-tree-content\n',
    );

    const content = buildFlashInput({
      run_id: 'test-run-id',
      task: 'test task',
      repo_root: '/repo',
      runDir,
      previousRunSummary: undefined,
    });

    expect(content).toContain('my-unique-repo-tree-content');

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('previous run summary section says "none available" when no previous run passed', () => {
    const runDir = makeTmpRunDir();
    writeRequiredArtifacts(runDir);

    const content = buildFlashInput({
      run_id: 'test-run-id',
      task: 'test task',
      repo_root: '/repo',
      runDir,
      previousRunSummary: undefined,
    });

    expect(content).toContain('# Previous Run Summary');
    expect(content).toContain('none available');

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('flash input does not include terminal context section', () => {
    const runDir = makeTmpRunDir();
    writeRequiredArtifacts(runDir);
    fs.writeFileSync(
      path.join(runDir, 'terminal_context.json'),
      JSON.stringify({ included: true, excerpt: 'previous run output must not be used' }),
      'utf8',
    );

    const content = buildFlashInput({
      run_id: 'test-run-id',
      task: 'test task',
      repo_root: '/repo',
      runDir,
      previousRunSummary: undefined,
    });

    expect(content).not.toContain('# Terminal Context');
    expect(content).not.toContain('previous run output must not be used');

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('includes task text in Task section', () => {
    const runDir = makeTmpRunDir();
    fs.writeFileSync(path.join(runDir, 'user_prompt.md'), 'my specific task text\n');
    fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify({ run_id: 'x', created_at: 'x', task: 'my specific task text', status: 'done' }));
    fs.writeFileSync(path.join(runDir, 'scanner_config.json'), JSON.stringify({ task: 'my specific task text', paths: { scan_out: 'scan' } }));
    fs.writeFileSync(path.join(runDir, 'scan', 'scan_manifest.json'), JSON.stringify({ run_id: 'x', artifacts: {} }));
    fs.writeFileSync(path.join(runDir, 'skills', 'skills_catalog.json'), JSON.stringify({ generated_at: 'x', skills: [], warnings: [] }));

    const content = buildFlashInput({
      run_id: 'x',
      task: 'my specific task text',
      repo_root: '/repo',
      runDir,
      previousRunSummary: undefined,
    });

    expect(content).toContain('my specific task text');

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('includes scanner_config.json content from saved artifacts', () => {
    const runDir = makeTmpRunDir();
    writeRequiredArtifacts(runDir);

    const content = buildFlashInput({
      run_id: 'test-run-id',
      task: 'test task',
      repo_root: '/repo',
      runDir,
      previousRunSummary: undefined,
    });

    expect(content).toContain('scanner_config.json');
    expect(content).toContain('"scan_out": "scan"');

    fs.rmSync(runDir, { recursive: true, force: true });
  });
});

describe('getPreviousRunSummary', () => {
  test('returns undefined when runs directory is empty', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-prev-test-'));
    const vibecodePath = path.join(tmp, '.vibecode');
    fs.mkdirSync(path.join(vibecodePath, 'runs'), { recursive: true });

    const summary = getPreviousRunSummary({
      vibecodePath,
      currentRunId: 'current-run-id',
    });

    expect(summary).toBeUndefined();

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('returns summary of most recent done run excluding current', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-prev-test-'));
    const vibecodePath = path.join(tmp, '.vibecode');
    const runsDir = path.join(vibecodePath, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    // Create a previous run
    const prevRunId = '20250101-120000-AAAA';
    const prevRunDir = path.join(runsDir, prevRunId);
    fs.mkdirSync(prevRunDir, { recursive: true });
    fs.writeFileSync(path.join(prevRunDir, 'run_manifest.json'), JSON.stringify({
      run_id: prevRunId,
      created_at: '2025-01-01T12:00:00.000Z',
      task: 'previous task',
      status: 'done',
    }));

    const summary = getPreviousRunSummary({
      vibecodePath,
      currentRunId: '20250101-130000-BBBB',
    });

    expect(summary).toBeDefined();
    expect(summary?.run_id).toBe(prevRunId);
    expect(summary?.task).toBe('previous task');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
