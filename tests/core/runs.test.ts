import fs from 'fs';
import os from 'os';
import path from 'path';

import { createRun } from '../../src/core/runs/run_store';
import { updateCurrent } from '../../src/core/runs/current';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-runs-'));
}

describe('run store', () => {
  test('createRun returns a run ID matching pattern YYYYMMDD-HHMMSS-XXXX', async () => {
    const root = tempDir();
    const vibecodePath = path.join(root, '.vibecode');
    fs.mkdirSync(vibecodePath, { recursive: true });
    const result = await createRun({ vibecodePath, task: 'test task', repoRoot: root });
    expect(result.run_id).toMatch(/^\d{8}-\d{6}-[A-Z0-9]{4}$/);
  });

  test('createRun creates .vibecode/runs/<run_id>/ directory', async () => {
    const root = tempDir();
    const vibecodePath = path.join(root, '.vibecode');
    fs.mkdirSync(vibecodePath, { recursive: true });
    const result = await createRun({ vibecodePath, task: 'test task', repoRoot: root });
    expect(fs.existsSync(result.runDir)).toBe(true);
  });

  test('createRun writes user_prompt.md with the task text', async () => {
    const root = tempDir();
    const vibecodePath = path.join(root, '.vibecode');
    fs.mkdirSync(vibecodePath, { recursive: true });
    const result = await createRun({ vibecodePath, task: 'test task', repoRoot: root });
    expect(fs.readFileSync(path.join(result.runDir, 'user_prompt.md'), 'utf8')).toContain('test task');
  });

  test('createRun writes run_manifest.json with run_id, created_at, task', async () => {
    const root = tempDir();
    const vibecodePath = path.join(root, '.vibecode');
    fs.mkdirSync(vibecodePath, { recursive: true });
    const result = await createRun({ vibecodePath, task: 'test task', repoRoot: root });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.runDir, 'run_manifest.json'), 'utf8'));
    expect(manifest.run_id).toBe(result.run_id);
    expect(manifest.task).toBe('test task');
    expect(typeof manifest.created_at).toBe('string');
  });

  test('createRun writes scanner_config.json', async () => {
    const root = tempDir();
    const vibecodePath = path.join(root, '.vibecode');
    fs.mkdirSync(vibecodePath, { recursive: true });
    const result = await createRun({ vibecodePath, task: 'test task', repoRoot: root });
    const config = JSON.parse(fs.readFileSync(path.join(result.runDir, 'scanner_config.json'), 'utf8'));
    expect(config.run_id).toBe(result.run_id);
    expect(config.out_dir).toBe('scan');
  });

  test('createRun creates scan/ directory', async () => {
    const root = tempDir();
    const vibecodePath = path.join(root, '.vibecode');
    fs.mkdirSync(vibecodePath, { recursive: true });
    const result = await createRun({ vibecodePath, task: 'test task', repoRoot: root });
    expect(fs.existsSync(path.join(result.runDir, 'scan'))).toBe(true);
    expect(fs.existsSync(result.scanDir)).toBe(true);
  });

  test('createRun preserves both runs when called back-to-back', async () => {
    const root = tempDir();
    const vibecodePath = path.join(root, '.vibecode');
    fs.mkdirSync(vibecodePath, { recursive: true });

    const first = await createRun({ vibecodePath, task: 'first task', repoRoot: root });
    const second = await createRun({ vibecodePath, task: 'second task', repoRoot: root });

    expect(second.run_id).not.toBe(first.run_id);
    expect(fs.existsSync(first.runDir)).toBe(true);
    expect(fs.existsSync(second.runDir)).toBe(true);
    expect(fs.readFileSync(path.join(first.runDir, 'user_prompt.md'), 'utf8')).toContain('first task');
    expect(fs.readFileSync(path.join(second.runDir, 'user_prompt.md'), 'utf8')).toContain('second task');
  });

  test('createRun keeps run paths inside the workspace .vibecode directory', async () => {
    const root = tempDir();
    const vibecodePath = path.join(root, '.vibecode');
    fs.mkdirSync(vibecodePath, { recursive: true });

    const result = await createRun({ vibecodePath, task: 'path containment', repoRoot: root });
    const runRelative = path.relative(vibecodePath, result.runDir);
    const scanRelative = path.relative(vibecodePath, result.scanDir);

    expect(runRelative).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(scanRelative).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(path.isAbsolute(result.runDir)).toBe(true);
    expect(path.isAbsolute(result.scanDir)).toBe(true);
  });

  test('updateCurrent writes .vibecode/current/run_manifest.json', async () => {
    const root = tempDir();
    const vibecodePath = path.join(root, '.vibecode');
    fs.mkdirSync(vibecodePath, { recursive: true });
    const manifest = {
      run_id: '20240101-010203-ABCD',
      created_at: new Date().toISOString(),
      task: 'test task',
      status: 'created' as const,
    };
    await updateCurrent(vibecodePath, manifest);
    const currentManifest = JSON.parse(fs.readFileSync(path.join(vibecodePath, 'current', 'run_manifest.json'), 'utf8'));
    expect(currentManifest.run_id).toBe(manifest.run_id);
  });
});
