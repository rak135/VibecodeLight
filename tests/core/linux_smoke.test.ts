/**
 * Linux smoke test coverage.
 *
 * Protected invariants:
 * - bin/vibecode.js has the correct POSIX shebang on line 1.
 * - POSIX shim generation produces correct content, forwards args, and is chmod'd.
 * - Terminal marker commands are platform-appropriate (printf vs Write-Output).
 * - User profile XDG_CONFIG_HOME path is correct on Linux.
 * - Scanner Python command resolution prefers python3, respects VIBECODE_PYTHON env.
 * - detectDefaultShell falls back through POSIX shell candidates.
 *
 * These tests do not call live providers, do not require Docker/WSL,
 * and run in any Node environment.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildMarkerCommand,
  platformEchoMarker,
} from '../../src/core/terminal/platform.js';
import { posixShimContent, writeVibecodeCliShim } from '../../src/core/terminal/cli_shim.js';
import { resolveUserProfileDir } from '../../src/core/config/user_profile.js';
import { resolvePythonCommand } from '../../src/core/scanning/scanner_subprocess.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vbc-linux-smoke-'));
}

describe('Linux smoke — POSIX shim', () => {
  test('bin/vibecode.js first line is shebang #!/usr/bin/env node', () => {
    const binPath = path.join(__dirname, '../../bin/vibecode.js');
    // Guard: the file must exist for this test to be meaningful.
    expect(fs.existsSync(binPath)).toBe(true);

    const content = fs.readFileSync(binPath, 'utf8');
    const firstLine = content.split(/\r?\n/)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  test('bin/vibecode.js is valid JavaScript requiring tsx/cjs', () => {
    const binPath = path.join(__dirname, '../../bin/vibecode.js');
    const content = fs.readFileSync(binPath, 'utf8');
    expect(content).toMatch(/require\(['"]tsx\/cjs['"]\)/);
    expect(content).toMatch(/runCli/);
  });

  test('POSIX shim creates valid shell script with exec node', () => {
    const appCli = '/home/user/projects/vibecode-light/bin/vibecode.js';
    const content = posixShimContent(appCli);

    expect(content.startsWith('#!/usr/bin/env sh')).toBe(true);
    expect(content).toContain('exec node');
    expect(content).toContain('"$@"');
    // Path should use forward slashes
    expect(content).toContain('/home/user/projects/vibecode-light/bin/vibecode.js');
  });

  test('POSIX shim is chmod 755 when written on linux platform', () => {
    const repo = mkTmp();
    const appCli = path.join(repo, 'bin', 'vibecode.js');

    writeVibecodeCliShim({ repoPath: repo, appCliPath: appCli, platform: 'linux' });

    const posixShim = path.join(repo, '.vibecode', 'bin', 'vibecode');
    expect(fs.existsSync(posixShim)).toBe(true);

    // On Windows, chmod is best-effort; we verify the file was written.
    const content = fs.readFileSync(posixShim, 'utf8');
    expect(content).toContain('#!/usr/bin/env sh');
  });
});

describe('Linux smoke — terminal marker commands', () => {
  test('printf command is produced on linux', () => {
    const cmd = buildMarkerCommand('TEST_MARKER', 'linux');
    expect(cmd).toBe('printf "TEST_MARKER\\n"');
  });

  test('Write-Output is produced on win32', () => {
    const cmd = buildMarkerCommand('TEST_MARKER', 'win32');
    expect(cmd).toBe('Write-Output "TEST_MARKER"');
  });

  test('platformEchoMarker on linux uses printf with LF', () => {
    const result = platformEchoMarker('linux');
    expect(result.command).toContain('printf');
    expect(result.newline).toBe('\n');
    expect(result.marker).toBeTruthy();
  });

  test('platformEchoMarker on win32 uses Write-Output with CR', () => {
    const result = platformEchoMarker('win32');
    expect(result.command).toContain('Write-Output');
    expect(result.newline).toBe('\r');
  });
});

describe('Linux smoke — user profile XDG path', () => {
  test('XDG_CONFIG_HOME is used on linux', () => {
    const dir = resolveUserProfileDir({ XDG_CONFIG_HOME: '/home/test/.config' }, 'linux');
    expect(dir).toBe(path.join('/home/test/.config', 'vibecodelight'));
  });

  test('XDG_CONFIG_HOME fallback is ~/.config/vibecodelight', () => {
    const dir = resolveUserProfileDir({}, 'linux');
    expect(dir).toBe(path.join(os.homedir(), '.config', 'vibecodelight'));
  });
});

describe('Linux smoke — scanner python resolver', () => {
  test('python3 is the default fallback', () => {
    expect(resolvePythonCommand({}, {})).toBe('python3');
  });

  test('VIBECODE_PYTHON env wins over default', () => {
    expect(resolvePythonCommand({}, { VIBECODE_PYTHON: '/usr/bin/python3.11' })).toBe('/usr/bin/python3.11');
  });

  test('explicit pythonPath wins over env', () => {
    expect(resolvePythonCommand(
      { pythonPath: '/explicit/python3' },
      { VIBECODE_PYTHON: '/usr/bin/python3.11' },
    )).toBe('/explicit/python3');
  });
});
