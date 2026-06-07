/**
 * Tests for the platform-aware marker command builder.
 *
 * Protected invariant:
 * - Windows platforms must produce Write-Output commands.
 * - POSIX platforms (linux/darwin) must produce printf commands.
 * - The marker value is preserved in the generated command.
 * - Special characters in markers are escaped for shell safety.
 * - git marker command uses ; to avoid timeouts when git status fails.
 */
import { describe, expect, test } from 'vitest';

import {
  buildMarkerCommand,
  buildGitStatusCommand,
  platformEchoMarker,
} from '../../../src/core/terminal/platform.js';

describe('platform marker commands', () => {
  describe('buildMarkerCommand', () => {
    test('win32 produces Write-Output command', () => {
      const cmd = buildMarkerCommand('VIBECODE_OK', 'win32');
      expect(cmd).toBe('Write-Output "VIBECODE_OK"');
    });

    test('linux produces printf command', () => {
      const cmd = buildMarkerCommand('VIBECODE_OK', 'linux');
      expect(cmd).toBe('printf "VIBECODE_OK\\n"');
    });

    test('darwin produces printf command', () => {
      const cmd = buildMarkerCommand('VIBECODE_OK', 'darwin');
      expect(cmd).toBe('printf "VIBECODE_OK\\n"');
    });

    test('marker value is preserved in the output', () => {
      const marker = 'MY_UNIQUE_MARKER_42';
      const winCmd = buildMarkerCommand(marker, 'win32');
      const linuxCmd = buildMarkerCommand(marker, 'linux');

      expect(winCmd).toContain(marker);
      expect(linuxCmd).toContain(marker);
    });

    test('marker with special characters is escaped on posix', () => {
      const marker = 'hello"world';
      const linuxCmd = buildMarkerCommand(marker, 'linux');
      expect(linuxCmd).toContain('\\"');
      expect(linuxCmd).not.toContain('"hello"world');
    });

    test('marker with dollar sign is escaped on posix', () => {
      const marker = 'test$value';
      const linuxCmd = buildMarkerCommand(marker, 'linux');
      expect(linuxCmd).toContain('\\$');
    });

    test('marker with backtick is escaped on posix', () => {
      const marker = 'test`value';
      const linuxCmd = buildMarkerCommand(marker, 'linux');
      expect(linuxCmd).toContain('\\`');
      expect(linuxCmd).toMatch(/test\\`value/);
    });

    test('marker with backslash is escaped on posix', () => {
      const marker = 'test\\value';
      const linuxCmd = buildMarkerCommand(marker, 'linux');
      expect(linuxCmd).toContain('\\\\');
    });

    test('marker with double quote is escaped on win32', () => {
      const marker = 'test"value';
      const winCmd = buildMarkerCommand(marker, 'win32');
      expect(winCmd).toContain('``"');
    });

    test('defaults to process.platform when platform not provided', () => {
      const cmd = buildMarkerCommand('VIBECODE_OK');
      expect(typeof cmd).toBe('string');
      expect(cmd.length).toBeGreaterThan(0);
    });
  });

  describe('buildGitStatusCommand', () => {
    test('win32 uses semicolon to chain commands', () => {
      const cmd = buildGitStatusCommand('GIT_MARKER', 'win32');
      expect(cmd).toContain(';');
      expect(cmd).toContain('Write-Output');
      expect(cmd).toContain('git status --short');
    });

    test('linux uses semicolon to avoid timeout when git status fails', () => {
      const cmd = buildGitStatusCommand('GIT_MARKER', 'linux');
      expect(cmd).toContain(';');
      expect(cmd).toContain('printf');
      expect(cmd).toContain('git status --short');
    });
  });

  describe('platformEchoMarker', () => {
    test('win32 returns Write-Output variant', () => {
      const marker = platformEchoMarker('win32');
      expect(marker.command).toContain('Write-Output');
      expect(marker.command).toContain(marker.marker);
      expect(marker.newline).toBe('\r');
    });

    test('linux returns printf variant with LF newline', () => {
      const marker = platformEchoMarker('linux');
      expect(marker.command).toContain('printf');
      expect(marker.command).toContain(marker.marker);
      expect(marker.newline).toBe('\n');
    });

    test('win32 marker with double quote uses buildMarkerCommand escaping', () => {
      const marker = platformEchoMarker('win32');
      const cmd = marker.command;
      expect(cmd).toBe(buildMarkerCommand(marker.marker, 'win32'));
    });

    test('linux marker with double quote uses buildMarkerCommand escaping', () => {
      const marker = platformEchoMarker('linux');
      const cmd = marker.command;
      expect(cmd).toBe(buildMarkerCommand(marker.marker, 'linux'));
    });
  });
});
