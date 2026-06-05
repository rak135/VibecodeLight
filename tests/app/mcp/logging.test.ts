import fs from 'fs';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  MCP_TOOL_USAGE_LOG_RELATIVE_PATH,
  appendMcpToolUsage,
  buildMcpToolUsageEvent,
  createVibecodeMcpServer,
  resolveMcpToolUsageLogPath,
} from '../../../src/app/mcp/index.js';

function makeRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
  return repo;
}

describe('mcp_tool_usage.jsonl logging', () => {
  test('resolveMcpToolUsageLogPath places the log under .vibecode/logs/', () => {
    const repoRoot = '/tmp/abc';
    expect(resolveMcpToolUsageLogPath(repoRoot)).toBe(path.join(repoRoot, MCP_TOOL_USAGE_LOG_RELATIVE_PATH));
  });

  test('appendMcpToolUsage writes a single JSONL row containing only safe fields', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-log-'));
    try {
      const event = buildMcpToolUsageEvent({
        tool: 'vibecode_codegraph_status',
        repoRoot,
        requestId: 'req-1',
        inputSummary: { query_bytes: 4 },
        ok: true,
        durationMs: 42,
        warnings: [],
        error: null,
        outputBytes: 128,
        truncated: false,
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      const write = appendMcpToolUsage(repoRoot, event);
      expect(write.written).toBe(true);
      const text = fs.readFileSync(write.path, 'utf8').trim();
      const parsed = JSON.parse(text);
      expect(parsed.schema_version).toBe(1);
      expect(parsed.tool).toBe('vibecode_codegraph_status');
      expect(parsed.transport).toBe('stdio');
      expect(parsed.repo_root).toBe(repoRoot);
      expect(parsed.duration_ms).toBe(42);
      expect(parsed.request_id).toBe('req-1');
      // Forbidden: raw stdout/stderr, env values, API keys
      expect(parsed).not.toHaveProperty('stdout');
      expect(parsed).not.toHaveProperty('stderr');
      expect(parsed).not.toHaveProperty('env');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('appendMcpToolUsage returns a warning when the log path cannot be written', () => {
    // Use a path that cannot be created (a file where a directory is expected).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-log-bad-'));
    try {
      const repoRoot = path.join(tmpDir, 'repo-file');
      fs.writeFileSync(repoRoot, 'not a dir', 'utf8'); // log path resolves under this file
      const event = buildMcpToolUsageEvent({
        tool: 'vibecode_codegraph_status',
        repoRoot,
        requestId: null,
        inputSummary: {},
        ok: true,
        durationMs: 0,
        warnings: [],
        error: null,
        outputBytes: 0,
        truncated: false,
      });
      const write = appendMcpToolUsage(repoRoot, event);
      expect(write.written).toBe(false);
      expect(write.warnings.length).toBeGreaterThan(0);
      expect(write.warnings[0]).toMatch(/MCP_TOOL_USAGE_LOG_WRITE_FAILED/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('an MCP tool call appends a row to .vibecode/logs/mcp_tool_usage.jsonl', async () => {
    const repoRoot = makeRepo('vibecode-mcp-log-call-');
    try {
      const handle = createVibecodeMcpServer({ context: { repoRoot }, logLevel: 'silent' });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await handle.connect(serverT);
      const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
      await client.connect(clientT);
      try {
        // Unsupported tool → server still logs the call (ok=false, code=UNSUPPORTED_TOOL).
        await client.callTool({ name: 'no_such_tool', arguments: {} });
      } finally {
        await client.close();
        await handle.close();
      }
      const logPath = resolveMcpToolUsageLogPath(repoRoot);
      expect(fs.existsSync(logPath)).toBe(true);
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]);
      expect(last.tool).toBe('no_such_tool');
      expect(last.ok).toBe(false);
      expect(last.error?.code).toBe('UNSUPPORTED_TOOL');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
