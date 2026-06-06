import { describe, expect, test } from 'vitest';

import { MCP_TEXT_OUTPUT_LIMIT } from '../../../src/app/mcp/format.js';
import { DEFAULT_MAX_BYTES } from '../../../src/app/mcp/tools/artifact_read.js';

/**
 * Single-source-of-truth check for the MCP artifact read output bound.
 *
 * The artifact_read tool used to hard-code its own `16_000` default. That value
 * must come from the shared MCP text output limit so the two cannot drift.
 */
describe('MCP artifact read output limit', () => {
  test('artifact_read default max bytes equals the shared MCP_TEXT_OUTPUT_LIMIT', () => {
    expect(DEFAULT_MAX_BYTES).toBe(MCP_TEXT_OUTPUT_LIMIT);
  });
});
