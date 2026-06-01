import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { getGlobalConfigPaths } from './user_profile.js';

export type CodeGraphBinarySettingSource = 'global' | 'default';

export interface CodeGraphBinarySetting {
  /** Persisted binary path from global config, or null if none. */
  binary: string | null;
  source: CodeGraphBinarySettingSource;
  globalConfigPath: string;
  globalConfigExists: boolean;
  warnings: string[];
}

export interface WriteCodeGraphBinarySettingResult extends CodeGraphBinarySetting {
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
        `CONFIG_PARSE_WARNING: could not parse global config ${filePath}; using CodeGraph binary default (PATH fallback).`,
        error instanceof Error ? error.message : String(error),
      ],
    };
  }
}

function getNestedRecord(root: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = root[key];
  return isRecord(value) ? value : undefined;
}

export function readCodeGraphBinarySetting(opts: {
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
} = {}): CodeGraphBinarySetting {
  const globalConfigPath = opts.globalConfigPath ?? getGlobalConfigPaths(opts.env ?? process.env).config;
  const globalConfigExists = fs.existsSync(globalConfigPath);
  const { root, warnings } = readYamlObject(globalConfigPath);
  const codegraph = getNestedRecord(getNestedRecord(root, 'defaults') ?? {}, 'codegraph');
  const raw = codegraph?.binary;

  if (typeof raw === 'string' && raw.trim().length > 0) {
    return {
      binary: raw.trim(),
      source: 'global',
      globalConfigPath,
      globalConfigExists,
      warnings,
    };
  }

  if (raw !== undefined && (typeof raw !== 'string' || raw.trim().length === 0)) {
    warnings.push(
      `INVALID_CODEGRAPH_BINARY_CONFIG: defaults.codegraph.binary must be a non-empty string; got ${JSON.stringify(raw)}. Ignoring.`,
    );
  }

  return {
    binary: null,
    source: 'default',
    globalConfigPath,
    globalConfigExists,
    warnings,
  };
}

export class InvalidCodeGraphBinaryError extends Error {
  code = 'INVALID_CODEGRAPH_BINARY' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCodeGraphBinaryError';
  }
}

export function writeCodeGraphBinarySetting(opts: {
  binary: string;
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
}): WriteCodeGraphBinarySettingResult {
  const trimmed = typeof opts.binary === 'string' ? opts.binary.trim() : '';
  if (trimmed.length === 0) {
    throw new InvalidCodeGraphBinaryError(
      'INVALID_CODEGRAPH_BINARY: CodeGraph binary path must be a non-empty string',
    );
  }
  const globalConfigPath = opts.globalConfigPath ?? getGlobalConfigPaths(opts.env ?? process.env).config;
  const { root, warnings } = readYamlObject(globalConfigPath);

  if (typeof root.version !== 'number') root.version = 1;
  if (!isRecord(root.providers)) root.providers = {};
  if (!isRecord(root.defaults)) root.defaults = {};
  const defaults = root.defaults as Record<string, unknown>;
  if (!isRecord(defaults.flash)) defaults.flash = {};
  if (!isRecord(defaults.codegraph)) defaults.codegraph = {};
  const codegraph = defaults.codegraph as Record<string, unknown>;
  codegraph.binary = trimmed;

  fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
  fs.writeFileSync(globalConfigPath, YAML.stringify(root), 'utf8');

  return {
    binary: trimmed,
    source: 'global',
    globalConfigPath,
    globalConfigExists: true,
    warnings,
    artifactPath: globalConfigPath,
  };
}

export function resetCodeGraphBinarySetting(opts: {
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
} = {}): WriteCodeGraphBinarySettingResult {
  const globalConfigPath = opts.globalConfigPath ?? getGlobalConfigPaths(opts.env ?? process.env).config;
  const globalConfigExistsBefore = fs.existsSync(globalConfigPath);
  const { root, warnings } = readYamlObject(globalConfigPath);

  if (globalConfigExistsBefore) {
    const defaults = getNestedRecord(root, 'defaults');
    const codegraph = defaults ? getNestedRecord(defaults, 'codegraph') : undefined;
    if (codegraph && Object.prototype.hasOwnProperty.call(codegraph, 'binary')) {
      delete codegraph.binary;
      if (Object.keys(codegraph).length === 0) delete defaults!.codegraph;
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(globalConfigPath, YAML.stringify(root), 'utf8');
    }
  }

  return {
    binary: null,
    source: 'default',
    globalConfigPath,
    globalConfigExists: fs.existsSync(globalConfigPath),
    warnings,
    artifactPath: globalConfigPath,
  };
}
