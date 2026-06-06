/*
 * Tabbed settings shell (renderer-side, plain browser JS).
 *
 * This module owns NO config logic. It defines the canonical set of tabs that
 * appear in the Settings overlay and a tiny controller that delegates tab
 * rendering to an injected view. Each tab's actual content is owned by its
 * own controller module (flash_settings.js, agent_guidance_settings.js, …).
 *
 * Tabs declared here (Flash, CodeGraph, MCP, Agent Guidance, Terminal,
 * Advanced) are stable identifiers used by tests and the renderer DOM. The
 * Terminal tab description is intentionally explicit about the fact that
 * Vibecode does NOT inject hidden text into the PTY.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VibecodeSettingsShell = api;
  }
})(
  typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this,
  function () {
    'use strict';

    var SETTINGS_TABS = Object.freeze([
      Object.freeze({
        id: 'flash',
        label: 'Flash',
        description: 'Flash provider/model configuration and active config source.',
      }),
      Object.freeze({
        id: 'codegraph',
        label: 'CodeGraph',
        description:
          'CodeGraph transport (cli / mcp / auto) and remembered Desktop CodeGraph mode (detect-only / use-existing).',
      }),
      Object.freeze({
        id: 'mcp',
        label: 'MCP',
        description: 'VibecodeMCP tool inventory (read-only).',
      }),
      Object.freeze({
        id: 'agent-guidance',
        label: 'Agent Guidance',
        description:
          'Local Agent Guidance defaults and per-tool notes. Inspectable, editable, resettable, and exposed to Claude/Codex through VibecodeMCP.',
      }),
      Object.freeze({
        id: 'terminal',
        label: 'Terminal',
        description:
          'Terminal Agent Preflight checks supported agent MCP config when opening terminals, does not start agents, and does not send hidden text into the PTY.',
      }),
      Object.freeze({
        id: 'advanced',
        label: 'Advanced',
        description: 'Diagnostics and config-path information.',
      }),
    ]);

    function findTab(id) {
      for (var i = 0; i < SETTINGS_TABS.length; i += 1) {
        if (SETTINGS_TABS[i].id === id) return SETTINGS_TABS[i];
      }
      return null;
    }

    function initialTabState() {
      return { tabs: SETTINGS_TABS, activeTabId: SETTINGS_TABS[0].id };
    }

    function selectTab(state, nextId) {
      var found = findTab(nextId);
      if (!found) return state;
      return { tabs: SETTINGS_TABS, activeTabId: found.id };
    }

    function createController(opts) {
      var view = opts && opts.view ? opts.view : { renderTabs: function () {} };
      var state = initialTabState();
      function render() {
        if (typeof view.renderTabs === 'function') view.renderTabs(state);
      }
      function activate(id) {
        state = selectTab(state, id);
        render();
      }
      // Initial render so the view always starts in a defined state.
      render();
      return {
        activate: activate,
        getState: function () { return state; },
      };
    }

    return {
      SETTINGS_TABS: SETTINGS_TABS,
      initialTabState: initialTabState,
      selectTab: selectTab,
      createController: createController,
    };
  },
);
