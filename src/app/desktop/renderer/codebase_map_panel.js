/**
 * Codebase Map panel module: renders a read-only 2D SVG map of the codebase
 * with CAD-like viewport controls (zoom toward cursor, pan, fit, reset),
 * legend, hover tooltip, node selection/detail panel, focus/dimming,
 * search centering, and Entrypoints/Changed filters.
 */

/** @type {CodebaseMapPanelModule | undefined} */
window.CodebaseMapPanel = undefined;

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const panel = $('codebase-map-panel');
  const mapRepo = $('codebase-map-repo');
  const mapMeta = $('codebase-map-meta');
  const mapSvg = $('codebase-map-svg');
  const mapEmpty = $('codebase-map-empty');
  const mapRefreshBtn = $('codebase-map-refresh');
  const mapCloseBtn = $('codebase-map-close');
  const mapFilterChips = $('codebase-map-filters');
  const mapSearchInput = $('codebase-map-search');
  const mapEdgesToggle = $('codebase-map-edges-toggle');
  const mapFitBtn = $('codebase-map-fit');
  const mapResetBtn = $('codebase-map-reset');
  const legendNodes = $('cmap-legend-nodes');
  const legendEdges = $('cmap-legend-edges');
  const legendStatus = $('cmap-legend-status');
  const tooltipEl = $('cmap-tooltip');
  const detailPanel = $('cmap-detail');
  const detailTitle = $('cmap-detail-title');
  const detailBody = $('cmap-detail-body');
  const detailCloseBtn = $('cmap-detail-close');

  let lastOverview = null;
  let activeFilter = 'all';
  let searchQuery = '';
  let showEdges = true;
  let selectedNodeId = null;
  let hoveredNodeId = null;

  // CAD viewport state
  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 20;
  const ZOOM_FACTOR = 1.15;
  const NODE_W = 140;
  const NODE_H = 32;

  const viewport = {
    scale: 1,
    tx: 0,
    ty: 0,
    isPanning: false,
    lastPointerX: 0,
    lastPointerY: 0,
    panButton: -1,
  };

  // Store content bounds for fitToView
  let contentBounds = { x: 0, y: 0, w: 100, h: 100 };
  // Store node positions for centering
  let nodePositions = new Map();

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const KIND_COLORS = {
    source: '#4fc3f7',
    test: '#81c784',
    doc: '#ffb74d',
    config: '#ba68c8',
    generated: '#90a4ae',
    unknown: '#78909c',
  };

  const KIND_LABELS = {
    source: 'Source',
    test: 'Test',
    doc: 'Doc',
    config: 'Config',
    generated: 'Generated',
    unknown: 'Unknown',
  };

  const EDGE_COLORS = {
    import: 'rgba(79,195,247,0.35)',
    test: 'rgba(129,199,132,0.35)',
    entrypoint: 'rgba(255,183,77,0.35)',
    folder: 'rgba(144,164,174,0.2)',
    related: 'rgba(186,104,200,0.3)',
  };

  const EDGE_LABELS = {
    import: 'Import',
    test: 'Test relation',
    entrypoint: 'Entrypoint',
    folder: 'Folder',
    related: 'Related',
  };

  // ============ Legend ============

  function renderLegend() {
    if (legendNodes) {
      let html = '';
      for (const [kind, color] of Object.entries(KIND_COLORS)) {
        html += `<div class="cmap-legend-item"><span class="cmap-legend-dot" style="background:${color}"></span>${KIND_LABELS[kind] || kind}</div>`;
      }
      legendNodes.innerHTML = html;
    }
    if (legendEdges) {
      let html = '';
      for (const [type, color] of Object.entries(EDGE_COLORS)) {
        html += `<div class="cmap-legend-item"><span class="cmap-legend-line" style="background:${color}"></span>${EDGE_LABELS[type] || type}</div>`;
      }
      legendEdges.innerHTML = html;
    }
    if (legendStatus) {
      legendStatus.innerHTML = [
        '<div class="cmap-legend-item"><span class="cmap-legend-badge" style="border-color:#ff9800"></span>Changed</div>',
        '<div class="cmap-legend-item"><span class="cmap-legend-badge" style="border-color:#4fc3f7"></span>Entrypoint</div>',
        '<div class="cmap-legend-item"><span class="cmap-legend-badge" style="border-color:var(--accent)"></span>Selected</div>',
      ].join('');
    }
  }

  // ============ Tooltip ============

  function showTooltip(node, clientX, clientY) {
    if (!tooltipEl) return;
    const badges = [];
    if (node.changed) badges.push('<span class="tt-badge" style="color:#ff9800;border-color:#ff9800">changed</span>');
    if (node.entrypoint) badges.push('<span class="tt-badge" style="color:#4fc3f7;border-color:#4fc3f7">entrypoint</span>');

    let html = `<div class="tt-path">${escapeHtml(node.path)}</div>`;
    html += `<div class="tt-row"><span class="tt-key">kind</span><span>${escapeHtml(node.kind)}</span></div>`;
    if (node.language) html += `<div class="tt-row"><span class="tt-key">language</span><span>${escapeHtml(node.language)}</span></div>`;
    html += `<div class="tt-row"><span class="tt-key">group</span><span>${escapeHtml(node.group)}</span></div>`;
    if (node.lines !== undefined) html += `<div class="tt-row"><span class="tt-key">lines</span><span>${node.lines}</span></div>`;
    if (badges.length > 0) html += `<div class="tt-badges">${badges.join('')}</div>`;

    tooltipEl.innerHTML = html;
    tooltipEl.style.display = 'block';

    // Position tooltip near cursor, keeping it within viewport
    const panelRect = panel ? panel.getBoundingClientRect() : { left: 0, top: 0 };
    const ttW = tooltipEl.offsetWidth || 200;
    const ttH = tooltipEl.offsetHeight || 80;
    let tx = clientX - panelRect.left + 12;
    let ty = clientY - panelRect.top - 10;
    if (tx + ttW > (panelRect.width || 800) - 10) tx = tx - ttW - 24;
    if (ty + ttH > (panelRect.height || 600) - 10) ty = ty - ttH - 20;
    tooltipEl.style.left = tx + 'px';
    tooltipEl.style.top = ty + 'px';
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  // ============ Node Detail ============

  function getNodeDetail(overview, nodeId) {
    const node = overview.nodes.find((n) => n.id === nodeId);
    if (!node) return null;

    const imports_out = [];
    const imports_in = [];
    const related_tests = [];
    const edge_evidence = [];

    for (const edge of overview.edges) {
      if (edge.from === nodeId) {
        if (edge.type === 'import') imports_out.push(edge.to);
        if (edge.type === 'test') related_tests.push(edge.to);
        edge_evidence.push({ edge_id: edge.id, type: edge.type, evidence: edge.evidence, direction: 'outgoing', peer: edge.to });
      } else if (edge.to === nodeId) {
        if (edge.type === 'import') imports_in.push(edge.from);
        if (edge.type === 'test') related_tests.push(edge.from);
        edge_evidence.push({ edge_id: edge.id, type: edge.type, evidence: edge.evidence, direction: 'incoming', peer: edge.from });
      }
    }

    return {
      ...node,
      changed: node.changed === true,
      entrypoint: node.entrypoint === true,
      imports_out,
      imports_in,
      related_tests,
      edge_evidence,
    };
  }

  function getConnectedNeighborhood(overview, nodeId) {
    const nodeIds = new Set();
    const edgeIds = new Set();
    const node = overview.nodes.find((n) => n.id === nodeId);
    if (!node) return { nodeIds, edgeIds };
    nodeIds.add(nodeId);
    for (const edge of overview.edges) {
      if (edge.from === nodeId) { nodeIds.add(edge.to); edgeIds.add(edge.id); }
      else if (edge.to === nodeId) { nodeIds.add(edge.from); edgeIds.add(edge.id); }
    }
    return { nodeIds, edgeIds };
  }

  function renderDetailPanel(nodeId) {
    if (!detailPanel || !detailTitle || !detailBody || !lastOverview) return;
    const detail = getNodeDetail(lastOverview, nodeId);
    if (!detail) { detailPanel.style.display = 'none'; return; }

    detailPanel.style.display = '';
    detailTitle.textContent = detail.path;

    let html = '';

    // Basic info
    html += '<div class="cmap-detail-section">';
    html += '<div class="cmap-detail-section-title">File Info</div>';
    html += row('path', detail.path);
    html += row('kind', detail.kind);
    if (detail.language) html += row('language', detail.language);
    html += row('group', detail.group);
    if (detail.lines !== undefined) html += row('lines', String(detail.lines));
    if (detail.changed) html += row('changed', 'yes');
    if (detail.entrypoint) html += row('entrypoint', 'yes');
    html += '</div>';

    // Imports out
    html += '<div class="cmap-detail-section">';
    html += '<div class="cmap-detail-section-title">Imports Out (' + detail.imports_out.length + ')</div>';
    if (detail.imports_out.length > 0) {
      html += '<div class="cmap-detail-list">';
      for (const imp of detail.imports_out) {
        html += `<div class="cmap-detail-list-item edge-import">${escapeHtml(imp)}</div>`;
      }
      html += '</div>';
    } else {
      html += '<div class="cmap-detail-empty">No outgoing imports</div>';
    }
    html += '</div>';

    // Imports in
    html += '<div class="cmap-detail-section">';
    html += '<div class="cmap-detail-section-title">Imported By (' + detail.imports_in.length + ')</div>';
    if (detail.imports_in.length > 0) {
      html += '<div class="cmap-detail-list">';
      for (const imp of detail.imports_in) {
        html += `<div class="cmap-detail-list-item edge-import">${escapeHtml(imp)}</div>`;
      }
      html += '</div>';
    } else {
      html += '<div class="cmap-detail-empty">Not imported by other files</div>';
    }
    html += '</div>';

    // Related tests
    html += '<div class="cmap-detail-section">';
    html += '<div class="cmap-detail-section-title">Related Tests (' + detail.related_tests.length + ')</div>';
    if (detail.related_tests.length > 0) {
      html += '<div class="cmap-detail-list">';
      for (const t of detail.related_tests) {
        html += `<div class="cmap-detail-list-item edge-test">${escapeHtml(t)}</div>`;
      }
      html += '</div>';
    } else {
      html += '<div class="cmap-detail-empty">No related tests</div>';
    }
    html += '</div>';

    // Edge evidence
    if (detail.edge_evidence.length > 0) {
      html += '<div class="cmap-detail-section">';
      html += '<div class="cmap-detail-section-title">Edges (' + detail.edge_evidence.length + ')</div>';
      html += '<div class="cmap-detail-list">';
      for (const ev of detail.edge_evidence) {
        const cls = 'edge-' + (ev.type || 'folder');
        const label = ev.direction === 'outgoing' ? '\u2192' : '\u2190';
        html += `<div class="cmap-detail-list-item ${cls}">${escapeHtml(ev.peer)} ${label} ${escapeHtml(ev.type)}${ev.evidence ? ' (' + escapeHtml(ev.evidence) + ')' : ''}</div>`;
      }
      html += '</div>';
      html += '</div>';
    }

    detailBody.innerHTML = html;
  }

  function row(key, val) {
    return `<div class="cmap-detail-row"><span class="dkey">${escapeHtml(key)}</span><span class="dval">${escapeHtml(val)}</span></div>`;
  }

  function clearSelection() {
    selectedNodeId = null;
    if (detailPanel) detailPanel.style.display = 'none';
    updateSvg();
  }

  // ============ Focus / Dimming ============

  function getFocusNodeIds(overview, nodeId) {
    if (!nodeId) return null;
    const neighborhood = getConnectedNeighborhood(overview, nodeId);
    return neighborhood.nodeIds;
  }

  // ============ Search centering ============

  function centerOnNode(nodeId) {
    const pos = nodePositions.get(nodeId);
    if (!pos || !mapSvg) return;
    const rect = mapSvg.getBoundingClientRect();
    const viewW = rect.width || mapSvg.clientWidth || 800;
    const viewH = rect.height || mapSvg.clientHeight || 600;
    const nodeCenterX = pos.x + NODE_W / 2;
    const nodeCenterY = pos.y + NODE_H / 2;

    // Center the node in the viewport
    viewport.scale = 1.5; // zoom in a bit
    viewport.tx = viewW / 2 - nodeCenterX * viewport.scale;
    viewport.ty = viewH / 2 - nodeCenterY * viewport.scale;
    applyViewportTransform();
  }

  // ============ Filters ============

  function filterNodes(nodes, filter, query) {
    let filtered = nodes;
    if (filter === 'entrypoints') {
      filtered = filtered.filter((n) => n.entrypoint === true);
    } else if (filter === 'changed') {
      filtered = filtered.filter((n) => n.changed === true);
    } else if (filter !== 'all') {
      filtered = filtered.filter((n) => n.kind === filter);
    }
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter((n) => n.path.toLowerCase().includes(q) || n.label.toLowerCase().includes(q));
    }
    return filtered;
  }

  function buildNodeIndex(nodes) {
    const index = new Map();
    for (const node of nodes) {
      index.set(node.id, node);
    }
    return index;
  }

  /**
   * Pure render function: produces SVG HTML from an overview DTO.
   * Includes a viewport group for CAD-like pan/zoom transforms,
   * focus/dimming, and highlight for selected node.
   */
  function renderCodebaseMapSvgHtml(overview, filter, query, edgesVisible, focusNodeId) {
    if (!overview || !overview.ok || overview.nodes.length === 0) {
      return '';
    }

    const filteredNodes = filterNodes(overview.nodes, filter, query);
    if (filteredNodes.length === 0) {
      return '';
    }

    const nodeIndex = buildNodeIndex(overview.nodes);
    const nodeIdSet = new Set(filteredNodes.map((n) => n.id));

    // Focus: determine which nodes are connected to the selected node
    const focusNodeIds = focusNodeId ? getFocusNodeIds(overview, focusNodeId) : null;

    // Layout: group nodes by group, arrange in columns
    const groups = new Map();
    for (const node of filteredNodes) {
      const existing = groups.get(node.group) ?? [];
      existing.push(node);
      groups.set(node.group, existing);
    }

    const PADDING = 16;
    const GROUP_GAP = 24;
    const NODE_GAP = 8;
    const GROUP_HEADER_H = 24;

    // Calculate positions
    const positions = new Map();
    let x = PADDING;
    const groupEntries = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    for (const [groupName, groupNodes] of groupEntries) {
      let y = PADDING + GROUP_HEADER_H;
      for (const node of groupNodes) {
        positions.set(node.id, { x, y });
        y += NODE_H + NODE_GAP;
      }
      x += NODE_W + GROUP_GAP;
    }

    // Store positions for centering
    nodePositions = positions;

    const totalW = x - GROUP_GAP + PADDING;
    const maxGroupSize = Math.max(...Array.from(groups.values()).map((g) => g.length));
    const totalH = PADDING + GROUP_HEADER_H + maxGroupSize * (NODE_H + NODE_GAP) + PADDING;

    // Store content bounds for fitToView
    contentBounds = { x: 0, y: 0, w: totalW, h: totalH };

    // SVG canvas
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style="background:transparent">`;

    // Viewport group for pan/zoom
    svg += `<g class="codebase-map-viewport" transform="translate(${viewport.tx} ${viewport.ty}) scale(${viewport.scale})">`;

    // Content bounds background
    svg += `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="rgba(255,255,255,0.015)" stroke="rgba(255,255,255,0.04)" stroke-width="1" rx="4" />`;

    // Render edges
    if (edgesVisible) {
      const visibleEdges = overview.edges.filter(
        (e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to),
      );
      for (const edge of visibleEdges.slice(0, overview.summary.displayed_edges)) {
        const fromPos = positions.get(edge.from);
        const toPos = positions.get(edge.to);
        if (!fromPos || !toPos) continue;
        const x1 = fromPos.x + NODE_W;
        const y1 = fromPos.y + NODE_H / 2;
        const x2 = toPos.x;
        const y2 = toPos.y + NODE_H / 2;
        const baseColor = EDGE_COLORS[edge.type] || EDGE_COLORS.related;

        // Dim edges not connected to focused node
        const isFocusedEdge = focusNodeIds && (focusNodeIds.has(edge.from) && focusNodeIds.has(edge.to));
        const color = focusNodeIds ? (isFocusedEdge ? baseColor : 'rgba(255,255,255,0.03)') : baseColor;
        const strokeWidth = focusNodeIds && isFocusedEdge ? 2 : 1.5;

        svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${strokeWidth}" />`;
      }
    }

    // Render group labels
    for (const [groupName, groupNodes] of groupEntries) {
      const firstPos = positions.get(groupNodes[0].id);
      if (firstPos) {
        svg += `<text x="${firstPos.x}" y="${firstPos.y - 8}" fill="var(--text-2, #90a4ae)" font-size="11" font-family="system-ui">${escapeHtml(groupName)}</text>`;
      }
    }

    // Render nodes
    for (const node of filteredNodes) {
      const pos = positions.get(node.id);
      if (!pos) continue;
      const color = KIND_COLORS[node.kind] || KIND_COLORS.unknown;
      const isSelected = node.id === focusNodeId;
      const isFocused = !focusNodeIds || focusNodeIds.has(node.id);

      // Determine stroke
      let strokeColor = 'rgba(255,255,255,0.1)';
      let strokeWidth = 1;
      if (isSelected) {
        strokeColor = 'var(--accent, #e8a050)';
        strokeWidth = 2.5;
      } else if (node.changed) {
        strokeColor = '#ff9800';
        strokeWidth = 2;
      } else if (node.entrypoint) {
        strokeColor = '#4fc3f7';
        strokeWidth = 2;
      }

      // Dimming
      const opacity = focusNodeIds ? (isFocused ? 1 : 0.15) : 1;
      const fillOpacity = focusNodeIds ? (isFocused ? 0.8 : 0.1) : 0.8;

      svg += `<rect x="${pos.x}" y="${pos.y}" width="${NODE_W}" height="${NODE_H}" rx="4" fill="rgba(30,30,30,${fillOpacity})" stroke="${strokeColor}" stroke-width="${strokeWidth}" data-node-id="${escapeHtml(node.id)}" opacity="${opacity}" />`;
      svg += `<circle cx="${pos.x + 12}" cy="${pos.y + NODE_H / 2}" r="4" fill="${color}" opacity="${opacity}" />`;
      svg += `<text x="${pos.x + 22}" y="${pos.y + NODE_H / 2 + 4}" fill="var(--text, #e0e0e0)" font-size="11" font-family="system-ui" opacity="${opacity}">${escapeHtml(node.label)}</text>`;
    }

    svg += '</g></svg>';
    return svg;
  }

  function applyViewportTransform() {
    const svgEl = mapSvg ? mapSvg.querySelector('svg') : null;
    const vpGroup = svgEl ? svgEl.querySelector('.codebase-map-viewport') : null;
    if (vpGroup) {
      vpGroup.setAttribute('transform', `translate(${viewport.tx} ${viewport.ty}) scale(${viewport.scale})`);
    }
  }

  function fitToView() {
    if (!mapSvg) return;
    const rect = mapSvg.getBoundingClientRect();
    const viewW = rect.width || mapSvg.clientWidth || 800;
    const viewH = rect.height || mapSvg.clientHeight || 600;
    const padding = 20;

    const { x: cx, y: cy, w: cw, h: ch } = contentBounds;
    if (cw <= 0 || ch <= 0) return;

    const scaleX = (viewW - 2 * padding) / cw;
    const scaleY = (viewH - 2 * padding) / ch;
    viewport.scale = Math.min(scaleX, scaleY);
    viewport.scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewport.scale));

    viewport.tx = padding + (viewW - 2 * padding - cw * viewport.scale) / 2 - cx * viewport.scale;
    viewport.ty = padding + (viewH - 2 * padding - ch * viewport.scale) / 2 - cy * viewport.scale;

    applyViewportTransform();
  }

  function resetViewport() {
    viewport.scale = 1;
    viewport.tx = 0;
    viewport.ty = 0;
    applyViewportTransform();
  }

  function handleWheel(e) {
    e.preventDefault();
    const rect = mapSvg.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
    const oldScale = viewport.scale;
    const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldScale * factor));
    const ratio = newScale / oldScale;

    viewport.tx = cursorX - (cursorX - viewport.tx) * ratio;
    viewport.ty = cursorY - (cursorY - viewport.ty) * ratio;
    viewport.scale = newScale;

    applyViewportTransform();
  }

  function handlePointerDown(e) {
    // Middle mouse button (1) always pans
    // Left mouse button (0) pans only on empty canvas (not on nodes)
    if (e.button === 1 || (e.button === 0 && !isNodeTarget(e.target))) {
      viewport.isPanning = true;
      viewport.panButton = e.button;
      viewport.lastPointerX = e.clientX;
      viewport.lastPointerY = e.clientY;
      if (mapSvg) mapSvg.classList.add('panning');
      e.preventDefault();
    }
  }

  function handlePointerMove(e) {
    if (!viewport.isPanning) return;
    const dx = e.clientX - viewport.lastPointerX;
    const dy = e.clientY - viewport.lastPointerY;
    viewport.tx += dx;
    viewport.ty += dy;
    viewport.lastPointerX = e.clientX;
    viewport.lastPointerY = e.clientY;
    applyViewportTransform();
  }

  function handlePointerUp(e) {
    if (viewport.isPanning && e.button === viewport.panButton) {
      viewport.isPanning = false;
      viewport.panButton = -1;
      if (mapSvg) mapSvg.classList.remove('panning');
    }
  }

  function isNodeTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'rect' || tag === 'text' || tag === 'circle';
  }

  function getNodeIdFromTarget(target) {
    if (!target) return null;
    // Walk up to find element with data-node-id
    let el = target;
    while (el && el !== mapSvg) {
      if (el.getAttribute && el.getAttribute('data-node-id')) {
        return el.getAttribute('data-node-id');
      }
      // For text/circle, check sibling rect
      if (el.parentElement) {
        const rect = el.parentElement.querySelector('[data-node-id]');
        if (rect) return rect.getAttribute('data-node-id');
      }
      el = el.parentElement;
    }
    return null;
  }

  let viewportEventsAttached = false;

  function attachViewportEvents() {
    if (viewportEventsAttached || !mapSvg) return;
    viewportEventsAttached = true;

    mapSvg.addEventListener('wheel', handleWheel, { passive: false });
    mapSvg.addEventListener('pointerdown', handlePointerDown);
    mapSvg.addEventListener('pointermove', handlePointerMove);
    mapSvg.addEventListener('pointerup', handlePointerUp);
    mapSvg.addEventListener('pointerleave', handlePointerUp);

    // Hover tooltip
    mapSvg.addEventListener('mousemove', handleSvgMouseMove);
    mapSvg.addEventListener('mouseleave', hideTooltip);

    // Click to select
    mapSvg.addEventListener('click', handleSvgClick);
  }

  function detachViewportEvents() {
    if (!viewportEventsAttached || !mapSvg) return;
    viewportEventsAttached = false;

    mapSvg.removeEventListener('wheel', handleWheel);
    mapSvg.removeEventListener('pointerdown', handlePointerDown);
    mapSvg.removeEventListener('pointermove', handlePointerMove);
    mapSvg.removeEventListener('pointerup', handlePointerUp);
    mapSvg.removeEventListener('pointerleave', handlePointerUp);
    mapSvg.removeEventListener('mousemove', handleSvgMouseMove);
    mapSvg.removeEventListener('mouseleave', hideTooltip);
    mapSvg.removeEventListener('click', handleSvgClick);
  }

  function handleSvgMouseMove(e) {
    if (viewport.isPanning) { hideTooltip(); return; }
    const nodeId = getNodeIdFromTarget(e.target);
    if (nodeId && lastOverview) {
      const node = lastOverview.nodes.find((n) => n.id === nodeId);
      if (node) {
        hoveredNodeId = nodeId;
        showTooltip(node, e.clientX, e.clientY);
        return;
      }
    }
    hoveredNodeId = null;
    hideTooltip();
  }

  function handleSvgClick(e) {
    if (viewport.isPanning) return;
    const nodeId = getNodeIdFromTarget(e.target);
    if (nodeId) {
      selectedNodeId = nodeId;
      renderDetailPanel(nodeId);
      updateSvg();
      // Center on the selected node
      centerOnNode(nodeId);
    } else {
      // Click on empty canvas: clear selection
      clearSelection();
    }
  }

  async function renderCodebaseMapPanel() {
    if (!window.vibecodeAPI || !window.vibecodeAPI.codebaseMap) {
      showEmpty('Codebase Map API is unavailable.');
      return;
    }

    if (mapRepo && window.vibecodeAPI.workspace) {
      try {
        const info = await window.vibecodeAPI.workspace.getInfo();
        if (info && info.repoPath) mapRepo.textContent = info.repoPath;
      } catch (_e) { /* best-effort */ }
    }

    showLoading();
    try {
      const overview = await window.vibecodeAPI.codebaseMap.getOverview();
      lastOverview = overview;

      if (mapMeta) {
        const s = overview.summary;
        const sourceLabel = overview.source.kind === 'latest_scan' ? 'scan' : overview.source.kind;
        mapMeta.textContent = `source=${sourceLabel} nodes=${s.displayed_nodes}/${s.total_nodes} edges=${s.displayed_edges}/${s.total_edges}`;
      }

      if (!overview.ok || overview.nodes.length === 0) {
        const msg = overview.warnings.length > 0 ? overview.warnings[0] : 'No codebase map data yet. Run a scan/prompt or open a workspace with scan artifacts.';
        showEmpty(msg);
        return;
      }

      if (mapEmpty) mapEmpty.style.display = 'none';
      if (mapSvg) mapSvg.style.display = '';

      // Reset viewport on new data
      selectedNodeId = null;
      if (detailPanel) detailPanel.style.display = 'none';
      resetViewport();
      updateSvg();
      renderLegend();
      renderFilterChips(overview);
      attachViewportEvents();

      // Auto-fit after first render (double-rAF ensures layout is computed)
      requestAnimationFrame(() => requestAnimationFrame(() => fitToView()));
    } catch (error) {
      showEmpty(error instanceof Error ? error.message : String(error));
    }
  }

  function updateSvg() {
    if (!mapSvg || !lastOverview) return;
    const svgHtml = renderCodebaseMapSvgHtml(lastOverview, activeFilter, searchQuery, showEdges, selectedNodeId);
    if (!svgHtml) {
      if (mapEmpty) {
        mapEmpty.style.display = '';
        mapEmpty.textContent = 'No nodes match the current filter.';
      }
      if (mapSvg) mapSvg.style.display = 'none';
      return;
    }
    if (mapEmpty) mapEmpty.style.display = 'none';
    if (mapSvg) mapSvg.style.display = '';
    mapSvg.innerHTML = svgHtml;
    applyViewportTransform();
  }

  function showEmpty(msg) {
    if (mapEmpty) {
      mapEmpty.style.display = '';
      mapEmpty.textContent = msg;
    }
    if (mapSvg) {
      mapSvg.style.display = 'none';
      mapSvg.innerHTML = '';
    }
    if (mapMeta) mapMeta.textContent = '';
  }

  function showLoading() {
    if (mapEmpty) {
      mapEmpty.style.display = '';
      mapEmpty.textContent = 'Loading codebase map…';
    }
    if (mapSvg) {
      mapSvg.style.display = 'none';
      mapSvg.innerHTML = '';
    }
  }

  function renderFilterChips(overview) {
    if (!mapFilterChips) return;
    const kinds = ['all', 'source', 'test', 'doc', 'config', 'generated'];
    const counts = { all: overview.nodes.length, entrypoints: 0, changed: 0 };
    for (const node of overview.nodes) {
      counts[node.kind] = (counts[node.kind] || 0) + 1;
      if (node.entrypoint) counts.entrypoints++;
      if (node.changed) counts.changed++;
    }
    let html = '';
    for (const kind of kinds) {
      const count = counts[kind] || 0;
      if (kind !== 'all' && count === 0) continue;
      const activeClass = activeFilter === kind ? ' active' : '';
      html += `<button class="cmap-chip${activeClass}" data-filter="${kind}" type="button">${kind} (${count})</button>`;
    }
    // Add entrypoints and changed filters
    if (counts.entrypoints > 0) {
      const activeClass = activeFilter === 'entrypoints' ? ' active' : '';
      html += `<button class="cmap-chip${activeClass}" data-filter="entrypoints" type="button">entrypoints (${counts.entrypoints})</button>`;
    }
    if (counts.changed > 0) {
      const activeClass = activeFilter === 'changed' ? ' active' : '';
      html += `<button class="cmap-chip${activeClass}" data-filter="changed" type="button">changed (${counts.changed})</button>`;
    }
    mapFilterChips.innerHTML = html;
  }

  // ============ Event handlers ============

  if (mapFilterChips) {
    mapFilterChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.cmap-chip');
      if (!chip) return;
      activeFilter = chip.getAttribute('data-filter') || 'all';
      mapFilterChips.querySelectorAll('.cmap-chip').forEach((c) => c.classList.toggle('active', c === chip));
      updateSvg();
    });
  }

  if (mapSearchInput) {
    mapSearchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value || '';
      updateSvg();

      // If search has a single match, select and center on it
      if (searchQuery && lastOverview) {
        const q = searchQuery.toLowerCase();
        const matches = lastOverview.nodes.filter(
          (n) => n.path.toLowerCase().includes(q) || n.label.toLowerCase().includes(q),
        );
        if (matches.length === 1) {
          selectedNodeId = matches[0].id;
          renderDetailPanel(selectedNodeId);
          centerOnNode(selectedNodeId);
        }
      }
    });

    // Enter key: select first match and center
    mapSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && searchQuery && lastOverview) {
        const q = searchQuery.toLowerCase();
        const matches = lastOverview.nodes.filter(
          (n) => n.path.toLowerCase().includes(q) || n.label.toLowerCase().includes(q),
        );
        if (matches.length > 0) {
          selectedNodeId = matches[0].id;
          renderDetailPanel(selectedNodeId);
          updateSvg();
          centerOnNode(selectedNodeId);
        }
      }
    });
  }

  if (mapEdgesToggle) {
    mapEdgesToggle.addEventListener('change', (e) => {
      showEdges = e.target.checked;
      updateSvg();
    });
  }

  if (mapRefreshBtn) {
    mapRefreshBtn.addEventListener('click', () => void renderCodebaseMapPanel());
  }

  if (mapFitBtn) {
    mapFitBtn.addEventListener('click', () => fitToView());
  }

  if (mapResetBtn) {
    mapResetBtn.addEventListener('click', () => {
      resetViewport();
      fitToView();
    });
  }

  if (mapCloseBtn) {
    mapCloseBtn.addEventListener('click', () => {
      closeCodebaseMapPanel();
      const sidebar = $('left-sidebar');
      if (sidebar) {
        sidebar.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
        const terminalsNav = sidebar.querySelector('[data-nav="terminals"]');
        if (terminalsNav) terminalsNav.classList.add('active');
      }
    });
  }

  if (detailCloseBtn) {
    detailCloseBtn.addEventListener('click', () => clearSelection());
  }

  // Escape key clears selection
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectedNodeId && panel && panel.classList.contains('open')) {
      clearSelection();
    }
  });

  function openCodebaseMapPanel() {
    if (!panel) return;
    panel.style.display = 'flex';
    panel.classList.add('open');
    const workspace = $('workspace');
    if (workspace) workspace.style.display = 'none';
    void renderCodebaseMapPanel();
  }

  function closeCodebaseMapPanel() {
    if (!panel) return;
    panel.style.display = 'none';
    panel.classList.remove('open');
    const workspace = $('workspace');
    if (workspace) workspace.style.display = '';
    detachViewportEvents();
  }

  window.CodebaseMapPanel = {
    open: openCodebaseMapPanel,
    close: closeCodebaseMapPanel,
    refresh: renderCodebaseMapPanel,
  };
})();
