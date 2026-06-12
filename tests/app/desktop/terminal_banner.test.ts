import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { PtySession, PtySessionOptions } from '../../../src/adapters/pty/index.js';
import { TERMINAL_AGENT_BANNER_ENV } from '../../../src/core/agent_guidance/terminal_protocol.js';

type FakePtySession = PtySession & {
  shell: string;
  writes: string[];
  dataHandlers: Array<(data: string) => void>;
  exitHandlers: Array<(code: number | undefined) => void>;
  closed: boolean;
  emitData(data: string): void;
};

let nextPid = 7100;
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
    emitData(data: string) {
      for (const handler of this.dataHandlers) handler(data);
    },
  };
}

/**
 * Phase 1B-4: the desktop terminal service attaches a one-time agent protocol
 * banner to a new session. The banner is DISPLAY guidance only — it travels in
 * the session metadata so the renderer can print it to the xterm display; it is
 * never written into the PTY (shell stdin). These tests pin: banner present once
 * per session, no PTY injection, opt-out, and that shim/env preparation is
 * untouched.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('desktop terminal protocol banner', () => {
  test('a new session carries the protocol banner in its metadata', async () => {
    const fakePty = createFakePty();
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const service = new DesktopTerminalService(
      vi.fn((_options?: PtySessionOptions) => fakePty),
      { prepareTerminalEnv: null, terminalPreflight: null },
    );

    const meta = service.startSession(process.cwd(), 80, 24);

    expect(typeof meta.banner).toBe('string');
    expect(meta.banner).toContain(
      'vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json',
    );
    expect(meta.banner).toContain('vibecode_session_start');
    expect(meta.banner).toContain('vibecode_workspace_snapshot');
    // DISPLAY-only: the banner must never be written into the PTY.
    expect(fakePty.writes).toEqual([]);
  });

  test('the banner is provided exactly once per session and not on later output', async () => {
    const fakePty = createFakePty();
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const onData = vi.fn();
    const service = new DesktopTerminalService(
      vi.fn((_options?: PtySessionOptions) => fakePty),
      { prepareTerminalEnv: null, terminalPreflight: null },
    );
    service.onData(onData);

    const meta = service.startSession(process.cwd(), 80, 24);
    fakePty.emitData('some shell output');
    fakePty.emitData('more output');

    // Banner is carried once in the start metadata; ordinary PTY output never
    // contains it and never round-trips into the shell.
    expect(meta.banner).toBeDefined();
    for (const call of onData.mock.calls) {
      expect(call[1]).not.toContain('Vibecode agent protocol');
    }
    expect(fakePty.writes).toEqual([]);
  });

  test('opt-out via constructor (agentBanner: null) yields no banner', async () => {
    const fakePty = createFakePty();
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const service = new DesktopTerminalService(
      vi.fn((_options?: PtySessionOptions) => fakePty),
      { prepareTerminalEnv: null, terminalPreflight: null, agentBanner: null },
    );

    const meta = service.startSession(process.cwd(), 80, 24);
    expect(meta.banner).toBeUndefined();
    expect(fakePty.writes).toEqual([]);
  });

  test(`opt-out via ${TERMINAL_AGENT_BANNER_ENV}=0 yields no banner`, async () => {
    vi.stubEnv(TERMINAL_AGENT_BANNER_ENV, '0');
    const fakePty = createFakePty();
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const service = new DesktopTerminalService(
      vi.fn((_options?: PtySessionOptions) => fakePty),
      { prepareTerminalEnv: null, terminalPreflight: null },
    );

    const meta = service.startSession(process.cwd(), 80, 24);
    expect(meta.banner).toBeUndefined();
  });

  test('a custom banner provider is used verbatim and receives the cwd', async () => {
    const fakePty = createFakePty();
    const provider = vi.fn((_repoPath: string) => 'CUSTOM BANNER');
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const service = new DesktopTerminalService(
      vi.fn((_options?: PtySessionOptions) => fakePty),
      { prepareTerminalEnv: null, terminalPreflight: null, agentBanner: provider },
    );

    const meta = service.startSession(process.cwd(), 80, 24);
    expect(meta.banner).toBe('CUSTOM BANNER');
    expect(provider).toHaveBeenCalledWith(path.resolve(process.cwd()));
  });

  test('banner does not disturb shim env preparation', async () => {
    const fakePty = createFakePty();
    const factory = vi.fn((_options?: PtySessionOptions) => fakePty);
    const { DesktopTerminalService } = await import('../../../src/app/desktop/terminal_bridge.js');
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vbc-banner-env-'));
    try {
      // Default env preparer + default banner together.
      const service = new DesktopTerminalService(factory, { terminalPreflight: null });
      const meta = service.startSession(repoPath, 80, 24);

      const callOptions = factory.mock.calls[0][0] as { env?: Record<string, string> };
      expect(callOptions.env).toBeDefined();
      const pathKey = callOptions.env!.Path !== undefined ? 'Path' : 'PATH';
      const expectedShim = path.join(repoPath, '.vibecode', 'bin');
      expect(
        callOptions.env![pathKey]!.startsWith(expectedShim + path.delimiter) ||
          callOptions.env![pathKey] === expectedShim,
      ).toBe(true);
      // Banner still rides along, PTY still clean.
      expect(typeof meta.banner).toBe('string');
      expect(fakePty.writes).toEqual([]);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
