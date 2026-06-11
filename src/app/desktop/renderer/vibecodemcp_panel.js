(function () {
  'use strict';

  // Supported agents: claude, codex, opencode
  const SUPPORTED_AGENTS = ['claude', 'codex', 'opencode'];

  const $ = (id) => document.getElementById(id);

  const vibecodemcpPanel = $('vibecodemcp-panel');
  const vibecodemcpRepo = $('vibecodemcp-repo');
  const vibecodemcpMeta = $('vibecodemcp-meta');
  const vibecodemcpCards = $('vibecodemcp-cards');
  const vibecodemcpDetails = $('vibecodemcp-details');
  const vibecodemcpDetailsContent = $('vibecodemcp-details-content');
  const vibecodemcpToolsContent = $('vibecodemcp-tools-content');
  const vibecodemcpResult = $('vibecodemcp-result');
  const vibecodemcpResultContent = $('vibecodemcp-result-content');
  const vibecodemcpRefreshBtn = $('vibecodemcp-refresh');
  const vibecodemcpCloseBtn = $('vibecodemcp-close');
  let vibecodemcpLastOverview = null;
  let vibecodemcpToolCatalog = null;
  let vibecodemcpSelectedAgent = null;
  let vibecodemcpToolFilters = {
    query: '',
    group: 'all',
    sideEffect: 'all',
    profile: 'all',
    selectedName: '',
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function openVibecodeMcpPanel() {
    if (!vibecodemcpPanel) return;
    vibecodemcpPanel.style.display = 'flex';
    vibecodemcpPanel.classList.add('open');
    const workspace = $('workspace');
    if (workspace) workspace.style.display = 'none';
    void renderVibecodeMcpPanel();
  }

  function closeVibecodeMcpPanel() {
    if (!vibecodemcpPanel) return;
    vibecodemcpPanel.style.display = 'none';
    vibecodemcpPanel.classList.remove('open');
    const workspace = $('workspace');
    if (workspace) workspace.style.display = '';
  }

  async function renderVibecodeMcpPanel() {
    if (!window.vibecodeAPI || !window.vibecodeAPI.mcp) {
      if (vibecodemcpCards) vibecodemcpCards.innerHTML = '<div class="rp-empty">MCP API is unavailable.</div>';
      return;
    }
    if (vibecodemcpRepo && window.vibecodeAPI.workspace) {
      try {
        const info = await window.vibecodeAPI.workspace.getInfo();
        if (info && info.repoPath) vibecodemcpRepo.textContent = info.repoPath;
      } catch (_e) { /* best-effort */ }
    }
    if (vibecodemcpCards) vibecodemcpCards.innerHTML = '<div class="rp-empty">Loading MCP status…</div>';
    try {
      const overview = await window.vibecodeAPI.mcp.getOverview();
      vibecodemcpLastOverview = overview;
      if (vibecodemcpMeta) {
        const text = 'server=' + (overview.server_name || 'vibecode') + ' tools=' + (overview.tools_count || 0);
        vibecodemcpMeta.textContent = text;
      }
      renderVibecodeMcpAgents(overview);
      await renderVibecodeMcpTools(overview);
      if (vibecodemcpSelectedAgent) renderVibecodeMcpDetails(vibecodemcpSelectedAgent);
    } catch (error) {
      if (vibecodemcpCards) {
        vibecodemcpCards.innerHTML = '<div class="rp-empty">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</div>';
      }
    }
  }

  function renderVibecodeMcpAgents(overview) {
    if (!vibecodemcpCards || !overview || !Array.isArray(overview.agents)) return;
    const agents = overview.agents;
    if (agents.length === 0) {
      vibecodemcpCards.innerHTML = '<div class="rp-empty">No agents configured.</div>';
      return;
    }
    let html = '';
    for (const agent of agents) {
      const statusClass = agent.status || 'not_configured';
      const statusLabel = agent.status === 'up_to_date' ? 'up to date' : agent.status === 'not_configured' ? 'not configured' : agent.status;
      const warnings = (agent.warnings || []).slice(0, 3);
      const warningHtml = warnings.length > 0
        ? '<div class="card-warnings">' + warnings.map((w) => '<div class="card-warning">' + escapeHtml(w) + '</div>').join('') + '</div>'
        : '';
      const meta = [];
      if (agent.scope) meta.push('scope: ' + agent.scope);
      if (agent.config_path) meta.push('config: ' + agent.config_path);
      if (agent.mcp && agent.mcp.expected_tool_count) meta.push('expected tools: ' + agent.mcp.expected_tool_count);
      if (agent.mcp && agent.mcp.status) meta.push('config status: ' + agent.mcp.status);
      if (agent.status === 'stale') meta.push('stale or mismatched config; restart/reconnect the agent after updating');
      const metaHtml = meta.length > 0 ? '<div class="card-meta">' + meta.map((m) => escapeHtml(m)).join('<br>') + '</div>' : '';
      const actions = [];
      if (agent.can_install || agent.can_update) {
        actions.push('<button data-action="doctor" data-agent="' + escapeHtml(agent.agent) + '">Doctor</button>');
        actions.push('<button data-action="dry-run" data-agent="' + escapeHtml(agent.agent) + '">Dry-run</button>');
      }
      if (agent.can_install || agent.can_update) {
        actions.push('<button data-action="install" data-agent="' + escapeHtml(agent.agent) + '">Install / Update</button>');
      }
      actions.push('<button data-action="details" data-agent="' + escapeHtml(agent.agent) + '">Show details</button>');
      actions.push('<button data-action="catalog" data-agent="' + escapeHtml(agent.agent) + '">Tool catalog</button>');
      const actionsHtml = actions.length > 0 ? '<div class="card-actions">' + actions.join('') + '</div>' : '';

      html += '<div class="vibecodemcp-card" data-agent="' + escapeHtml(agent.agent) + '">' +
        '<div class="card-head"><span class="card-name">' + escapeHtml(agent.agent.charAt(0).toUpperCase() + agent.agent.slice(1)) + '</span>' +
        '<span class="card-status ' + statusClass + '">' + escapeHtml(statusLabel) + '</span></div>' +
        metaHtml + warningHtml + actionsHtml + '</div>';
    }
    vibecodemcpCards.innerHTML = html;

    vibecodemcpCards.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const agent = btn.getAttribute('data-agent');
        const action = btn.getAttribute('data-action');
        if (action === 'details') {
          vibecodemcpSelectedAgent = agent;
          renderVibecodeMcpDetails(agent);
          return;
        }
        if (action === 'catalog') {
          const toolsSection = $('vibecodemcp-tools');
          if (toolsSection && toolsSection.scrollIntoView) toolsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (action === 'doctor') {
          void runVibecodeMcpDoctor(agent);
          return;
        }
        if (action === 'dry-run') {
          void runVibecodeMcpDryRun(agent);
          return;
        }
        if (action === 'install') {
          const confirmed = window.confirm('Install / update VibecodeMCP for ' + agent + '?');
          if (confirmed) void runVibecodeMcpInstall(agent);
          return;
        }
      });
    });
  }

  async function renderVibecodeMcpTools(overview) {
    if (!vibecodemcpToolsContent) return;
    if (!window.VibecodeMcpToolsPanel) {
      vibecodemcpToolsContent.innerHTML = '<div class="rp-empty">MCP catalog renderer is unavailable.</div>';
      return;
    }
    try {
      if (!vibecodemcpToolCatalog && window.vibecodeAPI && window.vibecodeAPI.mcp && typeof window.vibecodeAPI.mcp.getToolCatalog === 'function') {
        vibecodemcpToolCatalog = await window.vibecodeAPI.mcp.getToolCatalog();
      }
      if (!vibecodemcpToolCatalog && overview && Array.isArray(overview.tools)) {
        vibecodemcpToolsContent.innerHTML = '<div class="rp-empty">MCP tool catalog is unavailable. Registry reported ' + overview.tools.length + ' tools.</div>';
        return;
      }
      renderVibecodeMcpCatalogHtml();
    } catch (_error) {
      vibecodemcpToolsContent.innerHTML = '<div class="rp-empty">MCP tool catalog could not be loaded.</div>';
    }
  }

  function renderVibecodeMcpCatalogHtml() {
    if (!vibecodemcpToolsContent || !window.VibecodeMcpToolsPanel) return;
    vibecodemcpToolsContent.innerHTML = window.VibecodeMcpToolsPanel.renderCatalogHtml(vibecodemcpToolCatalog, vibecodemcpToolFilters);
    wireVibecodeMcpCatalogControls();
  }

  function wireVibecodeMcpCatalogControls() {
    if (!vibecodemcpToolsContent) return;
    const search = vibecodemcpToolsContent.querySelector('[data-filter="search"]');
    const group = vibecodemcpToolsContent.querySelector('[data-filter="group"]');
    const sideEffect = vibecodemcpToolsContent.querySelector('[data-filter="side-effect"]');
    const profile = vibecodemcpToolsContent.querySelector('[data-filter="profile"]');
    if (search) {
      search.addEventListener('input', () => {
        vibecodemcpToolFilters.query = search.value || '';
        renderVibecodeMcpCatalogHtml();
      });
    }
    if (group) {
      group.addEventListener('change', () => {
        vibecodemcpToolFilters.group = group.value || 'all';
        renderVibecodeMcpCatalogHtml();
      });
    }
    if (sideEffect) {
      sideEffect.addEventListener('change', () => {
        vibecodemcpToolFilters.sideEffect = sideEffect.value || 'all';
        renderVibecodeMcpCatalogHtml();
      });
    }
    if (profile) {
      profile.addEventListener('change', () => {
        vibecodemcpToolFilters.profile = profile.value || 'all';
        renderVibecodeMcpCatalogHtml();
      });
    }
    vibecodemcpToolsContent.querySelectorAll('[data-tool-name]').forEach((card) => {
      card.addEventListener('click', () => {
        const name = card.getAttribute('data-tool-name') || '';
        vibecodemcpToolFilters.selectedName = name;
        renderVibecodeMcpCatalogHtml();
      });
    });
  }

  async function renderVibecodeMcpDetails(agent) {
    if (!vibecodemcpDetails || !vibecodemcpDetailsContent) return;
    vibecodemcpDetails.style.display = '';
    let html = '<div>Loading details for ' + escapeHtml(agent) + '…</div>';
    vibecodemcpDetailsContent.innerHTML = html;
    try {
      if (!window.vibecodeAPI || !window.vibecodeAPI.mcp) return;
      const status = await window.vibecodeAPI.mcp.doctor(agent);
      let details = '<div><strong>Agent:</strong> ' + escapeHtml(agent) + '</div>';
      if (status && status.mcp) {
        details += '<div><strong>Expected tools:</strong> ' + (status.mcp.expected_tool_count || 0) + '</div>';
        details += '<div><strong>Configured:</strong> ' + (status.mcp.configured ? 'yes' : 'no') + '</div>';
        details += '<div><strong>Up to date:</strong> ' + (status.mcp.up_to_date ? 'yes' : 'no') + '</div>';
      }
      if (status && status.checks) {
        details += '<div style="margin-top:8px;"><strong>Checks:</strong></div>';
        for (const [name, check] of Object.entries(status.checks)) {
          const icon = check.ok ? '✓' : '✗';
          details += '<div style="padding-left:8px;">' + icon + ' ' + escapeHtml(name) + ': ' + escapeHtml(check.message) + '</div>';
        }
      }
      if (status && status.warnings && status.warnings.length > 0) {
        details += '<div style="margin-top:8px;"><strong>Warnings:</strong></div>';
        for (const warning of status.warnings) {
          details += '<div style="padding-left:8px;color:var(--warn);">! ' + escapeHtml(warning) + '</div>';
        }
      }
      if (status && status.suggestions && status.suggestions.length > 0) {
        details += '<div style="margin-top:8px;"><strong>Suggestions:</strong></div>';
        for (const suggestion of status.suggestions) {
          details += '<div style="padding-left:8px;">• ' + escapeHtml(suggestion) + '</div>';
        }
      }
      vibecodemcpDetailsContent.innerHTML = details;
    } catch (error) {
      vibecodemcpDetailsContent.innerHTML = '<div class="error">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</div>';
    }
  }

  async function runVibecodeMcpDoctor(agent) {
    if (!vibecodemcpResult || !vibecodemcpResultContent) return;
    vibecodemcpResult.style.display = '';
    vibecodemcpResultContent.innerHTML = '<div>Running doctor for ' + escapeHtml(agent) + '…</div>';
    try {
      if (!window.vibecodeAPI || !window.vibecodeAPI.mcp) return;
      const result = await window.vibecodeAPI.mcp.doctor(agent);
      let html = '<div class="' + (result.ok ? 'ok' : 'error') + '">' + (result.ok ? 'Doctor passed' : 'Doctor failed') + ' for ' + escapeHtml(agent) + '</div>';
      if (result.warnings && result.warnings.length > 0) {
        html += '<div style="margin-top:6px;"><strong>Warnings:</strong></div>';
        for (const w of result.warnings) html += '<div>• ' + escapeHtml(w) + '</div>';
      }
      vibecodemcpResultContent.innerHTML = html;
      // Refresh the overview after doctor
      void renderVibecodeMcpPanel();
    } catch (error) {
      vibecodemcpResultContent.innerHTML = '<div class="error">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</div>';
    }
  }

  async function runVibecodeMcpDryRun(agent) {
    if (!vibecodemcpResult || !vibecodemcpResultContent) return;
    vibecodemcpResult.style.display = '';
    vibecodemcpResultContent.innerHTML = '<div>Running dry-run for ' + escapeHtml(agent) + '…</div>';
    try {
      if (!window.vibecodeAPI || !window.vibecodeAPI.mcp) return;
      const result = await window.vibecodeAPI.mcp.installDryRun(agent);
      let html = '<div class="' + (result.ok ? 'ok' : 'error') + '">' + (result.ok ? 'Dry-run OK' : 'Dry-run failed') + ' for ' + escapeHtml(agent) + '</div>';
      if (result.planned_action) html += '<div style="margin-top:6px;">Planned action: ' + escapeHtml(result.planned_action) + '</div>';
      if (result.warnings && result.warnings.length > 0) {
        html += '<div style="margin-top:6px;"><strong>Warnings:</strong></div>';
        for (const w of result.warnings) html += '<div>• ' + escapeHtml(w) + '</div>';
      }
      vibecodemcpResultContent.innerHTML = html;
    } catch (error) {
      vibecodemcpResultContent.innerHTML = '<div class="error">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</div>';
    }
  }

  async function runVibecodeMcpInstall(agent) {
    if (!vibecodemcpResult || !vibecodemcpResultContent) return;
    vibecodemcpResult.style.display = '';
    vibecodemcpResultContent.innerHTML = '<div>Installing / updating for ' + escapeHtml(agent) + '…</div>';
    try {
      if (!window.vibecodeAPI || !window.vibecodeAPI.mcp) return;
      const result = await window.vibecodeAPI.mcp.install(agent, true);
      let html = '<div class="' + (result.ok ? 'ok' : 'error') + '">' + (result.ok ? 'Install OK' : 'Install failed') + ' for ' + escapeHtml(agent) + '</div>';
      if (result.planned_action) html += '<div style="margin-top:6px;">Action: ' + escapeHtml(result.planned_action) + '</div>';
      if (result.warnings && result.warnings.length > 0) {
        html += '<div style="margin-top:6px;"><strong>Warnings:</strong></div>';
        for (const w of result.warnings) html += '<div>• ' + escapeHtml(w) + '</div>';
      }
      vibecodemcpResultContent.innerHTML = html;
      // Refresh the overview after install
      void renderVibecodeMcpPanel();
    } catch (error) {
      vibecodemcpResultContent.innerHTML = '<div class="error">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</div>';
    }
  }

  if (vibecodemcpRefreshBtn) {
    vibecodemcpRefreshBtn.addEventListener('click', () => {
      vibecodemcpToolCatalog = null;
      void renderVibecodeMcpPanel();
    });
  }

  if (vibecodemcpCloseBtn) {
    vibecodemcpCloseBtn.addEventListener('click', () => {
      closeVibecodeMcpPanel();
      // Reset active nav to terminals
      sidebar.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      const terminalsNav = sidebar.querySelector('[data-nav="terminals"]');
      if (terminalsNav) terminalsNav.classList.add('active');
    });
  }

  window.VibecodeMcpPanel = {
    open: openVibecodeMcpPanel,
    close: closeVibecodeMcpPanel,
    refresh: renderVibecodeMcpPanel,
  };
})();
