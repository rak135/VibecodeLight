import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/tool_registry.js';

/**
 * Phase 5A scope guard for the read-only coordination observability surface.
 *
 * Protected invariant: this phase adds VISIBILITY only. It must not introduce
 * any coordination control/orchestration: no claim add/release, conflict
 * resolve, stale-claim reap, scoped commit, git mutation, source-file locks,
 * watcher start/stop, handoff, validation runner, or MCP/Python scanner change.
 */

const repoRoot = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

// Strip comments before scanning so that prose describing what the surface does
// NOT do (e.g. "no claim release / conflict resolve") cannot be mistaken for an
// actual mutation affordance. Only executable code is asserted against.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (keep http://)
}

const bridgeSrc = stripComments(read('src/app/desktop/coordination_bridge.ts'));
const overviewSrc = stripComments(read('src/core/coordination/overview.ts'));
const panelSrc = stripComments(read('src/app/desktop/renderer/coordination_panel.js'));
const indexHtml = read('src/app/desktop/renderer/index.html');

const GIT_MUTATION = /git\s+(add|commit|reset|stash|clean|checkout|restore)\b/i;
const SOURCE_LOCK = /chmod|icacls|attrib\s|Set-Acl|\.lock\b/i;
const MUTATION_VERBS = /addFileClaim|releaseFileClaim|reapStaleClaims|resolveConflict|recordConflict|writeCoordinationState|runScopedCommit|commit_guard|finalize_check|live_watcher|claim_cleanup/;

describe('coordination observability: read-only IPC scope', () => {
  test('the bridge registers only the read-only coordination:getOverview channel', () => {
    expect(bridgeSrc).toMatch(/coordination:getOverview/);
    // No mutation verbs in the coordination IPC channel namespace.
    const channels = bridgeSrc.match(/coordination:[a-zA-Z]+/g) || [];
    expect(channels).toEqual(['coordination:getOverview']);
    expect(bridgeSrc).not.toMatch(/coordination:(add|release|reap|resolve|commit|watch|finalize|handoff|mutate|create|delete)/i);
  });

  test('the bridge does not import coordination mutation modules', () => {
    expect(bridgeSrc).not.toMatch(MUTATION_VERBS);
    expect(bridgeSrc).not.toMatch(/from\s+['"][^'"]*coordination\/(claims|conflicts|claim_cleanup|commit_guard|finalize_check|live_watcher|state)\.js['"]/);
  });

  test('the core overview reads coordination state but never mutates it', () => {
    expect(overviewSrc).not.toMatch(MUTATION_VERBS);
    expect(overviewSrc).not.toMatch(/writeFileSync|initializeCoordinationState/);
  });
});

describe('coordination observability: no git / source mutation', () => {
  test('no git mutation commands appear in any coordination surface', () => {
    for (const src of [bridgeSrc, overviewSrc, panelSrc]) {
      expect(src).not.toMatch(GIT_MUTATION);
    }
  });

  test('no source-file locks / permission changes appear in any coordination surface', () => {
    for (const src of [bridgeSrc, overviewSrc, panelSrc]) {
      expect(src).not.toMatch(SOURCE_LOCK);
    }
  });
});

describe('coordination observability: no handoff / control workflow', () => {
  test('coordination surfaces add no handoff or validation-runner workflow', () => {
    for (const src of [bridgeSrc, overviewSrc, panelSrc]) {
      expect(src).not.toMatch(/handoff/i);
      expect(src).not.toMatch(/validation[_-]?runner|runValidation/i);
    }
  });
});

describe('coordination observability: renderer panel has no mutation controls', () => {
  test('the panel renderer emits no interactive controls and no process/file access', () => {
    // Structural guarantee: the panel produces inert markup only. (Rendered
    // output is separately asserted to contain no mutation affordances in
    // coordination_panel.test.ts.)
    expect(panelSrc).not.toMatch(/<button/i);
    expect(panelSrc).not.toMatch(/addEventListener|onclick=/i);
    expect(panelSrc).not.toMatch(/ipcRenderer|child_process|require\(\s*['"]fs['"]\s*\)/i);
  });

  test('the renderer only ever calls the read-only coordination.getOverview API', () => {
    expect(indexHtml).toMatch(/coordination\.getOverview/);
    // No other coordination.* method is referenced (no mutation affordances).
    const calls = indexHtml.match(/coordination\.[a-zA-Z]+/g) || [];
    for (const call of calls) {
      expect(call).toBe('coordination.getOverview');
    }
  });
});

describe('coordination observability: no MCP surface change', () => {
  test('no coordination overview MCP tool was added', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).not.toContain('vibecode_coordination_overview');
    // The coordination MCP tool set is unchanged: no new *_overview tool.
    expect(VIBECODE_MCP_TOOL_NAMES.filter((n) => n.endsWith('_overview'))).toEqual([]);
  });
});
