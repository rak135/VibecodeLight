/*
 * Flash settings presenter + controller (renderer-side, plain browser JS).
 *
 * This module owns NO config logic. It is a thin view/controller layer over the
 * preload `config` bridge, which is itself backed by the shared core config
 * service. It never reads files, never parses YAML or .env, and never receives
 * or renders an API key value — only the safe, secret-free data returned by the
 * core config service (provider/model ids and labels, config source, paths, the
 * api_key_env NAME, and a boolean has_api_key).
 *
 * It is loadable directly in the browser via a <script src> tag (CSP 'self') and
 * is also importable in Node tests (CommonJS export) so the view-model mapping
 * and controller orchestration can be unit tested without a DOM.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VibecodeFlashSettings = api;
  }
})(
  typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this,
  function () {
    'use strict';

    function display(value) {
      return value === null || value === undefined || value === '' ? '(none)' : String(value);
    }

    function nullableString(value) {
      return value === null || value === undefined ? null : String(value);
    }

    // Defense in depth: even though core never emits API keys, never echo a
    // key-shaped token if one somehow reaches a diagnostic string.
    function redactSecrets(text) {
      if (typeof text !== 'string') return '';
      return text
        .replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
        .replace(/\b[A-Za-z0-9]{32,}\b/g, '[redacted]');
    }

    function isConfigured(resolution) {
      var provider = resolution && resolution.provider;
      var model = resolution && resolution.model;
      return Boolean(provider) && provider !== 'mock' && Boolean(model);
    }

    function normalizeMode(mode) {
      return mode === 'live' ? 'live' : 'mock';
    }

    function normalizeCodeGraphMode(mode) {
      return mode === 'use-existing' ? 'use-existing' : 'detect-only';
    }

    var TASK_NORMALIZER_STORAGE_KEY = 'vibelight.taskNormalizerEnabled';

    function readTaskNormalizerEnabled(storage) {
      if (!storage || typeof storage.getItem !== 'function') return false;
      return storage.getItem(TASK_NORMALIZER_STORAGE_KEY) === '1';
    }

    function writeTaskNormalizerEnabled(storage, enabled) {
      if (!storage || typeof storage.setItem !== 'function') return;
      storage.setItem(TASK_NORMALIZER_STORAGE_KEY, enabled ? '1' : '0');
    }

    // CodeGraph pipeline transport selection (Phase 1B). The transport is
    // independent of the CodeGraph ON/OFF toggle: detect-only ignores it.
    var CODEGRAPH_TRANSPORT_STORAGE_KEY = 'vibecode.codegraphTransport';
    var DEFAULT_CODEGRAPH_TRANSPORT = 'cli';
    var CODEGRAPH_TRANSPORTS = ['cli', 'mcp', 'auto'];

    function normalizeCodeGraphTransport(value) {
      if (typeof value !== 'string') return DEFAULT_CODEGRAPH_TRANSPORT;
      var trimmed = value.trim().toLowerCase();
      return CODEGRAPH_TRANSPORTS.indexOf(trimmed) >= 0 ? trimmed : DEFAULT_CODEGRAPH_TRANSPORT;
    }

    function readCodeGraphTransport(storage) {
      if (!storage || typeof storage.getItem !== 'function') return DEFAULT_CODEGRAPH_TRANSPORT;
      return normalizeCodeGraphTransport(storage.getItem(CODEGRAPH_TRANSPORT_STORAGE_KEY));
    }

    function writeCodeGraphTransport(storage, transport) {
      if (!storage || typeof storage.setItem !== 'function') return DEFAULT_CODEGRAPH_TRANSPORT;
      var normalized = normalizeCodeGraphTransport(transport);
      storage.setItem(CODEGRAPH_TRANSPORT_STORAGE_KEY, normalized);
      return normalized;
    }

    // The header pill reflects the flash mode the next preview will use. It
    // defaults to Mock so the GUI never implies a surprise live API call; only
    // when the user explicitly selects Live does it surface the resolved
    // provider/model (sourced from the core config service via preload).
    function buildPill(resolution, mode) {
      var m = normalizeMode(mode);
      if (m === 'mock') {
        return { available: true, mode: 'mock', text: 'Flash: Mock', sourceText: '' };
      }
      if (!isConfigured(resolution)) {
        return { available: false, mode: 'live', text: 'Flash: not configured', sourceText: '' };
      }
      var label =
        (resolution.provider_label && String(resolution.provider_label)) || String(resolution.provider);
      return {
        available: true,
        mode: 'live',
        text: 'Flash: Live · ' + label + ' · ' + String(resolution.model),
        sourceText: 'Source: ' + (resolution.selected_config_source || 'unknown'),
      };
    }

    function buildSettings(resolution) {
      var r = resolution || {};
      return [
        { label: 'Provider label', value: display(r.provider_label) },
        { label: 'Provider id', value: display(r.provider) },
        { label: 'Model label', value: display(r.model_label) },
        { label: 'Model id', value: display(r.model) },
        { label: 'Config source', value: display(r.selected_config_source) },
        { label: 'Local config', value: display(r.local_config_path) },
        { label: 'Global config', value: display(r.global_config_path) },
        { label: 'Global env', value: display(r.global_env_path) },
        { label: 'API key env', value: display(r.api_key_env) },
        { label: 'API key configured', value: r.has_api_key ? 'yes' : 'no' },
      ];
    }

    function mapModels(models) {
      if (!Array.isArray(models)) return [];
      return models.map(function (m) {
        return { id: m.id, label: nullableString(m.label), role: nullableString(m.role) };
      });
    }

    function buildProviderList(providers) {
      if (!Array.isArray(providers)) return [];
      return providers.map(function (p) {
        return {
          id: p.id,
          label: nullableString(p.label),
          hasApiKey: Boolean(p.has_api_key),
          apiKeyEnv: nullableString(p.api_key_env),
          models: mapModels(p.models),
        };
      });
    }

    function modelsForProvider(providers, providerId) {
      if (!Array.isArray(providers)) return [];
      var found = null;
      for (var i = 0; i < providers.length; i += 1) {
        if (providers[i] && providers[i].id === providerId) {
          found = providers[i];
          break;
        }
      }
      return found ? mapModels(found.models) : [];
    }

    function buildComposerSelection(resolution) {
      var r = resolution || {};
      var providers = Array.isArray(r.providers)
        ? r.providers.map(function (p) {
            return { id: p.id, label: nullableString(p.label) };
          })
        : [];
      return {
        providers: providers,
        defaultProvider: r.provider || null,
        defaultModel: r.model || null,
        defaultMode: 'live',
      };
    }

    // Pure view-state for the composer flash mode toggle. Live-only controls
    // (provider/model dropdowns + key status) are hidden unless Live is chosen.
    function composerModeState(mode) {
      var m = normalizeMode(mode);
      return { mode: m, showLiveControls: m === 'live' };
    }

    function findProvider(providerList, providerId) {
      if (!Array.isArray(providerList)) return null;
      for (var i = 0; i < providerList.length; i += 1) {
        if (providerList[i] && providerList[i].id === providerId) return providerList[i];
      }
      return null;
    }

    // Safe, secret-free API-key status for the selected provider. Only ever
    // reports the boolean has_api_key and the api_key_env NAME — never a value.
    function composerKeyStatus(providerList, providerId) {
      var provider = findProvider(providerList, providerId);
      if (!provider) {
        return { hasApiKey: false, apiKeyEnv: null, text: 'API key: unknown provider' };
      }
      var env = nullableString(provider.apiKeyEnv);
      if (provider.hasApiKey) {
        return { hasApiKey: true, apiKeyEnv: env, text: 'API key: yes' };
      }
      return {
        hasApiKey: false,
        apiKeyEnv: env,
        text: 'API key: no (set ' + (env || 'the provider API key env') + ')',
      };
    }

    // Routes a composer preview request to the correct preload call based on the
    // visible Mock/Live selector. Live mode is gated on the safe has_api_key flag
    // so a missing key produces a clear FLASH_PROVIDER_AUTH_MISSING diagnostic.
    // It must NEVER fall back from Live to the mock path.
    async function runComposerPreview(opts) {
      var composer = opts.composer;
      var mode = normalizeMode(opts.mode);
      var codegraphMode = normalizeCodeGraphMode(opts.codegraphMode);
      var codegraphTransport = normalizeCodeGraphTransport(opts.codegraphTransport);
      var taskNormalizerEnabled = opts.taskNormalizerEnabled === true;
      if (mode === 'mock') {
        var mockResult = await composer.generatePreview(opts.task, codegraphMode, taskNormalizerEnabled, codegraphTransport);
        return {
          mode: 'mock',
          flashMode: 'mock',
          codegraphMode: codegraphMode,
          codegraphTransport: codegraphTransport,
          blocked: false,
          result: mockResult,
        };
      }

      var provider = findProvider(opts.providerList, opts.provider);
      if (!provider) {
        return {
          mode: 'live',
          flashMode: 'live',
          blocked: true,
          diagnostic: {
            code: 'FLASH_PROVIDER_NOT_SELECTED',
            message: 'Select a flash provider to use live mode.',
          },
        };
      }
      if (!provider.hasApiKey) {
        var envName = nullableString(provider.apiKeyEnv) || 'the provider API key env';
        var providerName = nullableString(provider.label) || String(provider.id);
        return {
          mode: 'live',
          flashMode: 'live',
          blocked: true,
          diagnostic: {
            code: 'FLASH_PROVIDER_AUTH_MISSING',
            message:
              'No API key configured for ' + providerName + '. Set ' + envName + ' in the global .env to use live mode.',
          },
        };
      }

      var liveResult = await composer.generatePreviewLive(
        opts.task,
        opts.provider,
        opts.model,
        codegraphMode,
        taskNormalizerEnabled,
        codegraphTransport,
      );
      return {
        mode: 'live',
        flashMode: 'live',
        codegraphMode: codegraphMode,
        codegraphTransport: codegraphTransport,
        blocked: false,
        result: liveResult,
      };
    }

    function safeDiagnostic(errLike) {
      var code = 'UNKNOWN';
      var message = 'unknown error';
      if (typeof errLike === 'string') {
        message = errLike;
      } else if (errLike) {
        if (errLike.code) code = String(errLike.code);
        if (errLike.message) message = String(errLike.message);
      }
      return redactSecrets(code + ' — ' + message);
    }

    function createController(opts) {
      var api = opts.api;
      var view = opts.view;
      var currentMode = 'live';
      var lastResolution = null;

      function renderPill() {
        view.setPill(buildPill(lastResolution, currentMode));
      }

      async function refresh() {
        try {
          var showResp = await api.show();
          var resolution = showResp && showResp.resolution ? showResp.resolution : null;
          if (!resolution) {
            view.setStatus('Flash configuration is unavailable.', 'error');
            return;
          }
          var provResp = await api.providers();
          var providers =
            provResp && Array.isArray(provResp.providers) ? provResp.providers : resolution.providers || [];

          lastResolution = resolution;
          renderPill();
          view.setSettings(buildSettings(resolution));
          view.setProviders(buildProviderList(providers));
          view.setComposer(buildComposerSelection(resolution));
        } catch (err) {
          view.setStatus(safeDiagnostic(err), 'error');
        }
      }

      // Flip the visible flash mode (Mock/Live) and re-render the header pill
      // from the already-loaded resolution; no config refetch is needed.
      function setMode(nextMode) {
        currentMode = normalizeMode(nextMode);
        if (lastResolution) renderPill();
        return currentMode;
      }

      async function runSync(invoke, okMessage) {
        try {
          var res = await invoke();
          if (!res || res.ok !== true) {
            var error = res && res.error ? res.error : { code: 'CONFIG_SYNC_FAILED', message: 'config sync failed' };
            view.setStatus(safeDiagnostic(error), 'error');
            return;
          }
          view.setStatus(okMessage, 'ok');
          await refresh();
        } catch (err) {
          view.setStatus(safeDiagnostic(err), 'error');
        }
      }

      function syncFromGlobal() {
        return runSync(function () {
          return api.syncFromGlobal();
        }, 'Synced global → local.');
      }

      async function rememberLiveSelection(provider, model) {
        try {
          var res = await api.rememberLiveSelection(provider, model);
          if (!res || res.ok !== true) {
            var error =
              res && res.error
                ? res.error
                : { code: 'CONFIG_REMEMBER_SELECTION_FAILED', message: 'could not remember flash selection' };
            view.setStatus(safeDiagnostic(error), 'error');
            return;
          }
          await refresh();
        } catch (err) {
          view.setStatus(safeDiagnostic(err), 'error');
        }
      }

      async function openConfigFolder() {
        try {
          var res = await api.openDir();
          if (!res || res.ok !== true) {
            var detail = res && res.error ? res.error : 'could not open the config folder';
            view.setStatus(safeDiagnostic({ code: 'OPEN_CONFIG_DIR_FAILED', message: String(detail) }), 'error');
            return;
          }
          view.setStatus('Opened config folder.', 'ok');
        } catch (err) {
          view.setStatus(safeDiagnostic(err), 'error');
        }
      }

      return {
        refresh: refresh,
        setMode: setMode,
        rememberLiveSelection: rememberLiveSelection,
        syncFromGlobal: syncFromGlobal,
        openConfigFolder: openConfigFolder,
      };
    }

    return {
      buildPill: buildPill,
      buildSettings: buildSettings,
      buildProviderList: buildProviderList,
      buildComposerSelection: buildComposerSelection,
      composerModeState: composerModeState,
      composerKeyStatus: composerKeyStatus,
      readTaskNormalizerEnabled: readTaskNormalizerEnabled,
      writeTaskNormalizerEnabled: writeTaskNormalizerEnabled,
      readCodeGraphTransport: readCodeGraphTransport,
      writeCodeGraphTransport: writeCodeGraphTransport,
      normalizeCodeGraphTransport: normalizeCodeGraphTransport,
      CODEGRAPH_TRANSPORT_STORAGE_KEY: CODEGRAPH_TRANSPORT_STORAGE_KEY,
      DEFAULT_CODEGRAPH_TRANSPORT: DEFAULT_CODEGRAPH_TRANSPORT,
      runComposerPreview: runComposerPreview,
      modelsForProvider: modelsForProvider,
      safeDiagnostic: safeDiagnostic,
      createController: createController,
    };
  },
);
