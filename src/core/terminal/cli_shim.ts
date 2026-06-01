import fs from 'fs';
import path from 'path';

export interface ShimPaths {
  binDir: string;
  windowsShimPath: string;
  posixShimPath: string;
}

export interface WriteShimOptions {
  repoPath: string;
  appCliPath: string;
  platform?: typeof process.platform;
}

export interface BuildEnvOptions {
  repoPath: string;
  appCliPath: string;
  platform?: typeof process.platform;
  baseEnv?: Record<string, string | undefined>;
}

export interface PrepareShimOptions extends BuildEnvOptions {}

const VIBECODE_DIR = '.vibecode';
const BIN_SUBDIR = 'bin';

export function shimBinDir(repoPath: string): string {
  return path.join(repoPath, VIBECODE_DIR, BIN_SUBDIR);
}

export function shimEntryPath(repoPath: string, platform: typeof process.platform = process.platform): string {
  const dir = shimBinDir(repoPath);
  return platform === 'win32' ? path.join(dir, 'vibecode.cmd') : path.join(dir, 'vibecode');
}

export function shimPathsFor(repoPath: string): ShimPaths {
  const binDir = shimBinDir(repoPath);
  return {
    binDir,
    windowsShimPath: path.join(binDir, 'vibecode.cmd'),
    posixShimPath: path.join(binDir, 'vibecode'),
  };
}

function windowsShimContent(appCliPath: string): string {
  return `@echo off\r\nnode "${appCliPath}" %*\r\n`;
}

function toShellPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function posixShimContent(appCliPath: string): string {
  const shellPath = toShellPath(appCliPath);
  return `#!/usr/bin/env sh\nexec node "${shellPath}" "$@"\n`;
}

function writeIfChanged(filePath: string, content: string): void {
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {
    existing = undefined;
  }
  if (existing === content) {
    return;
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

export function writeVibecodeCliShim(options: WriteShimOptions): ShimPaths {
  const platform = options.platform ?? process.platform;
  const paths = shimPathsFor(options.repoPath);
  fs.mkdirSync(paths.binDir, { recursive: true });

  if (platform === 'win32') {
    writeIfChanged(paths.windowsShimPath, windowsShimContent(options.appCliPath));
    writeIfChanged(paths.posixShimPath, posixShimContent(options.appCliPath));
    try {
      fs.chmodSync(paths.posixShimPath, 0o755);
    } catch {
      // chmod is best-effort on platforms (e.g. Windows) that don't support it.
    }
  } else {
    writeIfChanged(paths.posixShimPath, posixShimContent(options.appCliPath));
    try {
      fs.chmodSync(paths.posixShimPath, 0o755);
    } catch {
      // chmod is best-effort on platforms that don't support it.
    }
  }

  return paths;
}

function pickPathKey(env: Record<string, string | undefined>, platform: typeof process.platform): string {
  if (platform === 'win32') {
    if (env.Path !== undefined) return 'Path';
    if (env.PATH !== undefined) return 'PATH';
    return 'Path';
  }
  return 'PATH';
}

function prependPath(currentValue: string | undefined, entry: string): string {
  const current = currentValue ?? '';
  if (current.length === 0) {
    return entry;
  }
  const segments = current.split(path.delimiter);
  if (segments[0] === entry) {
    return current;
  }
  const filtered = segments.filter((seg) => seg !== entry);
  return `${entry}${path.delimiter}${filtered.join(path.delimiter)}`;
}

function normalizeBaseEnv(baseEnv: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!baseEnv) {
    return out;
  }
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

export function buildTerminalEnv(options: BuildEnvOptions): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const env = normalizeBaseEnv(options.baseEnv);
  const paths = shimPathsFor(options.repoPath);

  const pathKey = pickPathKey(options.baseEnv ?? env, platform);
  env[pathKey] = prependPath(env[pathKey], paths.binDir);

  env.VIBECODE_REPO = options.repoPath;
  env.VIBECODE_APP_CLI = options.appCliPath;
  env.VIBECODE_CLI_SHIM = platform === 'win32' ? paths.windowsShimPath : paths.posixShimPath;

  return env;
}

export function prepareVibecodeCliShim(options: PrepareShimOptions): {
  env: Record<string, string>;
  shimPaths: ShimPaths;
} {
  const shimPaths = writeVibecodeCliShim({
    repoPath: options.repoPath,
    appCliPath: options.appCliPath,
    platform: options.platform,
  });
  const env = buildTerminalEnv(options);
  return { env, shimPaths };
}

/**
 * Resolve the absolute path to this app's CLI entrypoint (bin/vibecode.js).
 * Walks up from this source file to find the package root that owns bin/vibecode.js.
 * Returns undefined when no entrypoint can be located (e.g. unsupported packaged mode).
 *
 * TODO: when packaged (Electron asar / pkg) mode is supported, return that
 * packaged entrypoint here. Dev mode is the only supported mode today.
 */
export function resolveAppCliPath(startDir: string = __dirname): string | undefined {
  let current = startDir;
  for (let i = 0; i < 10; i += 1) {
    const candidate = path.join(current, 'bin', 'vibecode.js');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}
