import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import {
  DEFAULT_CODEGRAPH_TRANSPORT,
  parseCodeGraphTransport,
  type CodeGraphTransport,
} from '../../adapters/codegraph/codegraph_transport.js';
import { getGlobalConfigPaths } from './user_profile.js';

export type CodeGraphTransportSettingSource = 'global' | 'default';

export interface CodeGraphTransportSetting {
  transport: CodeGraphTransport;
  default: CodeGraphTransport;
  source: CodeGraphTransportSettingSource;
  globalConfigPath: string;
  globalConfigExists: boolean;
  warnings: string[];
}

export interface WriteCodeGraphTransportSettingResult extends CodeGraphTransportSetting {
  artifactPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readYamlObject(filePath: string): { root: Record<string, unknown>; warnings: string[] } {
  if (!fs.existsSync(filePath)) return { root: {}, warnings: [] };
  try {
    const parsed = YAML.parse(fs.readFileSync(filePath, 'utf8'));
    return { root: isRecord(parsed) ? parsed : {}, warnings: [] };
  } catch (error) {
    return {
      root: {},
      warnings: [
        `CONFIG_PARSE_WARNING: could not parse global config ${filePath}; using CodeGraph transport default (${DEFAULT_CODEGRAPH_TRANSPORT}).`,
        error instanceof Error ? error.message : String(error),
      ],
    };
  }
}

function getNestedRecord(root: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = root[key];
  return isRecord(value) ? value : undefined;
}

export function readCodeGraphTransportSetting(opts: {
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
} = {}): CodeGraphTransportSetting {
  const globalConfigPath = opts.globalConfigPath ?? getGlobalConfigPaths(opts.env ?? process.env).config;
  const globalConfigExists = fs.existsSync(globalConfigPath);
  const { root, warnings } = readYamlObject(globalConfigPath);
  const codegraph = getNestedRecord(getNestedRecord(root, 'defaults') ?? {}, 'codegraph');
  const rawTransport = codegraph?.transport;
  const parsed = parseCodeGraphTransport(rawTransport);

  if (parsed) {
    return {
      transport: parsed,
      default: DEFAULT_CODEGRAPH_TRANSPORT,
      source: 'global',
      globalConfigPath,
      globalConfigExists,
      warnings,
    };
  }

  if (rawTransport !== undefined) {
    warnings.push(
      `INVALID_CODEGRAPH_TRANSPORT_CONFIG: defaults.codegraph.transport must be one of cli, mcp, auto; got ${JSON.stringify(rawTransport)}. Using ${DEFAULT_CODEGRAPH_TRANSPORT}.`,
    );
  }

  return {
    transport: DEFAULT_CODEGRAPH_TRANSPORT,
    default: DEFAULT_CODEGRAPH_TRANSPORT,
    source: 'default',
    globalConfigPath,
    globalConfigExists,
    warnings,
  };
}

export function writeCodeGraphTransportSetting(opts: {
  transport: CodeGraphTransport;
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
}): WriteCodeGraphTransportSettingResult {
  const globalConfigPath = opts.globalConfigPath ?? getGlobalConfigPaths(opts.env ?? process.env).config;
  const { root, warnings } = readYamlObject(globalConfigPath);

  if (typeof root.version !== 'number') root.version = 1;
  if (!isRecord(root.providers)) root.providers = {};
  if (!isRecord(root.defaults)) root.defaults = {};
  const defaults = root.defaults as Record<string, unknown>;
  if (!isRecord(defaults.flash)) defaults.flash = {};
  if (!isRecord(defaults.codegraph)) defaults.codegraph = {};
  const codegraph = defaults.codegraph as Record<string, unknown>;
  codegraph.transport = opts.transport;

  fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
  fs.writeFileSync(globalConfigPath, YAML.stringify(root), 'utf8');

  return {
    transport: opts.transport,
    default: DEFAULT_CODEGRAPH_TRANSPORT,
    source: 'global',
    globalConfigPath,
    globalConfigExists: true,
    warnings,
    artifactPath: globalConfigPath,
  };
}

export function resetCodeGraphTransportSetting(opts: {
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
} = {}): WriteCodeGraphTransportSettingResult {
  const globalConfigPath = opts.globalConfigPath ?? getGlobalConfigPaths(opts.env ?? process.env).config;
  const globalConfigExistsBefore = fs.existsSync(globalConfigPath);
  const { root, warnings } = readYamlObject(globalConfigPath);

  if (globalConfigExistsBefore) {
    const defaults = getNestedRecord(root, 'defaults');
    const codegraph = defaults ? getNestedRecord(defaults, 'codegraph') : undefined;
    if (codegraph && Object.prototype.hasOwnProperty.call(codegraph, 'transport')) {
      delete codegraph.transport;
      if (Object.keys(codegraph).length === 0) delete defaults!.codegraph;
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(globalConfigPath, YAML.stringify(root), 'utf8');
    }
  }

  return {
    transport: DEFAULT_CODEGRAPH_TRANSPORT,
    default: DEFAULT_CODEGRAPH_TRANSPORT,
    source: 'default',
    globalConfigPath,
    globalConfigExists: fs.existsSync(globalConfigPath),
    warnings,
    artifactPath: globalConfigPath,
  };
}
