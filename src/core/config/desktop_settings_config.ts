import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { getGlobalConfigPaths } from './user_profile.js';

export type DesktopSettingSource = 'global' | 'default';
export type DesktopCodeGraphModeSettingValue = 'detect-only' | 'use-existing';

const DEFAULT_DESKTOP_CODEGRAPH_MODE: DesktopCodeGraphModeSettingValue = 'detect-only';
const DEFAULT_DESKTOP_BOOLEAN_SETTING = false;
const DESKTOP_CODEGRAPH_MODES: DesktopCodeGraphModeSettingValue[] = ['detect-only', 'use-existing'];

export interface DesktopCodeGraphModeSetting {
  mode: DesktopCodeGraphModeSettingValue;
  default: DesktopCodeGraphModeSettingValue;
  source: DesktopSettingSource;
  globalConfigPath: string;
  globalConfigExists: boolean;
  warnings: string[];
}

export interface WriteDesktopCodeGraphModeSettingResult extends DesktopCodeGraphModeSetting {
  artifactPath: string;
}

export interface DesktopBooleanSetting {
  enabled: boolean;
  default: boolean;
  source: DesktopSettingSource;
  globalConfigPath: string;
  globalConfigExists: boolean;
  warnings: string[];
}

export interface WriteDesktopBooleanSettingResult extends DesktopBooleanSetting {
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
        `CONFIG_PARSE_WARNING: could not parse global config ${filePath}; using desktop remembered setting defaults.`,
        error instanceof Error ? error.message : String(error),
      ],
    };
  }
}

function getNestedRecord(root: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = root[key];
  return isRecord(value) ? value : undefined;
}

function getOrCreateNestedRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(root[key])) root[key] = {};
  return root[key] as Record<string, unknown>;
}

function globalConfigPath(opts: { env?: Record<string, string | undefined>; globalConfigPath?: string }): string {
  return opts.globalConfigPath ?? getGlobalConfigPaths(opts.env ?? process.env).config;
}

function readDesktopSection(root: Record<string, unknown>, section: string): Record<string, unknown> | undefined {
  return getNestedRecord(getNestedRecord(root, 'desktop') ?? {}, section);
}

function ensureDesktopSection(root: Record<string, unknown>, section: string): Record<string, unknown> {
  if (typeof root.version !== 'number') root.version = 1;
  const desktop = getOrCreateNestedRecord(root, 'desktop');
  return getOrCreateNestedRecord(desktop, section);
}

function cleanupDesktopSection(root: Record<string, unknown>, section: string, key: string): void {
  const desktop = getNestedRecord(root, 'desktop');
  const nested = desktop ? getNestedRecord(desktop, section) : undefined;
  if (!desktop || !nested || !Object.prototype.hasOwnProperty.call(nested, key)) return;
  delete nested[key];
  if (Object.keys(nested).length === 0) delete desktop[section];
  if (Object.keys(desktop).length === 0) delete root.desktop;
}

function persistConfig(filePath: string, root: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(root), 'utf8');
}

function isDesktopCodeGraphMode(value: unknown): value is DesktopCodeGraphModeSettingValue {
  return typeof value === 'string' && (DESKTOP_CODEGRAPH_MODES as string[]).includes(value);
}

function assertDesktopCodeGraphMode(value: unknown): asserts value is DesktopCodeGraphModeSettingValue {
  if (!isDesktopCodeGraphMode(value)) {
    throw new Error(`INVALID_DESKTOP_CODEGRAPH_MODE: expected one of ${DESKTOP_CODEGRAPH_MODES.join(', ')}; got ${JSON.stringify(value)}.`);
  }
}

