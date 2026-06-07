// Read-only coordination observability panel (Phase 5A).
//
// Renders a compact, READ-ONLY summary of the multi-agent coordination overview
// (agents / claims / conflicts / evidence) for the right-panel inspector. This
// surface is visibility-only: it renders NO interactive controls and never
// mutates coordination state. There are deliberately no claim release, conflict
// resolve, stale-claim reap, scoped-commit, or watcher start/stop affordances.
//
// To keep read-only status words from looking like action verbs, lifecycle
// statuses are displayed with neutral labels (a released claim shows "closed",
// a detected conflict shows "open"); the underlying state is never changed.
(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isWarnAgentStatus(status) {
    return status === 'stale' || status === 'terminated' || status === 'unknown';
  }

  function isWarnClaimStatus(status) {
    return status === 'stale' || status === 'unknown';
  }

  function claimStatusLabel(status) {
    return status === 'released' ? 'closed' : String(status || '');
  }

  function conflictStatusLabel(status) {
    if (status === 'detected') return 'open';
    if (status === 'resolved') return 'closed';
    return String(status || '');
  }

  function chip(label, value, warn) {
    var cls = 'coord-chip' + (warn ? ' coord-warn' : '');
    return '<span class="' + cls + '">' + escapeHtml(label) + ' ' + escapeHtml(value) + '</span>';
  }

  function sectionHead(title, chipsHtml) {
    return '<div class="coord-sec-head"><span class="coord-sec-title">' + escapeHtml(title) + '</span>'
      + '<span class="coord-chips">' + chipsHtml + '</span></div>';
  }

  function renderAgents(agents) {
    var chips = chip('total', agents.total)
      + chip('active', agents.active)
      + chip('stale', agents.stale, agents.stale > 0)
      + chip('terminated', agents.terminated, agents.terminated > 0);
    var rows = '';
    for (var i = 0; i < agents.items.length; i++) {
      var a = agents.items[i];
      var warn = isWarnAgentStatus(a.status);
      rows += '<div class="coord-row' + (warn ? ' coord-warn' : '') + '">'
        + '<span class="coord-name">' + escapeHtml(a.name) + '</span>'
        + '<span class="coord-meta">' + escapeHtml(a.type) + '</span>'
        + '<span class="coord-status">' + escapeHtml(a.status) + '</span>'
        + '</div>';
    }
    return '<div class="coord-section">' + sectionHead('Agents', chips) + rows + '</div>';
  }

  function renderClaims(claims) {
    var chips = chip('total', claims.total)
      + chip('active', claims.active)
      + chip('stale', claims.stale, claims.stale > 0)
      + chip('closed', claims.released);
    var rows = '';
    for (var i = 0; i < claims.items.length; i++) {
      var c = claims.items[i];
      var warn = isWarnClaimStatus(c.status);
      var owner = c.agent_name ? c.agent_name : c.agent_id;
      rows += '<div class="coord-row' + (warn ? ' coord-warn' : '') + '">'
        + '<span class="coord-name">' + escapeHtml(c.path) + '</span>'
        + '<span class="coord-meta">' + escapeHtml(c.mode) + ' · ' + escapeHtml(owner) + '</span>'
        + '<span class="coord-status">' + escapeHtml(claimStatusLabel(c.status)) + '</span>'
        + '</div>';
    }
    return '<div class="coord-section">' + sectionHead('Claims', chips) + rows + '</div>';
  }

  function renderConflicts(conflicts) {
    var chips = chip('open', conflicts.unresolved, conflicts.unresolved > 0);
    var rows = '';
    for (var i = 0; i < conflicts.recent.length; i++) {
      var c = conflicts.recent[i];
      var warn = c.status === 'detected';
      var files = Array.isArray(c.involved_files) ? c.involved_files.join(', ') : '';
      rows += '<div class="coord-row' + (warn ? ' coord-warn' : '') + '">'
        + '<span class="coord-name">' + escapeHtml(c.conflict_type) + '</span>'
        + '<span class="coord-meta">' + escapeHtml(files) + '</span>'
        + '<span class="coord-status">' + escapeHtml(c.severity) + ' · ' + escapeHtml(conflictStatusLabel(c.status)) + '</span>'
        + '</div>';
    }
    return '<div class="coord-section">' + sectionHead('Conflicts', chips) + rows + '</div>';
  }

  function renderEvidence(evidence) {
    var chips = chip('recent', evidence.recent_count)
      + chip('warning', evidence.warning_count, evidence.warning_count > 0)
      + chip('high', evidence.high_count, evidence.high_count > 0);
    var last = evidence.last_event_at
      ? '<div class="coord-row"><span class="coord-meta">last event ' + escapeHtml(evidence.last_event_at) + '</span></div>'
      : '';
    return '<div class="coord-section">' + sectionHead('Evidence', chips) + last + '</div>';
  }

  function isEmptyOverview(overview) {
    return overview.agents.total === 0
      && overview.claims.total === 0
      && overview.conflicts.unresolved === 0
      && overview.conflicts.recent.length === 0
      && overview.evidence.recent_count === 0;
  }

  // Pure: build the read-only panel body HTML for a coordination overview.
  function renderCoordinationOverviewHtml(overview) {
    if (!overview) {
      return '<div class="coord-empty">No coordination overview available.</div>';
    }
    if (isEmptyOverview(overview)) {
      return '<div class="coord-empty">No coordination activity yet. '
        + 'Agents, claims, conflicts, and evidence appear here while terminal agents work.</div>';
    }
    return '<div class="coord-panel">'
      + renderAgents(overview.agents)
      + renderClaims(overview.claims)
      + renderConflicts(overview.conflicts)
      + renderEvidence(overview.evidence)
      + '<div class="coord-note">Read-only view. Coordination state is changed only by agents and the CLI.</div>'
      + '</div>';
  }

  var api = { renderCoordinationOverviewHtml: renderCoordinationOverviewHtml };

  if (typeof window !== 'undefined') {
    window.VibecodeCoordinationPanel = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
