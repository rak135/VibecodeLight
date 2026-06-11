// MCP Tool Catalog / Agent Contract renderer (Phase 4C).
//
// Pure view helper: the renderer receives a catalog DTO from the desktop bridge
// and renders it. Tool names, schemas, descriptions, contracts, profiles, and
// safety notes are not authored here.
(function () {
  'use strict';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function humanSideEffect(value) {
    return String(value || 'unknown').replace(/_/g, ' ');
  }

  function sideEffectClass(value) {
    if (value === 'read_only') return 'read';
    if (value === 'git_mutation') return 'git';
    if (value === 'coordination_write' || value === 'generated_state_write') return 'write';
    return 'unknown';
  }

  function unique(values) {
    var out = [];
    for (var i = 0; i < values.length; i++) {
      if (values[i] && out.indexOf(values[i]) < 0) out.push(values[i]);
    }
    return out;
  }

  function matchesSideEffect(tool, filter) {
    if (!filter || filter === 'all') return true;
    if (filter === 'read_only') return tool.side_effect === 'read_only';
    if (filter === 'writes') return tool.side_effect === 'coordination_write' || tool.side_effect === 'generated_state_write';
    if (filter === 'git') return tool.side_effect === 'git_mutation';
    return tool.side_effect === filter;
  }

  function filterTools(catalog, options) {
    if (!catalog || !Array.isArray(catalog.tools)) return [];
    var query = String((options && options.query) || '').trim().toLowerCase();
    var group = (options && options.group) || 'all';
    var sideEffect = (options && options.sideEffect) || 'all';
    var profile = (options && options.profile) || 'all';
    return catalog.tools.filter(function (tool) {
      var text = [tool.name, tool.title, tool.summary, tool.description, tool.group].join(' ').toLowerCase();
      return (!query || text.indexOf(query) >= 0)
        && (group === 'all' || tool.group === group)
        && matchesSideEffect(tool, sideEffect)
        && (profile === 'all' || (Array.isArray(tool.profiles) && tool.profiles.indexOf(profile) >= 0));
    });
  }

  function option(value, label, selected) {
    return '<option value="' + escapeHtml(value) + '"' + (selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }

  function renderFilters(catalog, options) {
    var selectedGroup = (options && options.group) || 'all';
    var selectedSideEffect = (options && options.sideEffect) || 'all';
    var selectedProfile = (options && options.profile) || 'all';
    var groups = Array.isArray(catalog.groups) ? catalog.groups : [];
    var profiles = unique(catalog.tools.flatMap(function (tool) { return Array.isArray(tool.profiles) ? tool.profiles : []; })).sort();

    var groupOptions = option('all', 'All groups', selectedGroup === 'all')
      + groups.map(function (group) { return option(group.id, group.title || group.id, selectedGroup === group.id); }).join('');
    var profileOptions = option('all', 'All profiles', selectedProfile === 'all')
      + profiles.map(function (profile) { return option(profile, profile, selectedProfile === profile); }).join('');
    var sideOptions = [
      ['all', 'All effects'],
      ['read_only', 'Read-only'],
      ['writes', 'Writes'],
      ['git', 'Git'],
    ].map(function (item) { return option(item[0], item[1], selectedSideEffect === item[0]); }).join('');

    return '<div class="mcp-catalog-filters">'
      + '<input type="search" data-filter="search" value="' + escapeHtml((options && options.query) || '') + '" placeholder="Search tools" aria-label="Search MCP tools" />'
      + '<select data-filter="group" aria-label="Filter by group">' + groupOptions + '</select>'
      + '<select data-filter="side-effect" aria-label="Filter by side effect">' + sideOptions + '</select>'
      + '<select data-filter="profile" aria-label="Filter by profile">' + profileOptions + '</select>'
      + '</div>';
  }

  function renderBadges(tool) {
    var html = '<span class="mcp-badge side-effect ' + sideEffectClass(tool.side_effect) + '">' + escapeHtml(humanSideEffect(tool.side_effect)) + '</span>';
    var profiles = Array.isArray(tool.profiles) ? tool.profiles.slice(0, 3) : [];
    for (var i = 0; i < profiles.length; i++) {
      html += '<span class="mcp-badge profile">' + escapeHtml(profiles[i]) + '</span>';
    }
    return html;
  }

  function renderToolList(catalog, tools, selectedName) {
    if (tools.length === 0) {
      return '<div class="mcp-catalog-empty">No tools match the current filters.</div>';
    }
    var groups = Array.isArray(catalog.groups) ? catalog.groups : [];
    var groupTitles = {};
    for (var i = 0; i < groups.length; i++) groupTitles[groups[i].id] = groups[i].title || groups[i].id;
    var byGroup = {};
    tools.forEach(function (tool) {
      if (!byGroup[tool.group]) byGroup[tool.group] = [];
      byGroup[tool.group].push(tool);
    });
    var html = '<div class="mcp-tool-list">';
    Object.keys(byGroup).forEach(function (group) {
      html += '<div class="mcp-tool-group"><div class="mcp-tool-group-title">' + escapeHtml(groupTitles[group] || group) + '</div>';
      byGroup[group].forEach(function (tool) {
        var active = tool.name === selectedName ? ' active' : '';
        html += '<button class="mcp-tool-card' + active + '" type="button" data-tool-name="' + escapeHtml(tool.name) + '">'
          + '<span class="mcp-tool-card-head"><code>' + escapeHtml(tool.name) + '</code><span>' + escapeHtml(tool.title) + '</span></span>'
          + '<span class="mcp-tool-summary">' + escapeHtml(tool.summary) + '</span>'
          + '<span class="mcp-tool-card-meta">' + escapeHtml(groupTitles[tool.group] || tool.group) + ' ' + renderBadges(tool) + '</span>'
          + '</button>';
      });
      html += '</div>';
    });
    return html + '</div>';
  }

  function renderList(values, emptyLabel) {
    if (!Array.isArray(values) || values.length === 0) return '<div class="mcp-none">' + escapeHtml(emptyLabel) + '</div>';
    return '<ul>' + values.map(function (value) { return '<li>' + escapeHtml(value) + '</li>'; }).join('') + '</ul>';
  }

  function renderSchema(schema) {
    return '<pre class="mcp-schema">' + escapeHtml(JSON.stringify(schema || {}, null, 2)) + '</pre>';
  }

  function renderDetail(tool) {
    if (!tool) {
      return '<div class="mcp-tool-detail empty">Select a tool to inspect its agent contract.</div>';
    }
    var important = Array.isArray(tool.output_contract && tool.output_contract.important_fields)
      ? tool.output_contract.important_fields
      : [];
    return '<div class="mcp-tool-detail">'
      + '<div class="mcp-detail-head"><div><h3>' + escapeHtml(tool.title) + '</h3><code>' + escapeHtml(tool.name) + '</code></div><div class="mcp-detail-badges">' + renderBadges(tool) + '</div></div>'
      + '<p>' + escapeHtml(tool.description) + '</p>'
      + '<div class="mcp-detail-section"><h5>When to use</h5><p>' + escapeHtml(tool.summary) + '</p></div>'
      + '<div class="mcp-detail-section"><h5>Inputs</h5>' + renderSchema(tool.input_schema) + '</div>'
      + '<div class="mcp-detail-section"><h5>What the agent receives</h5><p>' + escapeHtml(tool.output_contract ? tool.output_contract.summary : '') + '</p>'
      + (important.length > 0 ? '<div class="mcp-fields">' + important.map(function (field) { return '<code>' + escapeHtml(field) + '</code>'; }).join('') + '</div>' : '')
      + (tool.output_contract && tool.output_contract.text_output_notes ? '<p class="mcp-muted">' + escapeHtml(tool.output_contract.text_output_notes) + '</p>' : '')
      + '</div>'
      + '<div class="mcp-detail-section"><h5>CLI equivalent</h5>' + renderList(tool.cli_equivalents, 'None') + '</div>'
      + '<div class="mcp-detail-section"><h5>Profiles</h5>' + renderList(tool.profiles, 'No profile currently recommends this tool') + '</div>'
      + '<div class="mcp-detail-section"><h5>Safety notes</h5>' + renderList(tool.safety_notes, 'No safety notes') + '</div>'
      + '<div class="mcp-detail-section"><h5>Source/tests</h5><div class="mcp-maintainer"><div><strong>Source</strong>' + renderList(tool.source_files, 'None') + '</div><div><strong>Tests</strong>' + renderList(tool.test_files, 'None') + '</div></div></div>'
      + '</div>';
  }

  function renderCatalogHtml(catalog, options) {
    if (!catalog || !Array.isArray(catalog.tools)) {
      return '<div class="mcp-catalog-empty">MCP tool catalog is unavailable.</div>';
    }
    var opts = options || {};
    var tools = filterTools(catalog, opts);
    var selectedName = opts.selectedName || (tools[0] && tools[0].name) || '';
    var selected = catalog.tools.find(function (tool) { return tool.name === selectedName; }) || tools[0] || null;
    var warningHtml = Array.isArray(catalog.warnings) && catalog.warnings.length > 0
      ? '<div class="mcp-catalog-warning">' + catalog.warnings.map(escapeHtml).join('<br>') + '</div>'
      : '';
    return '<div class="mcp-catalog">'
      + '<div class="mcp-catalog-head"><div><h3>MCP Tools</h3><p>' + escapeHtml(catalog.tool_count) + ' tools · loaded from registry/schema/profile metadata</p></div>'
      + '<span class="mcp-source-badge">loaded from registry</span></div>'
      + warningHtml
      + renderFilters(catalog, opts)
      + '<div class="mcp-catalog-grid">'
      + renderToolList(catalog, tools, selected && selected.name)
      + renderDetail(selected)
      + '</div>'
      + '</div>';
  }

  var api = {
    filterTools: filterTools,
    renderCatalogHtml: renderCatalogHtml,
  };

  if (typeof window !== 'undefined') {
    window.VibecodeMcpToolsPanel = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