function assertBooleanSetting(value: unknown, code: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${code}: expected boolean; got ${JSON.stringify(value)}.`);
  }
}

export function readDesktopCodeGraphModeSetting(opts: {
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
} = {}): DesktopCodeGraphModeSetting {
  const configPath = globalConfigPath(opts);
  const globalConfigExists = fs.existsSync(configPath);
  const { root, warnings } = readYamlObject(configPath);
  const rawMode = readDesktopSection(root, 'codegraph')?.mode;

  if (isDesktopCodeGraphMode(rawMode)) {
    return {
      mode: rawMode,
      default: DEFAULT_DESKTOP_CODEGRAPH_MODE,
      source: 'global',
      globalConfigPath: configPath,
      globalConfigExists,
      warnings,
    };
  }

  if (rawMode !== undefined) {
    warnings.push(
      `INVALID_DESKTOP_CODEGRAPH_MODE_CONFIG: desktop.codegraph.mode must be one of detect-only, use-existing; got ${JSON.stringify(rawMode)}. Using ${DEFAULT_DESKTOP_CODEGRAPH_MODE}.`,
    );
  }

  return {
    mode: DEFAULT_DESKTOP_CODEGRAPH_MODE,
    default: DEFAULT_DESKTOP_CODEGRAPH_MODE,
    source: 'default',
    globalConfigPath: configPath,
    globalConfigExists,
    warnings,
  };
}

export function writeDesktopCodeGraphModeSetting(opts: {
  mode: DesktopCodeGraphModeSettingValue;
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
}): WriteDesktopCodeGraphModeSettingResult {
  assertDesktopCodeGraphMode(opts.mode);
  const configPath = globalConfigPath(opts);
  const { root, warnings } = readYamlObject(configPath);
  ensureDesktopSection(root, 'codegraph').mode = opts.mode;
  persistConfig(configPath, root);

  return {
    mode: opts.mode,
    default: DEFAULT_DESKTOP_CODEGRAPH_MODE,
    source: 'global',
    globalConfigPath: configPath,
    globalConfigExists: true,
    warnings,
    artifactPath: configPath,
  };
}

export function resetDesktopCodeGraphModeSetting(opts: {
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
} = {}): WriteDesktopCodeGraphModeSettingResult {
  const configPath = globalConfigPath(opts);
  const existsBefore = fs.existsSync(configPath);
  const { root, warnings } = readYamlObject(configPath);
  if (existsBefore) {
    cleanupDesktopSection(root, 'codegraph', 'mode');
    persistConfig(configPath, root);
  }
  return {
    mode: DEFAULT_DESKTOP_CODEGRAPH_MODE,
    default: DEFAULT_DESKTOP_CODEGRAPH_MODE,
    source: 'default',
    globalConfigPath: configPath,
    globalConfigExists: fs.existsSync(configPath),
    warnings,
    artifactPath: configPath,
  };
}

function readDesktopBooleanSetting(opts: {
  section: 'task_normalizer' | 'auto_approve';
  invalidConfigCode: string;
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
}): DesktopBooleanSetting {
  const configPath = globalConfigPath(opts);
  const globalConfigExists = fs.existsSync(configPath);
  const { root, warnings } = readYamlObject(configPath);
  const rawEnabled = readDesktopSection(root, opts.section)?.enabled;

  if (typeof rawEnabled === 'boolean') {
    return {
      enabled: rawEnabled,
      default: DEFAULT_DESKTOP_BOOLEAN_SETTING,
      source: 'global',
      globalConfigPath: configPath,
      globalConfigExists,
      warnings,
    };
  }

  if (rawEnabled !== undefined) {
    warnings.push(
      `${opts.invalidConfigCode}: desktop.${opts.section}.enabled must be a boolean; got ${JSON.stringify(rawEnabled)}. Using false.`,
    );
  }

  return {
    enabled: DEFAULT_DESKTOP_BOOLEAN_SETTING,
    default: DEFAULT_DESKTOP_BOOLEAN_SETTING,
    source: 'default',
    globalConfigPath: configPath,
    globalConfigExists,
    warnings,
  };
}

function writeDesktopBooleanSetting(opts: {
  section: 'task_normalizer' | 'auto_approve';
  enabled: boolean;
  invalidWriteCode: string;
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
}): WriteDesktopBooleanSettingResult {
  assertBooleanSetting(opts.enabled, opts.invalidWriteCode);
  const configPath = globalConfigPath(opts);
  const { root, warnings } = readYamlObject(configPath);
  ensureDesktopSection(root, opts.section).enabled = opts.enabled;
  persistConfig(configPath, root);

  return {
    enabled: opts.enabled,
    default: DEFAULT_DESKTOP_BOOLEAN_SETTING,
    source: 'global',
    globalConfigPath: configPath,
    globalConfigExists: true,
    warnings,
    artifactPath: configPath,
  };
}

function resetDesktopBooleanSetting(opts: {
  section: 'task_normalizer' | 'auto_approve';
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
}): WriteDesktopBooleanSettingResult {
  const configPath = globalConfigPath(opts);
  const existsBefore = fs.existsSync(configPath);
  const { root, warnings } = readYamlObject(configPath);
  if (existsBefore) {
    cleanupDesktopSection(root, opts.section, 'enabled');
    persistConfig(configPath, root);
  }

  return {
    enabled: DEFAULT_DESKTOP_BOOLEAN_SETTING,
    default: DEFAULT_DESKTOP_BOOLEAN_SETTING,
    source: 'default',
    globalConfigPath: configPath,
    globalConfigExists: fs.existsSync(configPath),
    warnings,
    artifactPath: configPath,
  };
}

export function readDesktopTaskNormalizerEnabledSetting(opts: {
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
} = {}): DesktopBooleanSetting {
  return readDesktopBooleanSetting({
    ...opts,
    section: 'task_normalizer',
    invalidConfigCode: 'INVALID_DESKTOP_TASK_NORMALIZER_ENABLED_CONFIG',
  });
}

export function writeDesktopTaskNormalizerEnabledSetting(opts: {
  enabled: boolean;
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
}): WriteDesktopBooleanSettingResult {
  return writeDesktopBooleanSetting({
    ...opts,
    section: 'task_normalizer',
    invalidWriteCode: 'INVALID_DESKTOP_TASK_NORMALIZER_ENABLED',
  });
}

export function resetDesktopTaskNormalizerEnabledSetting(opts: {
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
} = {}): WriteDesktopBooleanSettingResult {
  return resetDesktopBooleanSetting({ ...opts, section: 'task_normalizer' });
}

export function readDesktopAutoApproveEnabledSetting(opts: {
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
} = {}): DesktopBooleanSetting {
  return readDesktopBooleanSetting({
    ...opts,
    section: 'auto_approve',
    invalidConfigCode: 'INVALID_DESKTOP_AUTO_APPROVE_ENABLED_CONFIG',
  });
}

export function writeDesktopAutoApproveEnabledSetting(opts: {
  enabled: boolean;
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
}): WriteDesktopBooleanSettingResult {
  return writeDesktopBooleanSetting({
    ...opts,
    section: 'auto_approve',
    invalidWriteCode: 'INVALID_DESKTOP_AUTO_APPROVE_ENABLED',
  });
}

export function resetDesktopAutoApproveEnabledSetting(opts: {
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
} = {}): WriteDesktopBooleanSettingResult {
  return resetDesktopBooleanSetting({ ...opts, section: 'auto_approve' });
}
