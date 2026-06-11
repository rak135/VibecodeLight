/**
 * Codebase Map panel module: renders a read-only 2D SVG map of the codebase
 * with CAD-like viewport controls (zoom toward cursor, pan, fit, reset).
 * Pure render function + DOM integration, following the VibecodeMcpPanel pattern.
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

  let lastOverview = null;
  let activeFilter = 'all';
  let searchQuery = '';
  let showEdges = true;

  // CAD viewport state
  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 20;
  const ZOOM_FACTOR = 1.15;

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

  const EDGE_COLORS = {
    import: 'rgba(79,195,247,0.35)',
    test: 'rgba(129,199,132,0.35)',
    entrypoint: 'rgba(255,183,77,0.35)',
    folder: 'rgba(144,164,174,0.2)',
    related: 'rgba(186,104,200,0.3)',
  };

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

  function filterNodes(nodes, filter, query) {
    let filtered = nodes;
    if (filter !== 'all') {
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
   * Includes a viewport group for CAD-like pan/zoom transforms.
   */
  function renderCodebaseMapSvgHtml(overview, filter, query, edgesVisible) {
    if (!overview || !overview.ok || overview.nodes.length === 0) {
      return '';
    }

    const filteredNodes = filterNodes(overview.nodes, filter, query);
    if (filteredNodes.length === 0) {
      return '';
    }

    const nodeIndex = buildNodeIndex(overview.nodes);
    const nodeIdSet = new Set(filteredNodes.map((n) => n.id));

    // Layout: group nodes by group, arrange in columns
    const groups = new Map();
    for (const node of filteredNodes) {
      const existing = groups.get(node.group) ?? [];
      existing.push(node);
      groups.set(node.group, existing);
    }

    const PADDING = 16;
    const NODE_W = 140;
    const NODE_H = 32;
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

    const totalW = x - GROUP_GAP + PADDING;
    const maxGroupSize = Math.max(...Array.from(groups.values()).map((g) => g.length));
    const totalH = PADDING + GROUP_HEADER_H + maxGroupSize * (NODE_H + NODE_GAP) + PADDING;

    // Store content bounds for fitToView
    contentBounds = { x: 0, y: 0, w: totalW, h: totalH };

    // SVG canvas is sized to the container; the viewport group handles transforms
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style="background:transparent">`;

    // Viewport group for pan/zoom
    svg += `<g class="codebase-map-viewport" transform="translate(${viewport.tx} ${viewport.ty}) scale(${viewport.scale})">`;

    // Content bounds background (subtle visual feedback for canvas extent)
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
        const color = EDGE_COLORS[edge.type] || EDGE_COLORS.related;
        svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" />`;
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
      const strokeColor = node.changed ? '#ff9800' : node.entrypoint ? '#4fc3f7' : 'rgba(255,255,255,0.1)';
      const strokeWidth = node.changed || node.entrypoint ? 2 : 1;

      svg += `<rect x="${pos.x}" y="${pos.y}" width="${NODE_W}" height="${NODE_H}" rx="4" fill="rgba(30,30,30,0.8)" stroke="${strokeColor}" stroke-width="${strokeWidth}" data-node-id="${escapeHtml(node.id)}" />`;
      svg += `<circle cx="${pos.x + 12}" cy="${pos.y + NODE_H / 2}" r="4" fill="${color}" />`;
      svg += `<text x="${pos.x + 22}" y="${pos.y + NODE_H / 2 + 4}" fill="var(--text, #e0e0e0)" font-size="11" font-family="system-ui">${escapeHtml(node.label)}</text>`;
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

  let viewportEventsAttached = false;

  function attachViewportEvents() {
    if (viewportEventsAttached || !mapSvg) return;
    viewportEventsAttached = true;

    mapSvg.addEventListener('wheel', handleWheel, { passive: false });
    mapSvg.addEventListener('pointerdown', handlePointerDown);
    mapSvg.addEventListener('pointermove', handlePointerMove);
    mapSvg.addEventListener('pointerup', handlePointerUp);
    mapSvg.addEventListener('pointerleave', handlePointerUp);
  }

  function detachViewportEvents() {
    if (!viewportEventsAttached || !mapSvg) return;
    viewportEventsAttached = false;

    mapSvg.removeEventListener('wheel', handleWheel);
    mapSvg.removeEventListener('pointerdown', handlePointerDown);
    mapSvg.removeEventListener('pointermove', handlePointerMove);
    mapSvg.removeEventListener('pointerup', handlePointerUp);
    mapSvg.removeEventListener('pointerleave', handlePointerUp);
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
      resetViewport();
      updateSvg();
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
    const svgHtml = renderCodebaseMapSvgHtml(lastOverview, activeFilter, searchQuery, showEdges);
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
    const counts = { all: overview.nodes.length };
    for (const node of overview.nodes) {
      counts[node.kind] = (counts[node.kind] || 0) + 1;
    }
    let html = '';
    for (const kind of kinds) {
      const count = counts[kind] || 0;
      if (kind !== 'all' && count === 0) continue;
      const activeClass = activeFilter === kind ? ' active' : '';
      html += `<button class="cmap-chip${activeClass}" data-filter="${kind}" type="button">${kind} (${count})</button>`;
    }
    mapFilterChips.innerHTML = html;
  }

  // Event handlers
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

  window.CodebaseMapPanel = {
    open: openCodebaseMapPanel,
    close: closeCodebaseMapPanel,
    refresh: renderCodebaseMapPanel,
  };
})();
