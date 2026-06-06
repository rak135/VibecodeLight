import fs from 'fs';
import os from 'os';
import path from 'path';

import type { PtySession, PtySessionOptions } from '../../../src/adapters/pty/index.js';
import type { TerminalAgentPreflightResult } from '../../../src/core/agent_guidance/terminal_agent_preflight.js';

type FakePtySession = PtySession & {
  shell: string;
  writes: string[];
  dataHandlers: Array<(data: string) => void>;
  exitHandlers: Array<(code: number | undefined) => void>;
  closed: boolean;
};

let nextPid = 6200;
function createFakePty(): FakePtySession {
  return {
    pid: nextPid++,
    shell: 'pwsh',
    writes: [],
    dataHandlers: [],
    exitHandlers: [],
    closed: false,
    get isClosed() {
      return this.closed;
    },
    write(data: string) {
      this.writes.push(data);
    },
    resize() {},
    close() {
      this.closed = true;
    },
    onData(handler: (data: string) => void) {
      this.dataHandlers.push(handler);
    },
    onExit(handler: (code: number | undefined) => void) {
      this.exitHandlers.push(handler);
    },
  };
}

function okResult(repoRoot: string): TerminalAgentPreflightResult {
  return {
    ok: true,
    mode: 'check_only',
    repo_root: repoRoot,
    config_path: 'C:/AppData/vibecodelight/agent-guidance-config.yaml',
    guidance_hash: 'a'.repeat(64),
    agents: [
      { agent: 'codex', configured: false, stale: false, repaired: false, warnings: [], errors: [] },
    ],
    warnings: [],
    errors: [],
    no_pty_injection: true,
  };
}

describe('desktop terminal agent preflight integration', () => {
  test('opening a new terminal triggers preflight with the selected repo root', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-term-preflight-repo-'));
    try {
      const fakePty = createFakePty();
      const preflight = vi.fn(async (root: string) => okResult(root));
      const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
      const service = new DesktopTerminalService(
        vi.fn((_options?: PtySessionOptions) => fakePty),
        { prepareTerminalEnv: null, terminalPreflight: preflight },
      );

      const meta = service.startSession(repoRoot, 80, 24);
      await vi.waitFor(() => expect(preflight).toHaveBeenCalledWith(path.resolve(repoRoot)));

      expect(meta.cwd).toBe(path.resolve(repoRoot));
      expect(fakePty.writes).toEqual([]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('terminal still opens when preflight fails', async () => {
    const fakePty = createFakePty();
    const preflight = vi.fn(async () => {
      throw new Error('preflight failed');
    });
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const service = new DesktopTerminalService(
      vi.fn((_options?: PtySessionOptions) => fakePty),
      { prepareTerminalEnv: null, terminalPreflight: preflight },
    );

    const meta = service.startSession(process.cwd(), 100, 30);
    expect(meta.sessionId).toMatch(/^desktop-/);
    expect(service.getSession(meta.sessionId)).toBeDefined();
    await vi.waitFor(() => expect(preflight).toHaveBeenCalled());
    expect(fakePty.writes).toEqual([]);
  });

  test('preflight result is exposed as status event without starting codex or claude', async () => {
    const fakePty = createFakePty();
    const results: Array<{ sessionId: string; result: TerminalAgentPreflightResult }> = [];
    const preflight = vi.fn(async (root: string) => okResult(root));
    const factory = vi.fn((_options?: PtySessionOptions) => fakePty);
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const service = new DesktopTerminalService(factory, { prepareTerminalEnv: null, terminalPreflight: preflight });
    service.onPreflightResult((sessionId, result) => results.push({ sessionId, result }));

    const meta = service.startSession(process.cwd(), 80, 24);
    await vi.waitFor(() => expect(results.length).toBe(1));

    expect(results[0]).toMatchObject({ sessionId: meta.sessionId, result: { no_pty_injection: true } });
    expect(fakePty.writes).toEqual([]);
    expect(JSON.stringify(factory.mock.calls)).not.toMatch(/codex|claude/i);
  });

  test('repeated terminal opens run preflight each time', async () => {
    const ptyA = createFakePty();
    const ptyB = createFakePty();
    let i = 0;
    const preflight = vi.fn(async (root: string) => okResult(root));
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const service = new DesktopTerminalService(
      vi.fn((_options?: PtySessionOptions) => (i++ === 0 ? ptyA : ptyB)),
      { prepareTerminalEnv: null, terminalPreflight: preflight },
    );

    service.startSession(process.cwd(), 80, 24);
    service.startSession(process.cwd(), 80, 24);

    await vi.waitFor(() => expect(preflight).toHaveBeenCalledTimes(2));
    expect(ptyA.writes).toEqual([]);
    expect(ptyB.writes).toEqual([]);
  });
});
