// Opt-in runner for the real-PTY (ConPTY) integration tests.
//
// These tests spawn real Windows ConPTY sessions and are gated out of the
// default `pnpm test` suite because node-pty's vendored console-list agent
// crashes ("AttachConsole failed") on Node >= 24 under Windows, which can take
// down vitest workers. See tests/setup/pty_integration.ts for the full reason.
//
// Run with: pnpm test:pty
import { spawnSync } from 'node:child_process';

process.env.VIBECODE_PTY_INTEGRATION = '1';

const result = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    'tests/integration/terminal_demo.test.ts',
    'tests/integration/terminal_demo_clean.test.ts',
  ],
  { stdio: 'inherit', shell: true },
);

process.exit(result.status ?? 1);
