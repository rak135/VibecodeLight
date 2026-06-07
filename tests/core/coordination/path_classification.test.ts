import { describe, expect, test } from 'vitest';

import {
  classifyChangedPath,
  pathsOverlap,
} from '../../../src/core/coordination/path_classification.js';
import type { FileClaim } from '../../../src/core/coordination/types.js';

/**
 * Unit tests for the shared changed-path classification primitive. This is the
 * single source of truth reused by BOTH the finalize check and the watcher
 * evidence layer, so classification rules are never duplicated.
 */

function claim(over: Partial<FileClaim>): FileClaim {
  return {
    claim_id: 'claim-1',
    agent_id: 'agent-a',
    path: 'src/a.ts',
    mode: 'exclusive',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    released_at: null,
    metadata: {},
    ...over,
  };
}

describe('pathsOverlap', () => {
  test('equal, directory-prefix, and disjoint paths', () => {
    expect(pathsOverlap('src/a.ts', 'src/a.ts')).toBe(true);
    expect(pathsOverlap('src/a.ts', 'src')).toBe(true);
    expect(pathsOverlap('src', 'src/a.ts')).toBe(true);
    expect(pathsOverlap('src/a.ts', 'src/b.ts')).toBe(false);
    expect(pathsOverlap('src/a.ts', 'srcx/a.ts')).toBe(false);
  });
});

describe('classifyChangedPath', () => {
  test('generated/ignored runtime path is generated_or_ignored regardless of claims', () => {
    const result = classifyChangedPath({
      path: '.vibecode/coordination/state.json',
      agentId: 'agent-a',
      activeClaims: [claim({ path: '.vibecode' })],
    });
    expect(result.classification).toBe('generated_or_ignored');
  });

  test('path covered by the current agent active claim is claimed_by_agent', () => {
    const result = classifyChangedPath({
      path: 'src/a.ts',
      agentId: 'agent-a',
      activeClaims: [claim({ claim_id: 'c1', agent_id: 'agent-a', path: 'src/a.ts' })],
      agentNames: new Map([['agent-a', 'Alice']]),
    });
    expect(result.classification).toBe('claimed_by_agent');
    expect(result.owning_claim_id).toBe('c1');
    expect(result.owning_agent_id).toBe('agent-a');
    expect(result.owning_agent_name).toBe('Alice');
  });

  test('path covered by another active agent is claimed_by_other_active_agent', () => {
    const result = classifyChangedPath({
      path: 'src/b.ts',
      agentId: 'agent-a',
      activeClaims: [claim({ claim_id: 'c2', agent_id: 'agent-b', path: 'src/b.ts' })],
      agentNames: new Map([['agent-b', 'Bob']]),
    });
    expect(result.classification).toBe('claimed_by_other_active_agent');
    expect(result.owning_agent_id).toBe('agent-b');
    expect(result.owning_agent_name).toBe('Bob');
  });

  test('with no current agent context, an active claim is attributed to another active agent', () => {
    const result = classifyChangedPath({
      path: 'src/b.ts',
      agentId: null,
      activeClaims: [claim({ claim_id: 'c2', agent_id: 'agent-b', path: 'src/b.ts' })],
    });
    expect(result.classification).toBe('claimed_by_other_active_agent');
    expect(result.owning_agent_id).toBe('agent-b');
  });

  test('an unclaimed path is unclaimed; a stale overlap is surfaced but does not authorize', () => {
    const result = classifyChangedPath({
      path: 'src/c.ts',
      agentId: 'agent-a',
      activeClaims: [],
      staleClaims: [claim({ claim_id: 'stale-1', agent_id: 'agent-z', path: 'src/c.ts', status: 'stale' })],
    });
    expect(result.classification).toBe('unclaimed');
    expect(result.stale_overlap_claim_id).toBe('stale-1');
  });
});
