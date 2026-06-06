import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildClaudeSpawnInvocation } from '../../../src/core/mcp/claude_config.js';

/**
 * Problem 1 — Windows Claude shim resolution.
 *
 * On Windows the `claude` CLI installs as `claude.cmd`. Node (post the Windows
 * batch CVE fix) refuses to run a `.cmd`/`.bat` with `shell:false` (EINVAL),
 * and `shell:true` corrupts the JSON argument that `claude mcp add-json` needs
 * (it is concatenated, not escaped). buildClaudeSpawnInvocation resolves the
 * executable and routes `.cmd`/`.bat` shims through `cmd.exe /d /s /c` with
 * verbatim arguments and explicit quoting, never enabling a shell.
 */

const JSON_ARG = JSON.stringify({
  type: 'stdio',
  command: 'node',
  args: ['a b', '--repo', 'C:/x'],
});
const REAL_ARGS = ['mcp', 'add-json', 'vibecode', JSON_ARG, '--scope', 'local'];

describe('buildClaudeSpawnInvocation', () => {
  test('posix: spawns the bare command with argv unchanged and no shell', () => {
    const inv = buildClaudeSpawnInvocation({ command: 'claude', args: ['mcp', 'list'], platform: 'linux' });
    expect(inv.file).toBe('claude');
    expect(inv.args).toEqual(['mcp', 'list']);
    expect(inv.shell).toBe(false);
    expect(inv.windowsVerbatimArguments).toBe(false);
  });

  test('win32 + .cmd shim: routes through cmd.exe with verbatim args and keeps the JSON arg intact', () => {
    const inv = buildClaudeSpawnInvocation({
      command: 'claude',
      args: REAL_ARGS,
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      resolveExecutable: () => 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd',
    });

    expect(inv.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(inv.shell).toBe(false);
    expect(inv.windowsVerbatimArguments).toBe(true);

    // Exactly one verbatim command-line string follows the cmd flags.
    expect(inv.args).toHaveLength(4);
    const line = inv.args[3];
    // The resolved shim, not the bare 'claude', is invoked.
    expect(line).toContain('claude.cmd');
    expect(line).toContain('add-json');
    // The JSON survives as a single doubled-quote token (cmd verbatim quoting),
    // proving it was NOT split on its internal spaces/quotes.
    expect(line).toContain('""type"":""stdio""');
    expect(line).toContain('""a b""');
  });

  test('win32 + .exe: spawns the resolved exe directly with argv unchanged and no shell', () => {
    const inv = buildClaudeSpawnInvocation({
      command: 'claude',
      args: ['--version'],
      platform: 'win32',
      resolveExecutable: () => 'C:\\tools\\claude.exe',
    });
    expect(inv.file).toBe('C:\\tools\\claude.exe');
    expect(inv.args).toEqual(['--version']);
    expect(inv.shell).toBe(false);
    expect(inv.windowsVerbatimArguments).toBe(false);
  });

  test('win32 + unresolved: falls back to the bare command so spawn surfaces a clean ENOENT', () => {
    const inv = buildClaudeSpawnInvocation({
      command: 'claude',
      args: ['--version'],
      platform: 'win32',
      resolveExecutable: () => null,
    });
    expect(inv.file).toBe('claude');
    expect(inv.args).toEqual(['--version']);
    expect(inv.shell).toBe(false);
  });

  test('never enables shell:true on any platform (no shell injection surface)', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const inv = buildClaudeSpawnInvocation({
        command: 'claude',
        args: REAL_ARGS,
        platform,
        resolveExecutable: () => 'C:\\x\\claude.cmd',
      });
      // shell is always false; args remain a real array, never a concatenated
      // shell string handed to a shell interpreter.
      expect(inv.shell).toBe(false);
      expect(Array.isArray(inv.args)).toBe(true);
    }
  });
});

describe('buildClaudeSpawnInvocation end-to-end through a real .cmd shim', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-claude-spawn-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test.skipIf(process.platform !== 'win32')(
    'a .cmd shim (node cli %*) receives the exact argv including the JSON payload',
    () => {
      const dumpPath = path.join(dir, 'dump.js');
      fs.writeFileSync(dumpPath, 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
      const cmdPath = path.join(dir, 'claude.cmd');
      fs.writeFileSync(cmdPath, '@echo off\r\nnode "%~dp0dump.js" %*\r\n', 'utf8');

      const inv = buildClaudeSpawnInvocation({
        command: 'claude',
        args: REAL_ARGS,
        platform: 'win32',
        resolveExecutable: () => cmdPath,
      });

      const result = spawnSync(inv.file, inv.args, {
        encoding: 'utf8',
        shell: inv.shell,
        windowsVerbatimArguments: inv.windowsVerbatimArguments,
        windowsHide: true,
      });

      expect(result.status).toBe(0);
      const received = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() as string);
      expect(received).toEqual(REAL_ARGS);
    },
  );
});
