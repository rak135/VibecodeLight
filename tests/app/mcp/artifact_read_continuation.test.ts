import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildArtifactReadTool } from '../../../src/app/mcp/tools/artifact_read.js';
import { HARD_MAX_ARTIFACT_CHUNK_BYTES } from '../../../src/core/runs/artifact_pagination.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

/**
 * Phase 1B-1: MCP `vibecode_artifact_read` continuation behavior.
 *
 * These tests pin the agent-facing continuation contract on the MCP surface:
 * byte-offset paging, complete structured metadata (even when the bounded text
 * block is truncated), a continuation hint in the text, and rejection of invalid
 * offsets / max_bytes. Backward-compat (single-call reads) is covered by
 * runs_tools.test.ts; here we focus on the new fields and chaining.
 */

interface ArtifactReadData {
  run_id: string;
  artifact: string;
  relative_path: string;
  byte_offset: number;
  requested_max_bytes: number;
  bytes_read: number;
  total_bytes: number;
  has_more: boolean;
  next_byte_offset: number | null;
  content_sha256: string;
  truncated: boolean;
  content: string;
}

function makeRepoWithArtifact(prefix: string, rel: string, content: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runDir = path.join(repoRoot, '.vibecode', 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.vibecode', 'current'), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({ run_id: 'r1', created_at: '2026-06-05T00:00:00Z', task: 't', status: 'done', repo_root: repoRoot }, null, 2),
    'utf8',
  );
  const abs = path.join(runDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

async function readChunk(
  repoRoot: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: ArtifactReadData; text: string; errorCode?: string }> {
  const tool = buildArtifactReadTool();
  const result = await tool.handler({ context: ctx(repoRoot), arguments: { run_id: 'r1', ...args }, requestId: null });
  return {
    isError: result.isError,
    data: result.structuredContent.data as ArtifactReadData,
    text: result.content[0]?.text ?? '',
    errorCode: result.structuredContent.error?.code,
  };
}

describe('vibecode_artifact_read continuation', () => {
  test('a call without byte_offset starts at 0 and exposes the new continuation fields', async () => {
    const content = '# final\nshort body\n';
    const { repoRoot, cleanup } = makeRepoWithArtifact('vibecode-mcp-cont-compat-', 'output/final_prompt.md', content);
    try {
      const { isError, data } = await readChunk(repoRoot, { artifact: 'final_prompt' });
      expect(isError).toBe(false);
      expect(data.byte_offset).toBe(0);
      expect(data.content).toBe(content);
      expect(data.bytes_read).toBe(Buffer.byteLength(content, 'utf8'));
      expect(data.total_bytes).toBe(Buffer.byteLength(content, 'utf8'));
      expect(data.has_more).toBe(false);
      expect(data.next_byte_offset).toBeNull();
      expect(data.content_sha256).toBe(
        createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'),
      );
    } finally {
      cleanup();
    }
  });

  test('truncated chunk reports has_more, next_byte_offset, and a continuation hint in the text', async () => {
    const content = 'y'.repeat(5000);
    const { repoRoot, cleanup } = makeRepoWithArtifact('vibecode-mcp-cont-more-', 'output/context_pack.md', content);
    try {
      const { isError, data, text } = await readChunk(repoRoot, { artifact: 'context_pack', max_bytes: 1000 });
      expect(isError).toBe(false);
      expect(data.has_more).toBe(true);
      expect(data.bytes_read).toBe(1000);
      expect(data.total_bytes).toBe(5000);
      expect(data.next_byte_offset).toBe(1000);
      // Text block tells the agent exactly how to continue.
      expect(text).toContain('has_more: yes');
      expect(text).toContain('byte_offset: 1000');
    } finally {
      cleanup();
    }
  });

  test('chained MCP reads reconstruct the exact original UTF-8 artifact', async () => {
    const content = 'abc日éf\u{1F600}ghi\n'.repeat(400);
    const { repoRoot, cleanup } = makeRepoWithArtifact('vibecode-mcp-cont-utf8-', 'flash/flash_output.md', content);
    try {
      let offset = 0;
      let reconstructed = '';
      let sha = '';
      for (let i = 0; i < 100_000; i += 1) {
        const { isError, data } = await readChunk(repoRoot, { artifact: 'flash_output', byte_offset: offset, max_bytes: 9 });
        expect(isError).toBe(false);
        expect(data.content).not.toContain('�');
        reconstructed += data.content;
        sha = data.content_sha256;
        if (!data.has_more) break;
        offset = data.next_byte_offset as number;
      }
      expect(reconstructed).toBe(content);
      expect(sha).toBe(createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'));
    } finally {
      cleanup();
    }
  });

  test('structured metadata stays complete even when the bounded text block truncates content', async () => {
    // Ask for far more than the 16000-byte MCP text bound so the text content is
    // truncated, but structuredContent.data.content must hold the full chunk.
    const content = 'z'.repeat(40_000);
    const { repoRoot, cleanup } = makeRepoWithArtifact('vibecode-mcp-cont-meta-', 'output/final_prompt.md', content);
    try {
      const { isError, data } = await readChunk(repoRoot, { artifact: 'final_prompt', max_bytes: 40_000 });
      expect(isError).toBe(false);
      expect(data.bytes_read).toBe(40_000);
      expect(data.total_bytes).toBe(40_000);
      expect(data.has_more).toBe(false);
      expect(data.next_byte_offset).toBeNull();
      // Full chunk content survives in structured data despite text-block bounding.
      expect(data.content.length).toBe(40_000);
      expect(data.content_sha256).toBe(
        createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'),
      );
    } finally {
      cleanup();
    }
  });

  test('offset at EOF returns an empty terminal chunk', async () => {
    const content = 'hello world\n';
    const total = Buffer.byteLength(content, 'utf8');
    const { repoRoot, cleanup } = makeRepoWithArtifact('vibecode-mcp-cont-eof-', 'output/final_prompt.md', content);
    try {
      const { isError, data } = await readChunk(repoRoot, { artifact: 'final_prompt', byte_offset: total });
      expect(isError).toBe(false);
      expect(data.content).toBe('');
      expect(data.bytes_read).toBe(0);
      expect(data.has_more).toBe(false);
      expect(data.next_byte_offset).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('offset beyond EOF is rejected with INVALID_ARGUMENT', async () => {
    const content = 'hello\n';
    const { repoRoot, cleanup } = makeRepoWithArtifact('vibecode-mcp-cont-oob-', 'output/final_prompt.md', content);
    try {
      const { isError, errorCode } = await readChunk(repoRoot, {
        artifact: 'final_prompt',
        byte_offset: Buffer.byteLength(content, 'utf8') + 100,
      });
      expect(isError).toBe(true);
      expect(errorCode).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });

  test('negative byte_offset is rejected with INVALID_ARGUMENT', async () => {
    const { repoRoot, cleanup } = makeRepoWithArtifact('vibecode-mcp-cont-neg-', 'output/final_prompt.md', 'hi');
    try {
      const { isError, errorCode } = await readChunk(repoRoot, { artifact: 'final_prompt', byte_offset: -1 });
      expect(isError).toBe(true);
      expect(errorCode).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });

  test('max_bytes above the hard cap is rejected with INVALID_ARGUMENT', async () => {
    const { repoRoot, cleanup } = makeRepoWithArtifact('vibecode-mcp-cont-cap-', 'output/final_prompt.md', 'hi');
    try {
      const { isError, errorCode } = await readChunk(repoRoot, {
        artifact: 'final_prompt',
        max_bytes: HARD_MAX_ARTIFACT_CHUNK_BYTES + 1,
      });
      expect(isError).toBe(true);
      expect(errorCode).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });

  test('max_bytes=0 is rejected with INVALID_ARGUMENT', async () => {
    const { repoRoot, cleanup } = makeRepoWithArtifact('vibecode-mcp-cont-zero-', 'output/final_prompt.md', 'hi');
    try {
      const { isError, errorCode } = await readChunk(repoRoot, { artifact: 'final_prompt', max_bytes: 0 });
      expect(isError).toBe(true);
      expect(errorCode).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });

  test('unknown argument keys are rejected with INVALID_ARGUMENT', async () => {
    const { repoRoot, cleanup } = makeRepoWithArtifact('vibecode-mcp-cont-unknown-', 'output/final_prompt.md', 'hi');
    try {
      const { isError, errorCode } = await readChunk(repoRoot, { artifact: 'final_prompt', offset: 5 });
      expect(isError).toBe(true);
      expect(errorCode).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });

  test('a non-allowlisted scan artifact is still rejected (no scan exposure in this batch)', async () => {
    const { repoRoot, cleanup } = makeRepoWithArtifact('vibecode-mcp-cont-scan-', 'scan/symbols.json', '{"symbols":[]}');
    try {
      const { isError, errorCode } = await readChunk(repoRoot, { artifact: 'scan/symbols.json' });
      expect(isError).toBe(true);
      expect(errorCode).toBe('ARTIFACT_NOT_ALLOWED');
    } finally {
      cleanup();
    }
  });
});
