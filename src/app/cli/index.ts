import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { Command } from 'commander';
import YAML from 'yaml';

import { createRun } from '../../core/runs/run_store.js';
import { updateCurrent } from '../../core/runs/current.js';
import { initWorkspace } from '../../core/workspace/initializer.js';
import { getWorkspacePaths } from '../../core/workspace/paths.js';
import { RunManifest } from '../../core/models/index.js';

const SCANNER_DIR = path.resolve(__dirname, '../../core/scanning/python');

function pythonAvailable(): boolean {
  const result = spawnSync('python', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

export interface ScanResult {
  status: 'ok' | 'error';
  run_id: string;
  scanDir: string;
  artifacts?: Record<string, string>;
  diagnostic?: string;
}

export async function runScan(opts: {
  task: string;
  repoRoot: string;
  jsonOutput?: boolean;
}): Promise<ScanResult> {
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

  const scannerConfigPath = path.join(runDir, 'scanner_config.json');
  const scannerArgs = [
    '-m', 'vibecode_scanner',
    '--repo', opts.repoRoot,
    '--task', opts.task,
    '--scanner-config', scannerConfigPath,
    '--out', scanDir,
  ];

  const result = spawnSync('python', scannerArgs, {
    cwd: SCANNER_DIR,
    encoding: 'utf8',
    timeout: 120000,
  });

  // Update run manifest
  const runManifestPath = path.join(runDir, 'run_manifest.json');
  const manifest: RunManifest = JSON.parse(fs.readFileSync(runManifestPath, 'utf8'));

  if (result.status !== 0) {
    const errorManifest: RunManifest = {
      ...manifest,
      status: 'error',
    };
    fs.writeFileSync(runManifestPath, `${JSON.stringify(errorManifest, null, 2)}\n`, 'utf8');
    await updateCurrent(paths.vibecode, errorManifest);

    const diagnostic = result.stderr || result.stdout || `scanner exited with code ${result.status}`;
    return { status: 'error', run_id, scanDir, diagnostic };
  }

  // Parse scanner stdout JSON summary if present
  let artifacts: Record<string, string> | undefined;
  if (result.stdout && result.stdout.trim()) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      artifacts = parsed.artifacts;
    } catch {
      // Not JSON output - that's fine
    }
  }

  // Read scan_manifest.json for artifact list
  const scanManifestPath = path.join(scanDir, 'scan_manifest.json');
  if (!artifacts && fs.existsSync(scanManifestPath)) {
    try {
      const scanManifest = JSON.parse(fs.readFileSync(scanManifestPath, 'utf8'));
      artifacts = scanManifest.artifacts;
    } catch {
      // ignore
    }
  }

  const doneManifest: RunManifest = {
    ...manifest,
    status: 'done',
  };
  fs.writeFileSync(runManifestPath, `${JSON.stringify(doneManifest, null, 2)}\n`, 'utf8');
  await updateCurrent(paths.vibecode, doneManifest);

  return { status: 'ok', run_id, scanDir, artifacts };
}

export function createCli(): Command {
  const program = new Command();
  program.name('vibecode').description('VibecodeLight CLI');

  program
    .command('doctor')
    .description('Check local prerequisites and workspace status')
    .action(() => {
      const root = process.cwd();
      const paths = getWorkspacePaths(root);
      const configExists = fs.existsSync(paths.config);
      let configStatus = 'missing';
      if (configExists) {
        try {
          YAML.parse(fs.readFileSync(paths.config, 'utf8'));
          configStatus = 'ok';
        } catch {
          configStatus = 'invalid';
        }
      }
      const nodeStatus = process.versions.node;
      const pythonStatus = pythonAvailable() ? 'ok' : 'missing';
      console.log(`status: ok`);
      console.log(`node: ${nodeStatus}`);
      console.log(`config.yaml: ${configStatus}`);
      console.log(`python: ${pythonStatus}`);
    });

  program
    .command('init')
    .option('--repo <path>', 'Repository path', process.cwd())
    .description('Initialize the VibecodeLight workspace')
    .action(async (options: { repo: string }) => {
      const result = await initWorkspace(path.resolve(options.repo));
      console.log(JSON.stringify(result, null, 2));
    });

  program
    .command('scan <task>')
    .description('Create a new run and scan the repository')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output JSON envelope to stdout')
    .action(async (task: string, options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const result = await runScan({ task, repoRoot, jsonOutput: options.json });

      if (options.json) {
        console.log(JSON.stringify({ status: result.status, run_id: result.run_id }));
      } else if (result.status === 'error') {
        console.error(`scan failed: ${result.diagnostic}`);
        process.exitCode = 1;
      } else {
        console.log(`run: ${result.run_id}`);
        console.log(`scan: ${result.scanDir}`);
      }
    });

  const run = program.command('run').description('Run operations');
  run
    .command('create <task>')
    .description('Create a new run package')
    .action(async (task: string) => {
      const root = process.cwd();
      const paths = getWorkspacePaths(root);
      const result = await createRun({ vibecodePath: paths.vibecode, task, repoRoot: root });
      console.log(result.run_id);
    });

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = createCli();
  await program.parseAsync(argv);
}

if (require.main === module) {
  void runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
