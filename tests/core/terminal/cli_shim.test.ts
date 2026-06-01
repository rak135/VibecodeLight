import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildTerminalEnv,
  prepareVibecodeCliShim,
  shimBinDir,
  shimEntryPath,
  writeVibecodeCliShim,
} from '../../../src/core/terminal/cli_shim.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vbc-shim-'));
}

describe('cli_shim — writeVibecodeCliShim', () => {
  test('creates <repo>/.vibecode/bin/vibecode.cmd', () => {
    const repo = mkTmp();
    const appCli = path.join(repo, 'bin', 'vibecode.js');

    const result = writeVibecodeCliShim({ repoPath: repo, appCliPath: appCli, platform: 'win32' });

    const expected = path.join(repo, '.vibecode', 'bin', 'vibecode.cmd');
    expect(result.windowsShimPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  test('windows shim invokes node with the absolute appCli path and forwards args', () => {
    const repo = mkTmp();
    const appCli = path.join(repo, 'bin', 'vibecode.js');

    writeVibecodeCliShim({ repoPath: repo, appCliPath: appCli, platform: 'win32' });
    const content = fs.readFileSync(
      path.join(repo, '.vibecode', 'bin', 'vibecode.cmd'),
      'utf8',
    );

    expect(content).toContain('@echo off');
    expect(content).toContain(`node "${appCli}" %*`);
  });

  test('is idempotent — repeated calls keep the same content', () => {
    const repo = mkTmp();
    const appCli = path.join(repo, 'bin', 'vibecode.js');

    writeVibecodeCliShim({ repoPath: repo, appCliPath: appCli, platform: 'win32' });
    const first = fs.readFileSync(path.join(repo, '.vibecode', 'bin', 'vibecode.cmd'), 'utf8');
    writeVibecodeCliShim({ repoPath: repo, appCliPath: appCli, platform: 'win32' });
    const second = fs.readFileSync(path.join(repo, '.vibecode', 'bin', 'vibecode.cmd'), 'utf8');

    expect(second).toBe(first);
  });

  test('refreshes the shim when the appCli path changes', () => {
    const repo = mkTmp();
    const firstCli = path.join(repo, 'bin', 'vibecode.js');
    const secondCli = path.join(repo, 'bin', 'vibecode-v2.js');

    writeVibecodeCliShim({ repoPath: repo, appCliPath: firstCli, platform: 'win32' });
    writeVibecodeCliShim({ repoPath: repo, appCliPath: secondCli, platform: 'win32' });
    const content = fs.readFileSync(
      path.join(repo, '.vibecode', 'bin', 'vibecode.cmd'),
      'utf8',
    );

    expect(content).toContain(`node "${secondCli}" %*`);
    expect(content).not.toContain(`node "${firstCli}" %*`);
  });

  test('creates the parent .vibecode/bin directory when missing', () => {
    const repo = mkTmp();
    const appCli = path.join(repo, 'bin', 'vibecode.js');
    const binDir = path.join(repo, '.vibecode', 'bin');
    expect(fs.existsSync(binDir)).toBe(false);

    writeVibecodeCliShim({ repoPath: repo, appCliPath: appCli, platform: 'win32' });

    expect(fs.statSync(binDir).isDirectory()).toBe(true);
  });

  test('generated shim path stays under <repo>/.vibecode/bin', () => {
    const repo = mkTmp();
    const appCli = path.join(repo, 'bin', 'vibecode.js');

    const result = writeVibecodeCliShim({ repoPath: repo, appCliPath: appCli, platform: 'win32' });

    expect(result.windowsShimPath).toBe(path.join(repo, '.vibecode', 'bin', 'vibecode.cmd'));
    expect(shimBinDir(repo)).toBe(path.join(repo, '.vibecode', 'bin'));
    expect(shimEntryPath(repo, 'win32')).toBe(path.join(repo, '.vibecode', 'bin', 'vibecode.cmd'));
  });

  test('on posix writes a vibecode shell script', () => {
    const repo = mkTmp();
    const appCli = path.join(repo, 'bin', 'vibecode.js');

    const result = writeVibecodeCliShim({ repoPath: repo, appCliPath: appCli, platform: 'linux' });

    const posixShim = path.join(repo, '.vibecode', 'bin', 'vibecode');
    expect(result.posixShimPath).toBe(posixShim);
    const content = fs.readFileSync(posixShim, 'utf8');
    expect(content).toContain('#!/usr/bin/env sh');
    expect(content).toContain(`exec node "${appCli}" "$@"`);
  });
});

describe('cli_shim — buildTerminalEnv', () => {
  test('prepends <repo>/.vibecode/bin to PATH on windows (Path key)', () => {
    const repo = mkTmp();
    const baseEnv: Record<string, string> = { Path: 'C:\\Users\\Martin\\AppData\\Local\\Programs\\Python\\Python312\\Scripts;C:\\Windows' };

    const env = buildTerminalEnv({
      repoPath: repo,
      appCliPath: path.join(repo, 'bin', 'vibecode.js'),
      platform: 'win32',
      baseEnv,
    });

    const expectedShim = path.join(repo, '.vibecode', 'bin');
    expect(env.Path).toBeDefined();
    expect(env.Path!.startsWith(expectedShim + path.delimiter)).toBe(true);
  });

  test('preserves existing PATH entries after the shim path', () => {
    const repo = mkTmp();
    const original = 'C:\\Windows;C:\\Tools';
    const env = buildTerminalEnv({
      repoPath: repo,
      appCliPath: path.join(repo, 'bin', 'vibecode.js'),
      platform: 'win32',
      baseEnv: { Path: original },
    });

    const expectedShim = path.join(repo, '.vibecode', 'bin');
    expect(env.Path).toBe(`${expectedShim}${path.delimiter}${original}`);
  });

  test('does not duplicate shim path if PATH already starts with it', () => {
    const repo = mkTmp();
    const expectedShim = path.join(repo, '.vibecode', 'bin');
    const original = `${expectedShim}${path.delimiter}C:\\Windows`;

    const env = buildTerminalEnv({
      repoPath: repo,
      appCliPath: path.join(repo, 'bin', 'vibecode.js'),
      platform: 'win32',
      baseEnv: { Path: original },
    });

    expect(env.Path).toBe(original);
  });

  test('does not duplicate shim path if PATH already contains it later', () => {
    const repo = mkTmp();
    const expectedShim = path.join(repo, '.vibecode', 'bin');
    const original = `C:\\Windows${path.delimiter}${expectedShim}${path.delimiter}C:\\Tools`;

    const env = buildTerminalEnv({
      repoPath: repo,
      appCliPath: path.join(repo, 'bin', 'vibecode.js'),
      platform: 'win32',
      baseEnv: { Path: original },
    });

    const segments = env.Path!.split(path.delimiter);
    const occurrences = segments.filter((s) => s === expectedShim).length;
    expect(occurrences).toBe(1);
    expect(segments[0]).toBe(expectedShim);
  });

  test('sets VIBECODE_REPO and VIBECODE_APP_CLI and VIBECODE_CLI_SHIM', () => {
    const repo = mkTmp();
    const appCli = path.join(repo, 'bin', 'vibecode.js');
    const env = buildTerminalEnv({
      repoPath: repo,
      appCliPath: appCli,
      platform: 'win32',
      baseEnv: { Path: 'C:\\Windows' },
    });

    expect(env.VIBECODE_REPO).toBe(repo);
    expect(env.VIBECODE_APP_CLI).toBe(appCli);
    expect(env.VIBECODE_CLI_SHIM).toBe(path.join(repo, '.vibecode', 'bin', 'vibecode.cmd'));
  });

  test('uppercase PATH variant is used when only PATH (not Path) is set', () => {
    const repo = mkTmp();
    const env = buildTerminalEnv({
      repoPath: repo,
      appCliPath: path.join(repo, 'bin', 'vibecode.js'),
      platform: 'win32',
      baseEnv: { PATH: 'C:\\Windows' },
    });

    const expectedShim = path.join(repo, '.vibecode', 'bin');
    expect(env.PATH).toBe(`${expectedShim}${path.delimiter}C:\\Windows`);
  });

  test('on posix prepends to PATH', () => {
    const repo = mkTmp();
    const env = buildTerminalEnv({
      repoPath: repo,
      appCliPath: path.join(repo, 'bin', 'vibecode.js'),
      platform: 'linux',
      baseEnv: { PATH: '/usr/bin:/bin' },
    });

    const expectedShim = path.join(repo, '.vibecode', 'bin');
    expect(env.PATH!.startsWith(expectedShim + path.delimiter)).toBe(true);
    expect(env.VIBECODE_CLI_SHIM).toBe(path.join(repo, '.vibecode', 'bin', 'vibecode'));
  });
});

describe('cli_shim — prepareVibecodeCliShim integration', () => {
  test('writes shim and returns env that prepends shim bin to PATH', () => {
    const repo = mkTmp();
    const appCli = path.join(repo, 'bin', 'vibecode.js');

    const { env, shimPaths } = prepareVibecodeCliShim({
      repoPath: repo,
      appCliPath: appCli,
      platform: 'win32',
      baseEnv: { Path: 'C:\\Windows' },
    });

    const expectedShim = path.join(repo, '.vibecode', 'bin');
    expect(fs.existsSync(path.join(expectedShim, 'vibecode.cmd'))).toBe(true);
    expect(env.Path!.startsWith(expectedShim + path.delimiter)).toBe(true);
    expect(shimPaths.windowsShimPath).toBe(path.join(expectedShim, 'vibecode.cmd'));
  });
});
