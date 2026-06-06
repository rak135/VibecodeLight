import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildClaimAddTool,
  buildClaimsListTool,
  buildClaimStatusTool,
  buildClaimReleaseTool,
} from '../../../src/app/mcp/tools/claims.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('VibecodeMCP advisory claim tools', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-claims-mcp-');
  });

  afterEach(() => repo.cleanup());

  test('vibecode_claim_add returns the same core data as CLI/core', async () => {
    const agent = registerAgent(repo.repoRoot, { agent_name: 'Codex A', agent_type: 'codex' });
    const tool = buildClaimAddTool();
    expect(tool.name).toBe('vibecode_claim_add');

    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent.agent_id, path: 'src/app.ts', mode: 'exclusive' },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const claim = (result.structuredContent.data as { claim: Record<string, unknown> }).claim;
    expect(claim.agent_id).toBe(agent.agent_id);
    expect(claim.path).toBe('src/app.ts');
    expect(claim.mode).toBe('exclusive');
    expect(claim.status).toBe('active');
    expect(fs.existsSync(path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json'))).toBe(true);
  });

  test('vibecode_claims_list returns persisted claims and filters by agent', async () => {
    const a = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' });
    const b = registerAgent(repo.repoRoot, { agent_name: 'B', agent_type: 'claude' });
    addFileClaim(repo.repoRoot, { agent_id: a.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    addFileClaim(repo.repoRoot, { agent_id: b.agent_id, path: 'src/b.ts', mode: 'exclusive' });

    const result = await buildClaimsListTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: a.agent_id },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const claims = (result.structuredContent.data as { claims: Array<{ agent_id: string; path: string }> }).claims;
    expect(claims).toEqual([expect.objectContaining({ agent_id: a.agent_id, path: 'src/a.ts' })]);
  });

  test('vibecode_claim_status returns matching claims and claimability', async () => {
    const agent = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' });
    addFileClaim(repo.repoRoot, { agent_id: agent.agent_id, path: 'src', mode: 'shared' });

    const result = await buildClaimStatusTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { path: 'src/app.ts' },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const status = (result.structuredContent.data as { status: { matching_claims: unknown[]; can_claim_shared: boolean; can_claim_exclusive: boolean } }).status;
    expect(status.matching_claims).toHaveLength(1);
    expect(status.can_claim_shared).toBe(true);
    expect(status.can_claim_exclusive).toBe(false);
  });

  test('vibecode_claim_release releases a claim', async () => {
    const agent = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' });
    const added = addFileClaim(repo.repoRoot, { agent_id: agent.agent_id, path: 'src/app.ts', mode: 'exclusive' });

    const result = await buildClaimReleaseTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { claim_id: added.claim?.claim_id },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const claim = (result.structuredContent.data as { claim: { claim_id: string; status: string } }).claim;
    expect(claim.claim_id).toBe(added.claim?.claim_id);
    expect(claim.status).toBe('released');
  });

  test('claim denial and invalid arguments return structured MCP errors', async () => {
    const a = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' });
    const b = registerAgent(repo.repoRoot, { agent_name: 'B', agent_type: 'claude' });
    addFileClaim(repo.repoRoot, { agent_id: a.agent_id, path: 'src/app.ts', mode: 'exclusive' });

    const denied = await buildClaimAddTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: b.agent_id, path: 'src', mode: 'exclusive' },
      requestId: null,
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.error?.code).toBe('CLAIM_DENIED');

    const invalid = await buildClaimAddTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: a.agent_id, path: '../outside.ts', mode: 'exclusive' },
      requestId: null,
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('claim denial payload includes structured blocking-claim details', async () => {
    const a = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' });
    const b = registerAgent(repo.repoRoot, { agent_name: 'B', agent_type: 'claude' });
    const existing = addFileClaim(repo.repoRoot, { agent_id: a.agent_id, path: 'src/app.ts', mode: 'exclusive' });

    const denied = await buildClaimAddTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: b.agent_id, path: 'src', mode: 'exclusive' },
      requestId: null,
    });

    expect(denied.isError).toBe(true);
    const error = denied.structuredContent.error;
    expect(error?.code).toBe('CLAIM_DENIED');
    const details = error?.details as
      | {
          requested: { agent_id: string; path: string; mode: string };
          conflicting_claims: Array<{ claim_id: string; agent_id: string; path: string; mode: string }>;
          suggestions: string[];
        }
      | undefined;
    expect(details).toBeDefined();
    expect(details?.requested).toMatchObject({ agent_id: b.agent_id, path: 'src', mode: 'exclusive' });
    expect(details?.conflicting_claims).toHaveLength(1);
    expect(details?.conflicting_claims[0]).toMatchObject({
      claim_id: existing.claim?.claim_id,
      agent_id: a.agent_id,
      path: 'src/app.ts',
      mode: 'exclusive',
    });
    expect(details?.suggestions).toContain('release_existing_claim');
    // The blocking agent id is recoverable from the conflicting claim itself.
    expect(details?.conflicting_claims[0].agent_id).toBe(a.agent_id);
  });

  test('non-denial claim errors still return without a details payload', async () => {
    const agent = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' });
    const invalid = await buildClaimAddTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent.agent_id, path: '../outside.ts', mode: 'exclusive' },
      requestId: null,
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    expect(invalid.structuredContent.error?.details).toBeUndefined();
  });

  test('claim tools do not accept a repo path argument', async () => {
    for (const tool of [buildClaimAddTool(), buildClaimsListTool(), buildClaimStatusTool(), buildClaimReleaseTool()]) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties ?? {}).not.toHaveProperty('repo');
    }

    const result = await buildClaimsListTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { repo: '/some/other/repo' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('claim tools call the shared core service and do not shell out to the CLI', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../src/app/mcp/tools/claims.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bspawn\s*\(|\bexec\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|\bexeca\s*\(/);
    expect(source).toMatch(/core\/coordination\/claims/);
  });
});
