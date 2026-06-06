/**
 * Real-PTY integration gate.
 *
 * node-pty spawns real Windows ConPTY sessions. When such a session is killed,
 * node-pty (1.1.0) forks its vendored `conpty_console_list_agent` child, which
 * calls the native `getConsoleProcessList` -> Windows `AttachConsole`. On
 * Node >= 24 under Windows that call throws "AttachConsole failed" as an
 * UNCAUGHT exception inside the forked child, crashing it. These unmanaged
 * child-process crashes pollute stderr and can intermittently take down vitest
 * workers, so the full default suite stops completing reliably.
 *
 * The crash lives in vendored Microsoft code we cannot patch in node_modules,
 * and it is not a bug in our PTY adapter. Per the project testing policy
 * (default tests use mocks; live/environment-dependent tests are explicit only,
 * cf. `pnpm test:live`), real-PTY tests are opt-in. The default suite keeps full
 * mock-based PTY coverage; the real-PTY smoke tests run on demand via
 * `pnpm test:pty`, which sets VIBECODE_PTY_INTEGRATION=1.
 */
export const PTY_INTEGRATION_ENV = 'VIBECODE_PTY_INTEGRATION';

function defaultNodePtyLoads(): boolean {
  try {
    require('node-pty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Real-PTY integration runs only when the operator explicitly opts in AND
 * node-pty can actually be loaded in this environment.
 */
export function isPtyIntegrationEnabled(
  env: NodeJS.ProcessEnv = process.env,
  nodePtyLoads: () => boolean = defaultNodePtyLoads,
): boolean {
  return Boolean(env[PTY_INTEGRATION_ENV]) && nodePtyLoads();
}

export const ptyIntegrationEnabled: boolean = isPtyIntegrationEnabled();
