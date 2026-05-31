import { describe, expect, test } from 'vitest';

import {
  CODEGRAPH_TRANSPORT_STORAGE_KEY,
  DEFAULT_CODEGRAPH_TRANSPORT,
  normalizeCodeGraphTransport,
} from '../../../src/adapters/codegraph/codegraph_transport.js';

describe('CodeGraphTransport helpers', () => {
  test('default transport is cli', () => {
    expect(DEFAULT_CODEGRAPH_TRANSPORT).toBe('cli');
  });

  test('storage key is the stable Phase 1B identifier', () => {
    expect(CODEGRAPH_TRANSPORT_STORAGE_KEY).toBe('vibecode.codegraphTransport');
  });

  test('normalize accepts cli/mcp/auto and is case-insensitive', () => {
    expect(normalizeCodeGraphTransport('cli')).toBe('cli');
    expect(normalizeCodeGraphTransport('mcp')).toBe('mcp');
    expect(normalizeCodeGraphTransport('auto')).toBe('auto');
    expect(normalizeCodeGraphTransport('  AUTO  ')).toBe('auto');
    expect(normalizeCodeGraphTransport('Mcp')).toBe('mcp');
  });

  test('invalid or missing input falls back to cli', () => {
    expect(normalizeCodeGraphTransport(undefined)).toBe('cli');
    expect(normalizeCodeGraphTransport(null)).toBe('cli');
    expect(normalizeCodeGraphTransport('')).toBe('cli');
    expect(normalizeCodeGraphTransport('xyz')).toBe('cli');
    expect(normalizeCodeGraphTransport(42)).toBe('cli');
  });
});
