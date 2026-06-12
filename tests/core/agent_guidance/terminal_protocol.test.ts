import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import {
  TERMINAL_AGENT_BANNER_ENV,
  getTerminalAgentProtocolBanner,
  getTerminalPreflightSummary,
  isTerminalAgentBannerEnabled,
} from '../../../src/core/agent_guidance/terminal_protocol.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';

/**
 * Phase 1B-4: terminal protocol banner / preflight.
 *
 * What breaks if removed:
 *   - the first-step guidance a fresh terminal agent sees could drift, omit the
 *     bootstrap command, or reference a renamed/nonexistent MCP tool;
 *   - the banner could grow unbounded and dominate the terminal;
 *   - the banner could start advertising out-of-scope (Phase 2+) features;
 *   - the cheap, read-only preflight summary could start doing heavy work
 *     (git/scanner) or mutating state.
 */

describe('terminal protocol banner — content', () => {
  const banner = getTerminalAgentProtocolBanner();

  test('includes the exact first session bootstrap command', () => {
    expect(banner).toContain(
      'vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json',
    );
  });

  test('names the MCP-preferred v1 start/snapshot tools', () => {
    expect(banner).toContain('vibecode_session_start');
    expect(banner).toContain('vibecode_workspace_snapshot');
  });

  test('names the CLI fallback for session start', () => {
    expect(banner).toContain('vibecode session bootstrap');
  });

  test('offers the read_only vs build mode choice', () => {
    expect(banner).toMatch(/read_only/);
    expect(banner).toMatch(/build/);
  });

  test('reminds build agents to claim before editing and to use git changes', () => {
    expect(banner.toLowerCase()).toContain('exact paths');
    expect(banner).toContain('vibecode_build_start');
    expect(banner).toContain('vibecode git changes');
  });

  test('points to finalize check and commit guard for commits', () => {
    expect(banner).toContain('vibecode_build_finish');
    expect(banner).toContain('vibecode commit guard');
  });

  test('points to scan/artifact tools instead of raw filesystem inspection', () => {
    expect(banner).toContain('vibecode scan summary --run current --json');
    expect(banner).toContain('vibecode runs artifact-read --run current --artifact <artifact> --json');
    expect(banner.toLowerCase()).toMatch(/rg|find/);
  });

  test('warns not to push unless explicitly asked', () => {
    expect(banner.toLowerCase()).toContain('push');
    expect(banner.toLowerCase()).toContain('unless');
  });

  test('mentions the opt-out environment variable', () => {
    expect(banner).toContain(TERMINAL_AGENT_BANNER_ENV);
  });

  test('is bounded — short enough not to dominate the terminal', () => {
    const lines = banner.split('\n');
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(banner.length).toBeLessThanOrEqual(1400);
    expect(banner.trim().length).toBeGreaterThan(0);
  });

  test('never references a nonexistent MCP tool name', () => {
    const registry = new Set(VIBECODE_MCP_TOOL_NAMES);
    const referenced = banner.match(/vibecode_[a-z0-9_]+/g) ?? [];
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(registry.has(name)).toBe(true);
    }
  });

  test('does not advertise out-of-scope / Phase 2+ features', () => {
    const lowered = banner.toLowerCase();
    for (const forbidden of [
      'subagent',
      'handoff',
      'notice board',
      'bulk claim',
      'orchestrat',
      'affected test',
      'codegraph_resolve',
    ]) {
      expect(lowered).not.toContain(forbidden);
    }
  });
});

describe('terminal protocol banner — preflight summary integration', () => {
  test('an optional cheap preflight summary is rendered as a compact preface', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-banner-pf-'));
    try {
      const preflight = getTerminalPreflightSummary(repoRoot);
      const banner = getTerminalAgentProtocolBanner({ preflight });
      // The preface mentions the repo and stays inside the bounded budget.
      expect(banner).toContain(repoRoot);
      expect(banner.split('\n').length).toBeLessThanOrEqual(20);
      // The protocol body is still present.
      expect(banner).toContain('vibecode_session_start');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('terminal preflight summary — cheap, read-only', () => {
  test('reports an uninitialized repo without current run or coordination state', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-pf-empty-'));
    try {
      const summary = getTerminalPreflightSummary(repoRoot);
      expect(summary.repo_root).toBe(path.resolve(repoRoot));
      expect(summary.vibecode_initialized).toBe(false);
      expect(summary.current_run_present).toBe(false);
      expect(summary.coordination_state_present).toBe(false);
      expect(summary.next_command).toContain('vibecode session bootstrap');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('detects an existing current run pointer and coordination state', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-pf-seeded-'));
    try {
      fs.mkdirSync(path.join(repoRoot, '.vibecode', 'current'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, '.vibecode', 'current', 'run_manifest.json'),
        JSON.stringify({ run_id: 'r1' }),
        'utf8',
      );
      fs.mkdirSync(path.join(repoRoot, '.vibecode', 'coordination'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, '.vibecode', 'coordination', 'state.json'),
        JSON.stringify({ agents: [] }),
        'utf8',
      );
      const summary = getTerminalPreflightSummary(repoRoot);
      expect(summary.vibecode_initialized).toBe(true);
      expect(summary.current_run_present).toBe(true);
      expect(summary.coordination_state_present).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('does not throw on a path that does not exist', () => {
    const missing = path.join(os.tmpdir(), `vibecode-pf-missing-${Date.now()}`);
    expect(() => getTerminalPreflightSummary(missing)).not.toThrow();
  });
});

describe('terminal banner opt-out', () => {
  test('enabled by default and when the env var is unset/empty/1', () => {
    expect(isTerminalAgentBannerEnabled({})).toBe(true);
    expect(isTerminalAgentBannerEnabled({ [TERMINAL_AGENT_BANNER_ENV]: '' })).toBe(true);
    expect(isTerminalAgentBannerEnabled({ [TERMINAL_AGENT_BANNER_ENV]: '1' })).toBe(true);
  });

  test('disabled by 0/false/off (case-insensitive)', () => {
    expect(isTerminalAgentBannerEnabled({ [TERMINAL_AGENT_BANNER_ENV]: '0' })).toBe(false);
    expect(isTerminalAgentBannerEnabled({ [TERMINAL_AGENT_BANNER_ENV]: 'false' })).toBe(false);
    expect(isTerminalAgentBannerEnabled({ [TERMINAL_AGENT_BANNER_ENV]: 'OFF' })).toBe(false);
  });
});
