// Read-only activity observability panel.
//
// Renders a compact, READ-ONLY summary of the activity attribution overview:
// which agents use VibecodeMCP, which v1 tools they called, what they claim,
// workspace safety, and stale-coordination counts. This surface is
// visibility-only: it renders NO interactive controls and never mutates
// coordination state. There are deliberately no claim/release/reap/resolve,
// commit, assignment, or watcher affordances.
//
// Honesty rules mirrored from core:
//   - tool calls without an agent_id display as "unattributed";
//   - unclaimed dirty files are workspace-level warnings, never shown under an
//     agent (no per-agent blame in a shared working tree);
//   - housekeeping commands are displayed as text to copy, never as actions.
(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function shortTime(iso) {
    if (typeof iso !== 'string' || iso.length < 19) return String(iso || '');
    return iso.replace('T', ' ').slice(0, 19);
  }

  function chip(label, value, warn) {
    var cls = 'coord-chip' + (warn ? ' coord-warn' : '');
    return '<span class="' + cls + '">' + escapeHtml(label) + ' ' + escapeHtml(value) + '</span>';
  }

  function sectionHead(title, chipsHtml) {
    return '<div class="coord-sec-head"><span class="coord-sec-title">' + escapeHtml(title) + '</span>'
      + '<span class="coord-chips">' + (chipsHtml || '') + '</span></div>';
  }

  function isWarnReadyState(readyState) {
    return readyState === 'blocked' || readyState === 'unknown';
  }

  function renderAgents(agents, totalAgents) {
    var chips = chip('total', totalAgents);
    var rows = '';
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      var warn = isWarnReadyState(a.ready_state) || a.status === 'stale' || a.status === 'terminated' || a.blockers.length > 0;
      var counts = 'calls ' + a.mcp_tool_call_count
        + (a.mcp_error_count > 0 ? ' · errors ' + a.mcp_error_count : '')
        + ' · claims ' + a.claimed_path_count
        + (a.dirty_claimed_path_count > 0 ? ' (' + a.dirty_claimed_path_count + ' dirty)' : '');
      rows += '<div class="coord-row' + (warn ? ' coord-warn' : '') + '">'
        + '<span class="coord-name">' + escapeHtml(a.name || a.agent_id) + '</span>'
        + '<span class="coord-meta">' + escapeHtml((a.mode || 'mode?') + ' · ' + counts) + '</span>'
        + '<span class="coord-status">' + escapeHtml(a.status + ' · ' + a.ready_state) + '</span>'
        + '</div>';
      var lastTool = a.last_mcp_tool_name
        ? 'last tool ' + a.last_mcp_tool_name + (a.last_mcp_tool_at ? ' at ' + shortTime(a.last_mcp_tool_at) : '')
        : 'no MCP tool calls recorded';
      var lastActivity = a.last_activity_at ? ' · active ' + shortTime(a.last_activity_at) : '';
      rows += '<div class="coord-row"><span class="coord-meta">' + escapeHtml(lastTool + lastActivity) + '</span></div>';
      var notices = a.blockers.concat(a.warnings);
      for (var j = 0; j < notices.length; j++) {
        rows += '<div class="coord-row coord-warn"><span class="coord-meta">'
          + escapeHtml(notices[j].code + ': ' + notices[j].message) + '</span></div>';
      }
    }
    return '<div class="coord-section">' + sectionHead('Agents', chips) + rows + '</div>';
  }

  function renderToolCalls(calls, totalInWindow) {
    var chips = chip('recent', calls.length) + chip('in window', totalInWindow);
    var rows = '';
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i];
      var who = c.agent_id ? c.agent_id : 'unattributed';
      var outcome = c.ok ? 'ok' : 'error' + (c.error_code ? ' ' + c.error_code : '');
      rows += '<div class="coord-row' + (c.ok ? '' : ' coord-warn') + '">'
        + '<span class="coord-name">' + escapeHtml(c.tool_name) + '</span>'
        + '<span class="coord-meta">' + escapeHtml(who + ' · ' + shortTime(c.timestamp)) + '</span>'
        + '<span class="coord-status">' + escapeHtml(outcome + ' · ' + c.duration_ms + 'ms') + '</span>'
        + '</div>';
    }
    return '<div class="coord-section">' + sectionHead('MCP tool calls', chips) + rows + '</div>';
  }

  function renderClaims(claims, totalClaims) {
    var chips = chip('total', totalClaims);
    var rows = '';
    for (var i = 0; i < claims.length; i++) {
      var c = claims[i];
      var warn = c.status === 'dirty' || c.status === 'stale' || c.status === 'unknown';
      var meta = c.owner_agent_id + (c.intent_id ? ' · ' + c.intent_id : '');
      rows += '<div class="coord-row' + (warn ? ' coord-warn' : '') + '">'
        + '<span class="coord-name">' + escapeHtml(c.path) + '</span>'
        + '<span class="coord-meta">' + escapeHtml(meta) + '</span>'
        + '<span class="coord-status">' + escapeHtml(c.status) + '</span>'
        + '</div>';
    }
    return '<div class="coord-section">' + sectionHead('Claims', chips) + rows + '</div>';
  }

  function renderSafety(safety) {
    var chips = chip('level', safety.safety_level, safety.safety_level !== 'ok')
      + chip('unclaimed dirty', safety.unclaimed_dirty_count, safety.unclaimed_dirty_count > 0)
      + chip('staged unclaimed', safety.staged_unclaimed_count, safety.staged_unclaimed_count > 0)
      + chip('claimed dirty', safety.foreign_claimed_dirty_count)
      + chip('generated', safety.generated_or_ignored_count);
    var rows = '';
    for (var i = 0; i < safety.warnings.length; i++) {
      var w = safety.warnings[i];
      rows += '<div class="coord-row coord-warn"><span class="coord-meta">' + escapeHtml(w.message) + '</span></div>';
      if (Array.isArray(w.sample_paths) && w.sample_paths.length > 0) {
        rows += '<div class="coord-row coord-warn"><span class="coord-name">'
          + escapeHtml(w.sample_paths.join(', ')) + '</span></div>';
      }
    }
    return '<div class="coord-section">' + sectionHead('Workspace safety', chips) + rows + '</div>';
  }

  function renderStaleCoordination(stale) {
    var chips = chip('stale agents', stale.stale_agent_count, stale.stale_agent_count > 0)
      + chip('stale claims', stale.stale_claim_count, stale.stale_claim_count > 0)
      + chip('stale intents', stale.stale_intent_count, stale.stale_intent_count > 0);
    var rows = '';
    for (var i = 0; i < stale.housekeeping_commands.length; i++) {
      rows += '<div class="coord-row"><span class="coord-meta"><code>'
        + escapeHtml(stale.housekeeping_commands[i]) + '</code></span></div>';
    }
    return '<div class="coord-section">' + sectionHead('Stale coordination', chips) + rows + '</div>';
  }

  function renderOverviewWarnings(warnings) {
    if (!warnings.length) return '';
    var rows = '';
    for (var i = 0; i < warnings.length; i++) {
      rows += '<div class="coord-row"><span class="coord-meta">' + escapeHtml(warnings[i].message) + '</span></div>';
    }
    return '<div class="coord-section">' + sectionHead('Notes', '') + rows + '</div>';
  }

  function isEmptyOverview(overview) {
    return overview.agents.length === 0
      && overview.recent_tool_calls.length === 0
      && overview.claims.length === 0
      && overview.totals.agents === 0
      && overview.totals.claims === 0
      && overview.totals.tool_calls_in_window === 0
      && !overview.workspace_safety.has_suspicious_unclaimed_dirty
      && !overview.stale_coordination.has_stale_state;
  }

  // Pure: build the read-only panel body HTML for an activity overview.
  function renderActivityOverviewHtml(overview) {
    if (!overview) {
      return '<div class="coord-empty">No activity overview available.</div>';
    }
    if (isEmptyOverview(overview)) {
      return '<div class="coord-empty">No MCP activity yet. '
        + 'Agents, tool calls, claims, and safety state appear here once agents use VibecodeMCP.</div>';
    }
    return '<div class="coord-panel">'
      + renderAgents(overview.agents, overview.totals.agents)
      + renderToolCalls(overview.recent_tool_calls, overview.totals.tool_calls_in_window)
      + renderClaims(overview.claims, overview.totals.claims)
      + renderSafety(overview.workspace_safety)
      + renderStaleCoordination(overview.stale_coordination)
      + renderOverviewWarnings(overview.warnings)
      + '<div class="coord-note">Read-only view. Unclaimed dirty files are workspace warnings — '
      + 'in a shared working tree they cannot be attributed to a specific agent.</div>'
      + '</div>';
  }

  var api = { renderActivityOverviewHtml: renderActivityOverviewHtml };

  if (typeof window !== 'undefined') {
    window.VibecodeActivityPanel = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
