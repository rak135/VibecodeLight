// Read-only activity observability panel (Cockpit v2).
//
// Renders a compact, READ-ONLY summary of the activity attribution overview:
// which agents use VibecodeMCP, which v1 tools they called, what they claim,
// workspace safety, stale-coordination counts, a newest-first timeline, and
// data-quality indicators. This surface is visibility-only: it renders NO
// interactive controls and never mutates coordination state. There are
// deliberately no claim/release/reap/resolve, commit, assignment, or watcher
// affordances.
//
// Honesty rules mirrored from core:
//   - tool calls without an agent_id display as "unattributed";
//   - unclaimed dirty files are workspace-level warnings, never shown under an
//     agent (no per-agent blame in a shared working tree);
//   - housekeeping commands are displayed as text to copy, never as actions;
//   - historical pre-v1 tool names have already been normalized by the core
//     overview before reaching this renderer.
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

  function renderSummaryBar(overview) {
    var ac = overview.agent_status_counts || { active: 0, stale: 0, terminated: 0, unknown: 0 };
    var safety = overview.workspace_safety || {};
    var activeAgents = (overview.agents || []).filter(function (a) { return a.status === 'active'; });
    var working = activeAgents.filter(function (a) { return a.ready_state === 'working'; }).length;
    var ready = activeAgents.filter(function (a) { return a.ready_state === 'ready_to_commit'; }).length;
    var blocked = activeAgents.filter(function (a) { return a.ready_state === 'blocked'; }).length;

    var lastTool = '';
    if (overview.recent_tool_calls && overview.recent_tool_calls.length > 0) {
      var newest = overview.recent_tool_calls[0];
      lastTool = newest.tool_name + (newest.timestamp ? ' ' + shortTime(newest.timestamp) : '');
    }

    var html = '<div class="act-summary">';
    html += chip('Active', ac.active, false);
    if (working > 0) html += chip('Working', working, false);
    if (ready > 0) html += chip('Ready', ready, false);
    if (blocked > 0) html += chip('Blocked', blocked, true);
    if (safety.unclaimed_dirty_count > 0) html += chip('Unclaimed dirty', safety.unclaimed_dirty_count, true);
    if (ac.stale > 0) html += chip('Stale', ac.stale, true);
    if (ac.terminated > 0) html += chip('Terminated', ac.terminated, true);
    if (lastTool) html += chip('Last MCP call', lastTool, false);
    html += '</div>';
    return html;
  }

  function renderAgentCard(agent) {
    var a = agent;
    var warn = isWarnReadyState(a.ready_state) || a.status === 'stale' || a.status === 'terminated' || (a.blockers && a.blockers.length > 0);
    var callText = a.mcp_tool_call_count > 0 ? 'calls ' + a.mcp_tool_call_count : 'no MCP calls';
    var counts = callText
      + (a.mcp_error_count > 0 ? ' \u00b7 errors ' + a.mcp_error_count : '')
      + ' \u00b7 claims ' + a.claimed_path_count
      + (a.dirty_claimed_path_count > 0 ? ' (' + a.dirty_claimed_path_count + ' dirty)' : '');
    var rows = '<div class="coord-row' + (warn ? ' coord-warn' : '') + '">'
      + '<span class="coord-name">' + escapeHtml(a.name || a.agent_id) + '</span>'
      + '<span class="coord-meta">' + escapeHtml((a.mode || 'mode?') + ' \u00b7 ' + counts) + '</span>'
      + '<span class="coord-status">' + escapeHtml(a.status + ' \u00b7 ' + a.ready_state) + '</span>'
      + '</div>';
    var lastTool = a.last_mcp_tool_name
      ? 'last tool ' + a.last_mcp_tool_name + (a.last_mcp_tool_at ? ' at ' + shortTime(a.last_mcp_tool_at) : '')
      : 'no MCP tool calls recorded';
    var lastActivity = a.last_activity_at ? ' \u00b7 active ' + shortTime(a.last_activity_at) : '';
    rows += '<div class="coord-row"><span class="coord-meta">' + escapeHtml(lastTool + lastActivity) + '</span></div>';
    if (a.active_intent_text) {
      rows += '<div class="coord-row"><span class="coord-meta">' + escapeHtml(a.active_intent_text) + '</span></div>';
    }
    var notices = (a.blockers || []).concat(a.warnings || []);
    for (var j = 0; j < notices.length; j++) {
      rows += '<div class="coord-row coord-warn"><span class="coord-meta">'
        + escapeHtml(notices[j].code + ': ' + notices[j].message) + '</span></div>';
    }
    return rows;
  }

  function renderAgents(agents, totalAgents, agentStatusCounts) {
    var chips = chip('total', totalAgents);
    var activeAgents = [];
    var staleAgents = [];
    var terminatedAgents = [];
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (a.status === 'active' || a.status === 'unknown') activeAgents.push(a);
      else if (a.status === 'stale') staleAgents.push(a);
      else terminatedAgents.push(a);
    }
    var rows = '';
    for (var k = 0; k < activeAgents.length; k++) {
      rows += renderAgentCard(activeAgents[k]);
    }
    if (staleAgents.length > 0) {
      rows += '<details><summary>Stale agents (' + staleAgents.length + ')</summary>';
      for (var s = 0; s < staleAgents.length; s++) {
        rows += renderAgentCard(staleAgents[s]);
      }
      rows += '</details>';
    }
    if (terminatedAgents.length > 0) {
      rows += '<details><summary>Terminated agents (' + terminatedAgents.length + ')</summary>';
      for (var t = 0; t < terminatedAgents.length; t++) {
        rows += renderAgentCard(terminatedAgents[t]);
      }
      rows += '</details>';
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
        + '<span class="coord-meta">' + escapeHtml(who + ' \u00b7 ' + shortTime(c.timestamp)) + '</span>'
        + '<span class="coord-status">' + escapeHtml(outcome + ' \u00b7 ' + c.duration_ms + 'ms') + '</span>'
        + '</div>';
    }
    return '<div class="coord-section">' + sectionHead('MCP tool calls', chips) + rows + '</div>';
  }

  function formatAge(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '';
    if (seconds < 60) return Math.max(0, Math.floor(seconds)) + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
    return Math.floor(seconds / 86400) + 'd';
  }

  function renderClaims(claims, totalClaims) {
    var chips = chip('total', totalClaims);
    var rows = '';
    var grouped = {};
    var owners = [];
    for (var i = 0; i < claims.length; i++) {
      var c = claims[i];
      var owner = c.owner_agent_id || 'unknown owner';
      if (!grouped[owner]) {
        grouped[owner] = [];
        owners.push(owner);
      }
      grouped[owner].push(c);
    }
    for (var o = 0; o < owners.length; o++) {
      var ownerId = owners[o];
      var ownerClaims = grouped[ownerId];
      rows += '<div class="coord-claim-owner">' + escapeHtml(ownerId) + '</div>';
      for (var j = 0; j < ownerClaims.length; j++) {
        var c = ownerClaims[j];
      var warn = c.status === 'dirty' || c.status === 'stale' || c.status === 'unknown';
        var age = formatAge(c.age_seconds);
        var meta = (c.intent_id ? c.intent_id : 'no intent') + (age ? ' \u00b7 age ' + age : '');
      rows += '<div class="coord-row' + (warn ? ' coord-warn' : '') + '">'
        + '<span class="coord-name">' + escapeHtml(c.path) + '</span>'
        + '<span class="coord-meta">' + escapeHtml(meta) + '</span>'
        + '<span class="coord-status">' + escapeHtml(c.status) + '</span>'
        + '</div>';
      }
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
    return '<div class="coord-section act-safety-' + escapeHtml(safety.safety_level) + '">'
      + sectionHead('Workspace safety', chips) + rows + '</div>';
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

  function severityClass(severity) {
    if (severity === 'error') return ' act-sev-error';
    if (severity === 'warning' || severity === 'blocked') return ' act-sev-warn';
    if (severity === 'success') return ' act-sev-success';
    return '';
  }

  function renderTimeline(timeline) {
    if (!Array.isArray(timeline) || timeline.length === 0) return '';
    var rows = '';
    for (var i = 0; i < timeline.length; i++) {
      var ev = timeline[i];
      var who = ev.agent_id ? (ev.agent_label || ev.agent_id) : 'unattributed';
      var sevCls = severityClass(ev.severity);
      var detail = '';
      if (ev.kind === 'mcp_tool_call') {
        detail = escapeHtml(ev.tool_name || '') + ' ' + escapeHtml(ev.summary || '');
      } else if (ev.kind === 'claim_added' || ev.kind === 'claim_released') {
        detail = escapeHtml(ev.summary || '');
        if (ev.intent_id) detail += ' \u00b7 ' + escapeHtml(ev.intent_id);
      } else {
        detail = escapeHtml(ev.summary || ev.kind || '');
      }
      rows += '<div class="coord-row act-timeline-row' + sevCls + '">'
        + '<span class="coord-meta">' + escapeHtml(shortTime(ev.timestamp)) + ' \u00b7 ' + escapeHtml(who) + '</span>'
        + '<span class="coord-name">' + detail + '</span>'
        + '</div>';
    }
    var total = (timeline.length) + (timeline.length < (timeline.total || timeline.length) ? ' (truncated)' : '');
    return '<div class="coord-section">' + sectionHead('Timeline', chip('events', timeline.length)) + rows + '</div>';
  }

  function renderDataQuality(dq) {
    if (!dq) return '';
    var chips = '';
    if (dq.usage_log && dq.usage_log !== 'ok') chips += chip('usage log', dq.usage_log, true);
    if (dq.attributed_call_count > 0) chips += chip(dq.attributed_call_count + ' attributed', '', false);
    if (dq.unattributed_call_count > 0) chips += chip(dq.unattributed_call_count + ' unattributed', '', false);
    if (dq.malformed_line_count > 0) chips += chip(dq.malformed_line_count + ' malformed', '', true);
    if (dq.git_classification && dq.git_classification !== 'ok') chips += chip('git', dq.git_classification, true);
    if (!chips) return '';
    return '<div class="coord-section">' + sectionHead('Data quality', chips) + '</div>';
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
      && (!overview.timeline || overview.timeline.length === 0)
      && !overview.workspace_safety.has_suspicious_unclaimed_dirty
      && !overview.stale_coordination.has_stale_state;
  }

  function isOnlyStaleHistory(overview) {
    if (overview.recent_tool_calls.length > 0) return false;
    if (overview.agents.length === 0) return false;
    return overview.agents.every(function (a) {
      return a.status !== 'active' && (a.mcp_tool_call_count === 0);
    });
  }

  // Pure: build the read-only panel body HTML for an activity overview.
  function renderActivityOverviewHtml(overview) {
    if (!overview) {
      return '<div class="coord-empty">No activity overview available.</div>';
    }
    if (isEmptyOverview(overview)) {
      return '<div class="coord-empty">No attributed MCP activity yet. '
        + 'Agents, tool calls, claims, and safety state appear here once agents use '
        + 'vibecode_session_start and call VibecodeMCP tools.</div>';
    }
    var staleOnly = isOnlyStaleHistory(overview);
    var html = '<div class="coord-panel">';
    if (!staleOnly) {
      html += renderSummaryBar(overview);
    }
    html += renderAgents(overview.agents, overview.totals.agents, overview.agent_status_counts);
    if (staleOnly) {
      html += '<div class="coord-section"><div class="coord-sec-head">'
        + '<span class="coord-sec-title">No recent attributed MCP activity</span></div></div>';
    } else {
      html += renderToolCalls(overview.recent_tool_calls, overview.totals.tool_calls_in_window);
    }
    html += renderTimeline(overview.timeline);
    html += renderClaims(overview.claims, overview.totals.claims);
    html += renderSafety(overview.workspace_safety);
    html += renderStaleCoordination(overview.stale_coordination);
    html += renderDataQuality(overview.data_quality);
    html += renderOverviewWarnings(overview.warnings);
    html += '<div class="coord-note">Read-only view. Unclaimed dirty files are workspace warnings \u2014 '
      + 'in a shared working tree they cannot be attributed to a specific agent.</div>';
    html += '</div>';
    return html;
  }

  var api = { renderActivityOverviewHtml: renderActivityOverviewHtml };

  if (typeof window !== 'undefined') {
    window.VibecodeActivityPanel = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
