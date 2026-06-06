import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

import {
  PTY_INTEGRATION_ENV,
  isPtyIntegrationEnabled,
  ptyIntegrationEnabled,
} from '../setup/pty_integration.js';

const repoRoot = path.resolve(__dirname, '../..');

// Test files that drive a real Windows ConPTY session through node-pty. On
// Node >= 24 under Windows, node-pty's vendored `conpty_console_list_agent`
// child crashes with "AttachConsole failed" when a ConPTY session is killed,
// which pollutes stderr and can intermittently take down vitest workers. These
// files must therefore be opt-in (see tests/setup/pty_integration.ts).
const realPtyTestFiles = [
  'tests/integration/terminal_demo.test.ts',
  'tests/integration/terminal_demo_clean.test.ts',
];

function read(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

describe('Real-PTY integration gating', () => {
  test('the default test suite does not opt in to real PTY', () => {
    // The default `vitest run` must never spawn real ConPTY sessions.
    expect(ptyIntegrationEnabled).toBe(false);
    expect(process.env[PTY_INTEGRATION_ENV]).toBeFalsy();
  });

  test('opt-in requires both the env flag and a loadable node-pty', () => {
    expect(isPtyIntegrationEnabled({}, () => true)).toBe(false);
    expect(isPtyIntegrationEnabled({ [PTY_INTEGRATION_ENV]: '1' }, () => true)).toBe(true);
    // Even with the flag set, an unloadable node-pty keeps integration off.
    expect(isPtyIntegrationEnabled({ [PTY_INTEGRATION_ENV]: '1' }, () => false)).toBe(false);
  });

  test('real-PTY test files gate on the shared opt-in flag, not bare availability', () => {
    for (const relPath of realPtyTestFiles) {
      const source = read(relPath);
      expect(source).toContain('ptyIntegrationEnabled');
      // No real-PTY describe block may run just because node-pty is installed.
      expect(source).not.toMatch(/skipIf\(!ptyAvailable\)/);
    }
  });

  test('an opt-in test:pty script exists and its runner sets the env flag', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['test:pty']).toBeTruthy();
    expect(pkg.scripts?.['test:pty']).toContain('test_pty.mjs');

    const runner = read('scripts/test_pty.mjs');
    expect(runner).toContain(PTY_INTEGRATION_ENV);
  });
});
