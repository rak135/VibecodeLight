import { readCodeGraphBinarySetting } from '../../core/config/codegraph_binary_config.js';
import { CODEGRAPH_COMMAND } from './codegraph_cli.js';

export type CodeGraphBinarySource =
  | 'CLI_OPTION'
  | 'VIBECODE_CODEGRAPH_BIN'
  | 'GLOBAL_CONFIG'
  | 'PATH_FALLBACK';

export interface CodeGraphBinaryResolution {
  /** The command/path that the runner should spawn. */
  command: string;
  /** Where the resolved command came from. */
  source: CodeGraphBinarySource;
  /**
   * The explicit value supplied by the caller / environment / persisted config.
   * Null when the resolver fell back to looking up `codegraph` on PATH.
   */
  configured: string | null;
}

export interface ResolveCodeGraphBinaryOptions {
  /** `--codegraph-bin <path>` value from a CLI command. */
  cliOption?: string | null;
  /** Override for testing. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Override for testing. Defaults to the user's global config path. */
  globalConfigPath?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve which `codegraph` binary the CLI/adapters should spawn.
 *
 * Priority (highest first):
 *   1. `--codegraph-bin <path>` CLI option
 *   2. `VIBECODE_CODEGRAPH_BIN` environment variable
 *   3. `defaults.codegraph.binary` in the user's global config
 *   4. fallback to the literal `codegraph` (resolved via PATH at spawn time)
 *
 * Empty / whitespace-only values are ignored at every level. The resolver
 * never touches the filesystem beyond reading the global config and never
 * spawns a process.
 */
export function resolveCodeGraphBinary(
  opts: ResolveCodeGraphBinaryOptions = {},
): CodeGraphBinaryResolution {
  const env = opts.env ?? process.env;

  const cli = nonEmptyString(opts.cliOption);
  if (cli) {
    return { command: cli, source: 'CLI_OPTION', configured: cli };
  }

  const envValue = nonEmptyString(env.VIBECODE_CODEGRAPH_BIN);
  if (envValue) {
    return { command: envValue, source: 'VIBECODE_CODEGRAPH_BIN', configured: envValue };
  }

  const setting = readCodeGraphBinarySetting({ env, globalConfigPath: opts.globalConfigPath });
  if (setting.binary) {
    return { command: setting.binary, source: 'GLOBAL_CONFIG', configured: setting.binary };
  }

  return { command: CODEGRAPH_COMMAND, source: 'PATH_FALLBACK', configured: null };
}

/**
 * Serializable view used in CLI JSON envelopes and log events.
 */
export function codeGraphBinaryDiagnostics(resolution: CodeGraphBinaryResolution): {
  command: string;
  source: CodeGraphBinarySource;
  configured: string | null;
} {
  return {
    command: resolution.command,
    source: resolution.source,
    configured: resolution.configured,
  };
}
