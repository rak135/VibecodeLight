/*
 * Agent guidance settings presenter + controller (renderer-side, plain browser JS).
 *
 * Same pattern as flash_settings.js: this module owns NO file IO. It calls the
 * narrow preload bridge methods exposed under window.vibecodeAPI.config:
 *
 *   getAgentGuidanceConfig() / setAgentGuidanceConfig(config)
 *   resetAgentGuidanceConfig() / getAgentGuidanceDefaults()
 *   getAgentGuidanceConfigPath() / getAgentGuidanceMcpTools()
 *
 * It never reads files, never parses YAML, and never touches PTY input. The
 * effective preview built here is a *display* artifact only — this slice does
 * NOT install guidance into Claude/Codex/OpenCode/Hermes configs.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VibecodeAgentGuidanceSettings = api;
  }
})(
  typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this,
  function () {
    'use strict';

    var APPROVAL_BOUNDARY_LINE =
      'Vibecode does not manage agent approvals; approval/permission belongs to the MCP client/agent.';
    var FALLBACK_LINE = 'If MCP tools are unavailable, use equivalent Vibecode CLI commands.';
    var TERMINAL_PREFLIGHT_COPY =
      'Applies when opening new Vibecode terminals. It does not start agents and does not send text into the terminal. Start codex/claude manually as usual.';
    var DEFAULT_TERMINAL_PREFLIGHT = Object.freeze({
      enabled: true,
      mode: 'check_only',
      supported_agents: Object.freeze({ codex: true, claude: true }),
      repair: Object.freeze({ create_backup: true, require_valid_guidance_config: true }),
    });

    function normalizeTerminalPreflight(raw) {
      raw = raw && typeof raw === 'object' ? raw : {};
      var supported = raw.supported_agents && typeof raw.supported_agents === 'object' ? raw.supported_agents : {};
      var repair = raw.repair && typeof raw.repair === 'object' ? raw.repair : {};
      return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_TERMINAL_PREFLIGHT.enabled,
        mode: raw.mode === 'auto_repair' || raw.mode === 'check_only' ? raw.mode : DEFAULT_TERMINAL_PREFLIGHT.mode,
        supported_agents: {
          codex: typeof supported.codex === 'boolean' ? supported.codex : DEFAULT_TERMINAL_PREFLIGHT.supported_agents.codex,
          claude: typeof supported.claude === 'boolean' ? supported.claude : DEFAULT_TERMINAL_PREFLIGHT.supported_agents.claude,
        },
        repair: {
          create_backup: typeof repair.create_backup === 'boolean' ? repair.create_backup : DEFAULT_TERMINAL_PREFLIGHT.repair.create_backup,
          require_valid_guidance_config:
            typeof repair.require_valid_guidance_config === 'boolean'
              ? repair.require_valid_guidance_config
              : DEFAULT_TERMINAL_PREFLIGHT.repair.require_valid_guidance_config,
        },
      };
    }

    function agentStatusText(agent) {
      if (!agent) return 'unknown';
      if (agent.error) return 'error';
      if (agent.repaired) return 'repaired';
      if (agent.stale) return 'stale';
      if (agent.configured) return 'up-to-date';
      return 'missing';
    }

    function buildTerminalPreflightView(opts) {
      var config = normalizeTerminalPreflight(opts && opts.terminal_preflight);
      var last = opts && opts.last_result ? opts.last_result : {};
      var agents = Array.isArray(last.agents) ? last.agents : [];
      function findAgent(name) {
        for (var i = 0; i < agents.length; i += 1) {
          if (agents[i].agent === name) return agents[i];
        }
        return null;
      }
      return {
        title: 'Terminal Agent Preflight',
        copy: TERMINAL_PREFLIGHT_COPY,
        enabled: config.enabled,
        mode: config.mode,
        modeOptions: [
          { value: 'check_only', label: 'Check only' },
          { value: 'auto_repair', label: 'Auto repair safe MCP config' },
        ],
        agentToggles: [
          { agent: 'codex', enabled: config.supported_agents.codex !== false },
          { agent: 'claude', enabled: config.supported_agents.claude !== false },
        ],
        createBackup: config.repair.create_backup !== false,
        statusRows: [
          { label: 'last checked at', value: last.checked_at || 'not checked' },
          { label: 'guidance hash', value: last.guidance_hash || '' },
          { label: 'Codex', value: agentStatusText(findAgent('codex')) },
          { label: 'Claude', value: agentStatusText(findAgent('claude')) },
        ],
      };
    }

    function buildEffectivePreviewText(opts) {
      var config = opts && opts.config ? opts.config : null;
      var mcpTools = opts && Array.isArray(opts.mcpTools) ? opts.mcpTools : [];
      if (!config || config.enabled === false) {
        return 'Agent guidance is disabled. No guidance will be presented to terminal agents from this layer.';
      }
      var knownToolNames = {};
      for (var t = 0; t < mcpTools.length; t += 1) {
        knownToolNames[mcpTools[t].name] = mcpTools[t];
      }
      var lines = [];
      lines.push('# Effective agent guidance (preview)');
      lines.push('');
      lines.push('Status: enabled');
      lines.push('Scope: ' + (config.scope || 'global'));
      lines.push('Apply to terminal agents: ' + (config.apply_to_terminal_agents === false ? 'no' : 'yes'));
      lines.push('');
      lines.push('## Default guidance');
      lines.push('');
      var guidance = typeof config.default_guidance === 'string' ? config.default_guidance.trim() : '';
      lines.push(guidance);
      lines.push('');
      var perTool = config.per_tool_notes && typeof config.per_tool_notes === 'object' ? config.per_tool_notes : {};
      var noteEntries = [];
      for (var name in perTool) {
        if (!Object.prototype.hasOwnProperty.call(perTool, name)) continue;
        if (!knownToolNames[name]) continue;
        var note = perTool[name];
        if (typeof note !== 'string' || note.trim() === '') continue;
        noteEntries.push({ name: name, note: note, group: knownToolNames[name].group });
      }
      if (noteEntries.length > 0) {
        lines.push('## Per-tool notes');
        lines.push('');
        for (var i = 0; i < noteEntries.length; i += 1) {
          lines.push('- ' + noteEntries[i].name + ' (' + noteEntries[i].group + '): ' + noteEntries[i].note);
        }
        lines.push('');
      }
      lines.push('## Fallback');
      lines.push('');
      lines.push(FALLBACK_LINE);
      lines.push('');
      lines.push('## Approval boundary');
      lines.push('');
      lines.push(APPROVAL_BOUNDARY_LINE);
      lines.push('');
      lines.push('---');
      lines.push('This guidance is stored locally and previewed only. It has NOT been installed into any agent configuration.');
      return lines.join('\n');
    }

    function buildStatusMessage(opts) {
      if (!opts) return { text: '', kind: 'info' };
      if (opts.ok === false && opts.error) {
        var code = opts.error.code ? String(opts.error.code) : 'AGENT_GUIDANCE_CONFIG_ERROR';
        var message = opts.error.message ? String(opts.error.message) : 'invalid config';
        return {
          kind: 'error',
          text: code + ' — ' + message + ' (see ' + (opts.configPath || '') + ')',
        };
      }
      if (opts.source === 'file') {
        return { kind: 'info', text: 'loaded from file: ' + (opts.configPath || '') };
      }
      return { kind: 'info', text: 'loaded from defaults (no file at ' + (opts.configPath || '') + ')' };
    }

    function safeError(errLike) {
      var code = 'UNKNOWN';
      var message = 'unknown error';
      if (typeof errLike === 'string') {
        message = errLike;
      } else if (errLike) {
        if (errLike.code) code = String(errLike.code);
        if (errLike.message) message = String(errLike.message);
      }
      return code + ' — ' + message;
    }

    function defaultsFromTools() { return []; }

    function createController(opts) {
      var api = opts && opts.api ? opts.api : null;
      var view = opts && opts.view ? opts.view : {
        setConfig: function () {},
        setPath: function () {},
        setStatus: function () {},
        setMcpTools: function () {},
        setEffectiveGuidance: function () {},
        setTerminalPreflight: function () {},
        setIntegrationStatus: function () {},
        setIntegrationPlan: function () {},
      };
      var lastConfig = null;
      var lastTools = defaultsFromTools();
      var lastTerminalPreflight = normalizeTerminalPreflight(null);

      function renderEffective() {
        if (!lastConfig) return;
        var preview = buildEffectivePreviewText({ config: lastConfig, mcpTools: lastTools });
        view.setEffectiveGuidance({ enabled: lastConfig.enabled !== false, text: preview });
      }

      function renderIntegrationStatus(agent, resp) {
        if (!view.setIntegrationStatus) return;
        if (!resp || resp.ok !== true) {
          view.setIntegrationStatus(agent, {
            kind: 'error',
            text: safeError(resp && resp.error ? resp.error : { code: 'AGENT_GUIDANCE_STATUS_FAILED', message: 'status failed' }),
          });
          return;
        }
        var guidance = resp.guidance || {};
        var mcp = resp.mcp || {};
        var state = resp.up_to_date ? 'up to date' : resp.configured ? 'configured, update available' : 'not configured';
        var hash = guidance.guidance_hash || '';
        var tools = mcp.expected_tool_count || 0;
        view.setIntegrationStatus(agent, {
          kind: resp.up_to_date ? 'ok' : 'info',
          text:
            state +
            '. Guidance ' +
            (guidance.enabled === false ? 'disabled' : 'enabled') +
            ', source=' +
            (guidance.source || 'unknown') +
            '. Changes apply to new agent/MCP sessions. Restart/reconnect the agent if already running.',
          hash: hash,
          expectedToolCount: tools,
        });
      }

      async function refreshIntegrations() {
        if (!api || typeof api.getAgentGuidanceIntegrationStatus !== 'function') return;
        var agents = ['claude', 'codex'];
        for (var i = 0; i < agents.length; i += 1) {
          try {
            var resp = await api.getAgentGuidanceIntegrationStatus(agents[i]);
            renderIntegrationStatus(agents[i], resp);
          } catch (err) {
            if (view.setIntegrationStatus) {
              view.setIntegrationStatus(agents[i], { kind: 'error', text: safeError(err) });
            }
          }
        }
      }

      async function refreshTerminalPreflight() {
        if (!api || typeof api.getAgentGuidanceTerminalPreflightConfig !== 'function') {
          if (view.setTerminalPreflight) {
            view.setTerminalPreflight(buildTerminalPreflightView({ terminal_preflight: lastTerminalPreflight }));
          }
          return;
        }
        try {
          var resp = await api.getAgentGuidanceTerminalPreflightConfig();
          if (resp && resp.terminal_preflight) {
            lastTerminalPreflight = normalizeTerminalPreflight(resp.terminal_preflight);
          }
          if (view.setTerminalPreflight) {
            view.setTerminalPreflight(buildTerminalPreflightView({
              terminal_preflight: lastTerminalPreflight,
              last_result: resp && resp.last_result,
            }));
          }
        } catch (_err) {
          if (view.setTerminalPreflight) {
            view.setTerminalPreflight(buildTerminalPreflightView({ terminal_preflight: lastTerminalPreflight }));
          }
        }
      }

      async function refresh() {
        if (!api) return;
        try {
          var configResp = await api.getAgentGuidanceConfig();
          if (configResp && configResp.config) {
            lastConfig = configResp.config;
            view.setConfig(configResp.config);
          }
          var pathResp = null;
          if (typeof api.getAgentGuidanceConfigPath === 'function') {
            pathResp = await api.getAgentGuidanceConfigPath();
            if (pathResp && pathResp.ok) view.setPath(pathResp);
          }
          if (typeof api.getAgentGuidanceMcpTools === 'function') {
            var toolsResp = await api.getAgentGuidanceMcpTools();
            if (toolsResp && Array.isArray(toolsResp.tools)) {
              lastTools = toolsResp.tools;
              view.setMcpTools(toolsResp.tools);
            }
          }
          if (typeof api.getAgentGuidanceRuntimeStatus === 'function') {
            await api.getAgentGuidanceRuntimeStatus();
          }
          await refreshTerminalPreflight();
          view.setStatus(buildStatusMessage({
            ok: configResp && configResp.ok !== false,
            source: configResp && configResp.source,
            exists: configResp && configResp.exists,
            configPath: configResp && configResp.configPath,
            error: configResp && configResp.error,
          }));
          renderEffective();
          await refreshIntegrations();
        } catch (err) {
          view.setStatus({ kind: 'error', text: safeError(err) });
        }
      }

      async function save(nextConfig) {
        if (!api || typeof api.setAgentGuidanceConfig !== 'function') return;
        try {
          var resp = await api.setAgentGuidanceConfig(nextConfig);
          if (!resp || resp.ok !== true) {
            view.setStatus({
              kind: 'error',
              text: safeError(resp && resp.error ? resp.error : { code: 'AGENT_GUIDANCE_WRITE_FAILED', message: 'could not save' }),
            });
            return;
          }
          lastConfig = resp.config;
          if (nextConfig && nextConfig.terminal_preflight && typeof api.setAgentGuidanceTerminalPreflightConfig === 'function') {
            var preflightResp = await api.setAgentGuidanceTerminalPreflightConfig(normalizeTerminalPreflight(nextConfig.terminal_preflight));
            if (preflightResp && preflightResp.ok === true && preflightResp.terminal_preflight) {
              lastTerminalPreflight = normalizeTerminalPreflight(preflightResp.terminal_preflight);
              if (view.setTerminalPreflight) {
                view.setTerminalPreflight(buildTerminalPreflightView({ terminal_preflight: lastTerminalPreflight }));
              }
            } else if (preflightResp && preflightResp.ok === false) {
              view.setStatus({
                kind: 'error',
                text: safeError(preflightResp.error || { code: 'TERMINAL_PREFLIGHT_WRITE_FAILED', message: 'could not save terminal preflight settings' }),
              });
              return;
            }
          }
          view.setConfig(resp.config);
          view.setStatus({ kind: 'ok', text: 'saved' });
          renderEffective();
        } catch (err) {
          view.setStatus({ kind: 'error', text: safeError(err) });
        }
      }

      async function reset() {
        if (!api || typeof api.resetAgentGuidanceConfig !== 'function') return;
        try {
          var resp = await api.resetAgentGuidanceConfig();
          if (!resp || resp.ok !== true) {
            view.setStatus({
              kind: 'error',
              text: safeError(resp && resp.error ? resp.error : { code: 'AGENT_GUIDANCE_RESET_FAILED', message: 'could not reset' }),
            });
            return;
          }
          lastConfig = resp.config;
          view.setConfig(resp.config);
          view.setStatus({ kind: 'ok', text: 'reset to defaults' });
          renderEffective();
        } catch (err) {
          view.setStatus({ kind: 'error', text: safeError(err) });
        }
      }

      async function dryRunApply(agent) {
        if (!api || typeof api.dryRunAgentGuidanceIntegration !== 'function') return;
        try {
          var resp = await api.dryRunAgentGuidanceIntegration(agent);
          if (view.setIntegrationPlan) {
            if (resp && resp.ok) {
              view.setIntegrationPlan(agent, {
                kind: 'info',
                text: 'dry-run: ' + (resp.planned_action || 'planned MCP update'),
                hash: resp.guidance_hash || '',
              });
            } else {
              view.setIntegrationPlan(agent, {
                kind: 'error',
                text: safeError(resp && resp.error ? resp.error : { code: 'AGENT_GUIDANCE_DRY_RUN_FAILED', message: 'dry-run failed' }),
              });
            }
          }
        } catch (err) {
          if (view.setIntegrationPlan) view.setIntegrationPlan(agent, { kind: 'error', text: safeError(err) });
        }
      }

      async function apply(agent, confirmed) {
        if (confirmed !== true) {
          if (view.setIntegrationStatus) {
            view.setIntegrationStatus(agent, {
              kind: 'error',
              text: 'confirmation required before applying Agent Guidance integration',
            });
          }
          return;
        }
        if (!api || typeof api.applyAgentGuidanceIntegration !== 'function') return;
        try {
          var resp = await api.applyAgentGuidanceIntegration(agent, true);
          if (!resp || resp.ok !== true) {
            if (view.setIntegrationStatus) {
              view.setIntegrationStatus(agent, {
                kind: 'error',
                text: safeError(resp && resp.error ? resp.error : { code: 'AGENT_GUIDANCE_APPLY_FAILED', message: 'apply failed' }),
              });
            }
            return;
          }
          if (view.setIntegrationStatus) {
            view.setIntegrationStatus(agent, {
              kind: 'ok',
              text: 'applied. Changes apply to new agent/MCP sessions. Restart/reconnect the agent if already running.',
              hash: resp.guidance_hash || '',
            });
          }
          await refreshIntegrations();
        } catch (err) {
          if (view.setIntegrationStatus) view.setIntegrationStatus(agent, { kind: 'error', text: safeError(err) });
        }
      }

      return {
        refresh: refresh,
        save: save,
        reset: reset,
        dryRunApply: dryRunApply,
        apply: apply,
      };
    }

      return {
        TERMINAL_PREFLIGHT_COPY: TERMINAL_PREFLIGHT_COPY,
        buildEffectivePreviewText: buildEffectivePreviewText,
        buildTerminalPreflightView: buildTerminalPreflightView,
        buildStatusMessage: buildStatusMessage,
        createController: createController,
      };
  },
);
