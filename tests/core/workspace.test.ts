import fs from 'fs';
import os from 'os';
import path from 'path';

import { initWorkspace } from '../../src/core/workspace/initializer';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-workspace-'));
}

describe('workspace init', () => {
  test('initWorkspace creates .vibecode directory', async () => {
    const root = tempDir();
    const result = await initWorkspace(root);
    expect(fs.existsSync(path.join(root, '.vibecode'))).toBe(true);
    expect(result.created).toContain('.vibecode');
  });

  test('initWorkspace creates .vibecode/runs directory', async () => {
    const root = tempDir();
    const result = await initWorkspace(root);
    expect(fs.existsSync(path.join(root, '.vibecode', 'runs'))).toBe(true);
    expect(result.created).toContain('.vibecode/runs');
  });

  test('initWorkspace creates .vibecode/current directory', async () => {
    const root = tempDir();
    const result = await initWorkspace(root);
    expect(fs.existsSync(path.join(root, '.vibecode', 'current'))).toBe(true);
    expect(result.created).toContain('.vibecode/current');
  });

  test('initWorkspace adds .vibecode/ to .gitignore', async () => {
    const root = tempDir();
    await initWorkspace(root);
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.vibecode/');
  });

  test('initWorkspace adds .codegraph/ to .gitignore (external generated state)', async () => {
    const root = tempDir();
    await initWorkspace(root);
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.codegraph/');
  });

  test('initWorkspace .codegraph/ ignore entry is idempotent', async () => {
    const root = tempDir();
    await initWorkspace(root);
    await initWorkspace(root);
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const occurrences = gitignore.split('\n').filter((line) => line.trim() === '.codegraph/').length;
    expect(occurrences).toBe(1);
  });

  test('initWorkspace preserves an existing .codegraph/ ignore entry without duplicating', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.codegraph/\n', 'utf8');
    await initWorkspace(root);
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const occurrences = gitignore.split('\n').filter((line) => line.trim() === '.codegraph/').length;
    expect(occurrences).toBe(1);
  });

  test('initWorkspace does not overwrite existing config.yaml', async () => {
    const root = tempDir();
    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, 'project: existing-project\n');
    const before = fs.readFileSync(configPath, 'utf8');
    const result = await initWorkspace(root);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(result.existing).toContain('config.yaml');
  });

  test('initWorkspace creates config.yaml if it does not exist', async () => {
    const root = tempDir();
    const result = await initWorkspace(root);
    expect(fs.existsSync(path.join(root, 'config.yaml'))).toBe(true);
    expect(result.created).toContain('config.yaml');
  });

  test('initWorkspace reports what was created vs already existed', async () => {
    const root = tempDir();
    await initWorkspace(root);
    const result = await initWorkspace(root);
    expect(result.created.length).toBe(0);
    expect(result.existing).toEqual(expect.arrayContaining(['.vibecode', '.vibecode/runs', '.vibecode/current', 'config.yaml', '.gitignore']));
  });
});
