import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  getMcpDashboardOverview,
  McpDashboardAgent,
} from '../../../src/core/mcp/mcp_dashboard.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';

function makeFixture(): {
  repoRoot: string;
  appData: string;
  codexHome: string;
  opencodeHome: string;
  env: Record<string, string>;
  cleanup: () => void;
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-dash-repo-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-dash-app-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-dash-codex-'));
  const opencodeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-dash-opencode-'));
  return {
    repoRoot,
    appData,
    codexHome,
    opencodeHome,
    env: { LOCALAPPDATA: appData, CODEX_HOME: codexHome },
    cleanup: () => {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(appData, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
      fs.rmSync(opencodeHome, { recursive: true, force: true });
    },
  };
}

describe('MCP dashboard overview', () => {
  test('includes all supported agents and repo metadata', () => {
    const f = makeFixture();
    try {
      const overview = getMcpDashboardOverview({
        repoRoot: f.repoRoot,
        env: f.env,
        codexHome: f.codexHome,
        opencodeConfigDir: f.opencodeHome,
      });

      expect(overview.repo_root).toBe(f.repoRoot);
      expect(overview.server_name).toBe('vibecode');
      expect(overview.tools_count).toBe(VIBECODE_MCP_TOOL_NAMES.length);
      expect(overview.tools.length).toBeGreaterThan(0);

      const agents = overview.agents;
      expect(agents.map((a) => a.agent).sort()).toEqual(['claude', 'codex', 'opencode']);

      for (const agent of agents) {
        expect(agent.status).toMatch(/up_to_date|stale|not_configured|unknown|error/);
        expect(agent.warnings).toEqual(expect.any(Array));
        expect(agent.suggestions).toEqual(expect.any(Array));
      }
    } finally {
      f.cleanup();
    }
  });

  test('does not mutate config during overview', () => {
    const f = makeFixture();
    try {
      const beforeRepo = fs.readdirSync(f.repoRoot).sort();
      const beforeCodex = fs.existsSync(path.join(f.codexHome, 'config.toml'));
      const beforeOpenCode = fs.existsSync(path.join(f.opencodeHome, 'opencode.json'));

      getMcpDashboardOverview({
        repoRoot: f.repoRoot,
        env: f.env,
        codexHome: f.codexHome,
        opencodeConfigDir: f.opencodeHome,
      });

      expect(fs.readdirSync(f.repoRoot).sort()).toEqual(beforeRepo);
      expect(fs.existsSync(path.join(f.codexHome, 'config.toml'))).toBe(beforeCodex);
      expect(fs.existsSync(path.join(f.opencodeHome, 'opencode.json'))).toBe(beforeOpenCode);
    } finally {
      f.cleanup();
    }
  });

  test('handles missing repo gracefully without throwing', () => {
    const overview = getMcpDashboardOverview({
      repoRoot: '/nonexistent/path',
      env: {},
    });

    expect(overview.repo_root).toBe('/nonexistent/path');
    expect(overview.agents.length).toBe(3);
    for (const agent of overview.agents) {
      expect(agent.status).toBeDefined();
    }
  });

  test('OpenCode agent is included and has expected fields', () => {
    const f = makeFixture();
    try {
      const overview = getMcpDashboardOverview({
        repoRoot: f.repoRoot,
        env: f.env,
        opencodeConfigDir: f.opencodeHome,
      });

      const opencode = overview.agents.find((a) => a.agent === 'opencode') as McpDashboardAgent;
      expect(opencode).toBeDefined();
      expect(opencode.agent).toBe('opencode');
      expect(opencode.mcp?.expected_tool_count).toBe(VIBECODE_MCP_TOOL_NAMES.length);
    } finally {
      f.cleanup();
    }
  });
});
