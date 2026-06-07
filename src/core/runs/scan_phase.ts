import fs from 'fs';
import path from 'path';

import { RunManifest } from '../models/index.js';
import { buildSkillsCatalog, writeSkillsCatalog } from '../skills/catalog.js';
import { getWorkspacePaths } from '../workspace/paths.js';
import { invokeScan } from '../scanning/scanner_subprocess.js';
import { buildScannerConfig, buildScannerConfigPayload } from '../scanning/scanner_config.js';
import { writeExternalToolsArtifact } from '../scanning/external_tools.js';
import { detectCodeGraph } from '../../adapters/codegraph/codegraph_cli.js';
import type { TaskIntent } from '../../adapters/task_normalizer/types.js';
import { updateCurrent } from './current.js';
import { createRun } from './run_store.js';

export function resolveScannerDir(fromDir: string): string {
  return path.resolve(fromDir, '../../../src/core/scanning/python');
}

const SCANNER_DIR = resolveScannerDir(__dirname);

export interface ScannerPhaseSuccess {
  status: 'ok';
  run_id: string;
  runDir: string;
  scanDir: string;
  vibecodePath: string;
  runManifestPath: string;
  manifest: RunManifest;
  artifacts: Record<string, string>;
  warnings: string[];
}

export interface ScannerPhaseError {
  status: 'error';
  run_id: string;
  runDir: string;
  scanDir: string;
  vibecodePath: string;
  diagnostic: string;
}

export type ScannerPhaseResult = ScannerPhaseSuccess | ScannerPhaseError;

export function writeRunManifest(runManifestPath: string, manifest: RunManifest): void {
  fs.writeFileSync(runManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function performScanPhase(opts: {
  task: string;
  repoRoot: string;
  taskIntent?: TaskIntent;
}): Promise<ScannerPhaseResult> {
  const paths = getWorkspacePaths(opts.repoRoot);

  // Ensure .vibecode/ exists
  if (!fs.existsSync(paths.vibecode)) {
    fs.mkdirSync(path.join(paths.vibecode, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(paths.vibecode, 'current'), { recursive: true });
  }

  const { run_id, runDir, scanDir } = await createRun({
    vibecodePath: paths.vibecode,
    task: opts.task,
    repoRoot: opts.repoRoot,
  });

  // TypeScript-owned skills catalog for this run. Built from user-profile +
  // project SKILLS/ before the scanner runs so it is always present in the
  // run package even if the scanner subprocess fails.
  const catalog = buildSkillsCatalog({ repoRoot: opts.repoRoot });
  writeSkillsCatalog(path.join(runDir, 'skills', 'skills_catalog.json'), catalog);

  const scannerConfig = buildScannerConfig({
    run_id,
    task: opts.task,
    repo_root: opts.repoRoot,
    out_dir: 'scan',
  });

  const scannerConfigPath = path.join(runDir, 'scanner_config.json');
  const configPayload = buildScannerConfigPayload(scannerConfig, opts.taskIntent);
  fs.writeFileSync(scannerConfigPath, `${JSON.stringify(configPayload, null, 2)}\n`, 'utf8');

  try {
    await invokeScan({
      scannerDir: SCANNER_DIR,
      config: scannerConfig,
      repoRoot: opts.repoRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const runManifestPath = path.join(runDir, 'run_manifest.json');
    let manifest: RunManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(runManifestPath, 'utf8')) as RunManifest;
    } catch {
      return { status: 'error', run_id, runDir, scanDir, vibecodePath: paths.vibecode, diagnostic: message };
    }
    const errorManifest: RunManifest = { ...manifest, status: 'error' };
    writeRunManifest(runManifestPath, errorManifest);
    await updateCurrent(paths.vibecode, errorManifest);

    return { status: 'error', run_id, runDir, scanDir, vibecodePath: paths.vibecode, diagnostic: message };
  }

  const runManifestPath = path.join(runDir, 'run_manifest.json');
  let manifest: RunManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(runManifestPath, 'utf8')) as RunManifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = [
      `RUN_MANIFEST_INVALID: failed to read run manifest at ${runManifestPath}`,
      `repoRoot=${opts.repoRoot}`,
      `runDir=${runDir}`,
      `error=${message}`,
    ].join('\n');
    return { status: 'error', run_id, runDir, scanDir, vibecodePath: paths.vibecode, diagnostic };
  }

  // Read scan_manifest.json for artifact list and warnings (authoritative)
  let artifacts: Record<string, string> = {};
  let warnings: string[] = [];
  const scanManifestPath = path.join(scanDir, 'scan_manifest.json');
  if (fs.existsSync(scanManifestPath)) {
    try {
      const scanManifest = JSON.parse(fs.readFileSync(scanManifestPath, 'utf8'));
      if (Object.keys(artifacts).length === 0 && scanManifest && typeof scanManifest === 'object') {
        artifacts = (scanManifest.artifacts as Record<string, string>) ?? {};
      }
      if (Array.isArray(scanManifest.warnings)) {
        warnings = scanManifest.warnings;
      }
    } catch {
      // ignore
    }
  }

  // TypeScript-owned external-tool detection (detect-only). Records optional
  // CodeGraph availability/initialization without running it or scanning
  // `.codegraph/`. Detection failures become warnings, never a scan failure.
  try {
    const detection = await detectCodeGraph(opts.repoRoot);
    const externalToolsPath = writeExternalToolsArtifact(scanDir, detection);
    artifacts = { ...artifacts, external_tools: externalToolsPath };
    warnings = [...warnings, ...detection.warnings];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings = [...warnings, `EXTERNAL_TOOLS_DETECTION_FAILED: ${message}`];
  }

  return {
    status: 'ok',
    run_id,
    runDir,
    scanDir,
    vibecodePath: paths.vibecode,
    runManifestPath,
    manifest,
    artifacts,
    warnings,
  };
}
