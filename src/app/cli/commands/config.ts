import path from 'path';

import { Command } from 'commander';

import {
  ensureLocalConfig,
  getConfigPaths,
  resolveFlashConfig,
  syncConfig,
} from '../../../core/config/index.js';

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('Inspect and sync global/local configuration');

  config
    .command('paths')
    .description('Show global and local configuration paths')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const paths = getConfigPaths(repoRoot, process.env);
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            global_dir: paths.globalDir,
            global_config: paths.globalConfig,
            global_env: paths.globalEnv,
            local_config: paths.localConfig,
          },
          artifacts: [],
          warnings: [],
        }));
        return;
      }
      console.log(`global_dir: ${paths.globalDir}`);
      console.log(`global_config: ${paths.globalConfig}`);
      console.log(`global_env: ${paths.globalEnv}`);
      console.log(`local_config: ${paths.localConfig}`);
    });

  config
    .command('show')
    .description('Show the resolved safe configuration and per-field source map (never prints API keys)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const resolved = resolveFlashConfig({ repoRoot, env: process.env });
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: resolved.resolution,
          artifacts: [],
          warnings: resolved.resolution.warnings,
        }));
        return;
      }
      const r = resolved.resolution;
      console.log(`selected_config_source: ${r.selected_config_source}`);
      console.log(`provider: ${r.provider ?? '(none)'} [${r.source_map.provider}]`);
      console.log(`provider_label: ${r.provider_label ?? '(none)'}`);
      console.log(`model: ${r.model ?? '(none)'} [${r.source_map.model}]`);
      console.log(`model_label: ${r.model_label ?? '(none)'}`);
      console.log(`baseUrl_host: ${r.baseUrl_host ?? '(none)'} [${r.source_map.baseUrl}]`);
      console.log(`api_key_env: ${r.api_key_env ?? '(none)'}`);
      console.log(`api_key: ${r.has_api_key ? 'configured' : 'missing'} [${r.source_map.apiKey}]`);
      console.log(`global_config: ${r.global_config_path} (${r.global_config_exists ? 'exists' : 'absent'})`);
      console.log(`global_env: ${r.global_env_path} (${r.global_env_exists ? 'exists' : 'absent'})`);
      console.log(`local_config: ${r.local_config_path} (${r.local_config_exists ? 'exists' : 'absent'})`);
      console.log('providers:');
      for (const p of r.providers) {
        console.log(`  ${p.id} [${p.origin}] api_key=${p.has_api_key ? 'configured' : 'missing'} (${p.api_key_env ?? 'no api_key_env'})`);
      }
      if (resolved.error) {
        console.log(`error: ${resolved.error.code} ${resolved.error.message}`);
      }
      for (const warning of r.warnings) {
        console.log(`warning: ${warning}`);
      }
    });

  config
    .command('providers')
    .description('List configured providers (and whether each has an API key) — never prints keys')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const resolved = resolveFlashConfig({ repoRoot, env: process.env });
      const r = resolved.resolution;
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            providers: r.providers,
            active_provider: r.provider,
            active_model: r.model,
            config_source: r.selected_config_source,
            local_config_path: r.local_config_path,
            global_config_path: r.global_config_path,
            global_env_path: r.global_env_path,
          },
          artifacts: [],
          warnings: r.warnings,
        }));
        return;
      }
      console.log(`active_provider: ${r.provider ?? '(none)'}`);
      console.log(`active_model: ${r.model ?? '(none)'}`);
      console.log(`config_source: ${r.selected_config_source}`);
      console.log('providers:');
      for (const p of r.providers) {
        console.log(`  ${p.id}\t${p.label ?? ''}\t[${p.origin}]\tapi_key=${p.has_api_key ? 'configured' : 'missing'} (${p.api_key_env ?? 'no api_key_env'})\tmodels=${p.models.length}`);
      }
    });

  config
    .command('models')
    .description('List models per configured provider — never prints keys')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--provider <id>', 'Limit to a single provider id')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; provider?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const resolved = resolveFlashConfig({ repoRoot, env: process.env });
      const r = resolved.resolution;
      const filtered = options.provider ? r.providers.filter((p) => p.id === options.provider) : r.providers;
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            providers: filtered.map((p) => ({ id: p.id, label: p.label, has_api_key: p.has_api_key, api_key_env: p.api_key_env, models: p.models })),
            active_provider: r.provider,
            active_model: r.model,
            config_source: r.selected_config_source,
          },
          artifacts: [],
          warnings: r.warnings,
        }));
        return;
      }
      for (const p of filtered) {
        console.log(`${p.id} [${p.origin}]:`);
        if (p.models.length === 0) {
          console.log('  (no models)');
        }
        for (const m of p.models) {
          const active = r.provider === p.id && r.model === m.id ? ' *active' : '';
          console.log(`  ${m.id}\t${m.label ?? ''}\t${m.role ?? ''}${active}`);
        }
      }
    });

  config
    .command('init-local')
    .description('Create the local workspace config from the global config (or safe defaults) if missing')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const result = ensureLocalConfig({ repoRoot, env: process.env });
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            local_config_path: result.localConfigPath,
            global_config_path: result.globalConfigPath,
            created: result.created,
            already_existed: result.alreadyExisted,
            created_from_global: result.createdFromGlobal,
            source: result.source,
          },
          artifacts: [result.localConfigPath],
          warnings: [],
        }));
        return;
      }
      console.log(`local_config: ${result.localConfigPath}`);
      console.log(`created: ${result.created}`);
      console.log(`created_from_global: ${result.createdFromGlobal}`);
      console.log(`source: ${result.source}`);
    });

  config
    .command('sync')
    .description('Sync global AppData config into this repository (global → local only)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--from-global', 'Overwrite local config from global config')
    .option('--to-global', '[disabled] Local-to-global sync is not allowed')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; fromGlobal?: boolean; toGlobal?: boolean; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);

      if (options.toGlobal) {
        const error = {
          code: 'CONFIG_SYNC_TO_GLOBAL_DISABLED',
          message: 'Local-to-global config sync is disabled. Use global-to-local sync only.',
          path: '',
          details: [],
        };
        if (options.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(`config sync failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      if (!options.fromGlobal) {
        const error = {
          code: 'SYNC_DIRECTION_REQUIRED',
          message: 'config sync requires --from-global',
          path: '',
          details: [],
        };
        if (options.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(`config sync failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      const direction = 'from-global' as const;
      const result = syncConfig({ direction, repoRoot, env: process.env });
      if (!result.ok) {
        const error = {
          code: result.error?.code ?? 'CONFIG_SYNC_FAILED',
          message: result.error?.message ?? 'config sync failed',
          path: result.sourcePath,
          details: result.error?.details ?? [],
        };
        if (options.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(`config sync failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            direction: result.direction,
            source: result.sourcePath,
            destination: result.destinationPath,
          },
          artifacts: [result.destinationPath],
          warnings: [],
        }));
        return;
      }
      console.log(`direction: ${result.direction}`);
      console.log(`source: ${result.sourcePath}`);
      console.log(`destination: ${result.destinationPath}`);
    });

}
