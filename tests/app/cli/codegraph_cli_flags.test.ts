import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
}

function makeRepo(): string {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-codegraph-'));
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# CodeGraph CLI fixture\n', 'utf8');
  fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, 'src', 'fixture.ts'), 'export const fixture = true;\n', 'utf8');
  return tmpRepo;
}

describe('CLI CodeGraph flags', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = makeRepo();
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('prompt --codegraph forwards use-existing mode into saved CodeGraph usage artifact', () => {
    const result = runCli([
      'prompt',
      'prompt codegraph mode fixture',
      '--repo',
      tmpRepo,
      '--mock',
      '--json',
      '--codegraph',
    ], tmpRepo);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);

    const usagePath = path.join(payload.data.runDir, 'scan', 'codegraph_usage.json');
    expect(fs.existsSync(usagePath)).toBe(true);
    expect(payload.artifacts).toContain(usagePath);

    const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
    expect(usage.mode).toBe('use-existing');
  });

  test('prompt --no-codegraph keeps detect-only mode and does not create CodeGraph context artifacts', () => {
    const result = runCli([
      'prompt',
      'prompt no codegraph fixture',
      '--repo',
      tmpRepo,
      '--mock',
      '--json',
      '--no-codegraph',
    ], tmpRepo);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);

    const runDir = payload.data.runDir as string;
    const usagePath = path.join(runDir, 'scan', 'codegraph_usage.json');
    const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
    expect(usage.mode).toBe('detect-only');
    expect(usage.used).toBe(false);
    expect(usage.reason).toBe('DETECT_ONLY');
    expect(fs.existsSync(path.join(runDir, 'scan', 'codegraph_context.md'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'scan', 'repo_atlas.md'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'scan', 'repo_atlas.json'))).toBe(false);
  });

  test('desktop.codegraph.mode=use-existing does not change CLI prompt without explicit CodeGraph flag', () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-codegraph-appdata-'));
    const prevLocalAppData = process.env.LOCALAPPDATA;
    try {
      process.env.LOCALAPPDATA = appData;
      const configDir = path.join(appData, 'vibecodelight');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.yaml'), [
        'version: 1',
        'desktop:',
        '  codegraph:',
        '    mode: use-existing',
        '',
      ].join('\n'), 'utf8');

      const result = runCli([
        'prompt',
        'desktop codegraph mode must not affect cli',
        '--repo',
        tmpRepo,
        '--mock',
        '--json',
      ], tmpRepo);

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      const usagePath = path.join(payload.data.runDir, 'scan', 'codegraph_usage.json');
      const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
      expect(usage.mode).toBe('detect-only');
    } finally {
      if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prevLocalAppData;
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  test('prompt rejects conflicting --codegraph and --codegraph-mode detect-only flags with canonical JSON error', () => {
    const result = runCli([
      'prompt',
      'prompt conflicting codegraph flags fixture',
      '--repo',
      tmpRepo,
      '--mock',
      '--json',
      '--codegraph',
      '--codegraph-mode',
      'detect-only',
    ], tmpRepo);

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error).toEqual(expect.objectContaining({
      code: 'CONFLICTING_CODEGRAPH_FLAGS',
      message: expect.any(String),
      details: expect.any(Array),
    }));
  });

  test('context-build --codegraph-mode use-existing remains non-fatal and writes CodeGraph usage artifact', () => {
    const result = runCli([
      'context-build',
      'context build codegraph fixture',
      '--repo',
      tmpRepo,
      '--json',
      '--codegraph-mode',
      'use-existing',
    ], tmpRepo);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);

    const runDir = payload.data.runDir as string;
    const usagePath = path.join(runDir, 'scan', 'codegraph_usage.json');
    expect(fs.existsSync(usagePath)).toBe(true);
    expect(payload.artifacts).toContain(usagePath);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_input.md'))).toBe(true);

    const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
    expect(usage.mode).toBe('use-existing');
  });
});
