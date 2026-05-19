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
import {
  buildSkillsCatalog,
  discoverProjectSkills,
  writeSkillsCatalog,
} from '../../core/skills/catalog.js';
import { copyAllSkills, copySkill } from '../../core/skills/copy.js';
import {
  buildFlashInput,
  buildFlashInputManifest,
  FlashInputManifestError,
  formatPreviousRunSummary,
  getPreviousRunSummary,
} from '../../core/context/index.js';

const SCANNER_DIR = path.resolve(__dirname, '../../core/scanning/python');

function pythonAvailable(): boolean {
  const result = spawnSync('python', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

export interface ScanResult {
  status: 'ok' | 'error';
  run_id: string;
  runDir?: string;
  scanDir: string;
  artifacts?: Record<string, string>;
  warnings?: string[];
  diagnostic?: string;
}

interface ScannerPhaseSuccess {
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

interface ScannerPhaseError {
  status: 'error';
  run_id: string;
  runDir: string;
  scanDir: string;
  vibecodePath: string;
  diagnostic: string;
}

type ScannerPhaseResult = ScannerPhaseSuccess | ScannerPhaseError;

export interface ContextBuildResult {
  status: 'ok' | 'error';
  run_id: string;
  runDir: string;
  scanDir: string;
  flashDir: string;
  artifacts?: string[];
  warnings?: string[];
  diagnostic?: string;
  error?: {
    code: string;
    message: string;
    path?: string;
    details: string[];
  };
}

function writeRunManifest(runManifestPath: string, manifest: RunManifest): void {
  fs.writeFileSync(runManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function performScanPhase(opts: {
  task: string;
  repoRoot: string;
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

  const runManifestPath = path.join(runDir, 'run_manifest.json');
  const manifest: RunManifest = JSON.parse(fs.readFileSync(runManifestPath, 'utf8'));

  if (result.status !== 0) {
    const errorManifest: RunManifest = {
      ...manifest,
      status: 'error',
    };
    writeRunManifest(runManifestPath, errorManifest);
    await updateCurrent(paths.vibecode, errorManifest);

    const diagnostic = result.stderr || result.stdout || `scanner exited with code ${result.status}`;
    return { status: 'error', run_id, runDir, scanDir, vibecodePath: paths.vibecode, diagnostic };
  }

  // Parse scanner stdout JSON summary if present
  let artifacts: Record<string, string> = {};
  if (result.stdout && result.stdout.trim()) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      if (parsed && typeof parsed === 'object' && parsed.artifacts && typeof parsed.artifacts === 'object') {
        artifacts = parsed.artifacts as Record<string, string>;
      }
    } catch {
      // Not JSON output - that's fine
    }
  }

  // Read scan_manifest.json for artifact list and warnings (authoritative)
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

export async function runScan(opts: {
  task: string;
  repoRoot: string;
  jsonOutput?: boolean;
}): Promise<ScanResult> {
  const result = await performScanPhase({ task: opts.task, repoRoot: opts.repoRoot });

  if (result.status === 'error') {
    return { status: 'error', run_id: result.run_id, scanDir: result.scanDir, diagnostic: result.diagnostic };
  }

  const doneManifest: RunManifest = {
    ...result.manifest,
    status: 'done',
  };
  writeRunManifest(result.runManifestPath, doneManifest);
  await updateCurrent(result.vibecodePath, doneManifest);

  return { status: 'ok', run_id: result.run_id, runDir: result.runDir, scanDir: result.scanDir, artifacts: result.artifacts, warnings: result.warnings };
}

export async function runContextBuild(opts: {
  task: string;
  repoRoot: string;
  jsonOutput?: boolean;
}): Promise<ContextBuildResult> {
  const result = await performScanPhase({ task: opts.task, repoRoot: opts.repoRoot });

  if (result.status === 'error') {
    return {
      status: 'error',
      run_id: result.run_id,
      runDir: result.runDir,
      scanDir: result.scanDir,
      flashDir: path.join(result.runDir, 'flash'),
      diagnostic: result.diagnostic,
      error: {
        code: 'SCANNER_FAILED',
        message: result.diagnostic,
        path: result.scanDir,
        details: [],
      },
    };
  }

  const flashDir = path.join(result.runDir, 'flash');
  fs.mkdirSync(flashDir, { recursive: true });

  try {
    const flashManifest = buildFlashInputManifest({
      run_id: result.run_id,
      task: opts.task,
      repo_root: opts.repoRoot,
      runDir: result.runDir,
    });
    const previousRunSummary = formatPreviousRunSummary(
      getPreviousRunSummary({
        vibecodePath: result.vibecodePath,
        currentRunId: result.run_id,
      }),
    );
    const flashInput = buildFlashInput({
      run_id: result.run_id,
      task: opts.task,
      repo_root: opts.repoRoot,
      runDir: result.runDir,
      previousRunSummary,
      manifest: flashManifest,
    });
    const flashManifestPath = path.join(flashDir, 'flash_input_manifest.json');
    const flashInputPath = path.join(flashDir, 'flash_input.md');

    writeRunManifest(result.runManifestPath, {
      ...result.manifest,
      status: 'done',
    });
    await updateCurrent(result.vibecodePath, {
      ...result.manifest,
      status: 'done',
    });

    fs.writeFileSync(flashManifestPath, `${JSON.stringify(flashManifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(flashInputPath, flashInput, 'utf8');

    const artifactPaths = [
      path.join(result.runDir, 'user_prompt.md'),
      result.runManifestPath,
      path.join(result.runDir, 'scanner_config.json'),
      path.join(result.runDir, 'skills', 'skills_catalog.json'),
      ...Object.values(result.artifacts),
      flashManifestPath,
      flashInputPath,
    ];

    return {
      status: 'ok',
      run_id: result.run_id,
      runDir: result.runDir,
      scanDir: result.scanDir,
      flashDir,
      artifacts: [...new Set(artifactPaths)],
      warnings: [...result.warnings, ...flashManifest.warnings],
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    const flashManifestPath = path.join(flashDir, 'flash_input_manifest.json');
    const failureManifest: RunManifest = {
      ...result.manifest,
      status: 'error',
    };
    writeRunManifest(result.runManifestPath, failureManifest);
    await updateCurrent(result.vibecodePath, failureManifest);

    const typedError = error as Partial<FlashInputManifestError> & { details?: string[] };
    return {
      status: 'error',
      run_id: result.run_id,
      runDir: result.runDir,
      scanDir: result.scanDir,
      flashDir,
      diagnostic,
      error: {
        code: typedError.code ?? 'FLASH_INPUT_BUILD_FAILED',
        message: diagnostic,
        path: typedError.path ?? flashManifestPath,
        details: Array.isArray(typedError.details) ? typedError.details : [],
      },
    };
  }
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
    .option('--json', 'Output canonical JSON envelope to stdout')
    .action(async (task: string, options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const result = await runScan({ task, repoRoot, jsonOutput: options.json });

      if (options.json) {
        if (result.status === 'error') {
          console.log(JSON.stringify({
            ok: false,
            error: {
              code: 'SCANNER_FAILED',
              message: result.diagnostic ?? 'scanner failed',
            },
          }));
          process.exitCode = 1;
        } else {
          const artifactPaths = result.artifacts
            ? Object.values(result.artifacts)
            : [];
          console.log(JSON.stringify({
            ok: true,
            data: {
              run_id: result.run_id,
              scan_dir: result.scanDir,
            },
            artifacts: artifactPaths,
            warnings: result.warnings ?? [],
          }));
        }
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

  const skills = program.command('skills').description('Manage VibecodeLight skills');

  skills
    .command('list')
    .description('List skills (user-profile and project SKILLS/)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const catalog = buildSkillsCatalog({ repoRoot });
      if (options.json) {
        console.log(
          JSON.stringify({
            ok: true,
            data: { skills: catalog.skills },
            artifacts: [],
            warnings: catalog.warnings,
          }),
        );
        return;
      }
      if (catalog.skills.length === 0) {
        console.log('No skills found.');
      } else {
        for (const skill of catalog.skills) {
          console.log(`${skill.id}\t[${skill.source}/${skill.scope}]\t${skill.title}`);
        }
      }
      if (catalog.warnings.length > 0) {
        console.log('');
        console.log('Warnings:');
        for (const warning of catalog.warnings) {
          console.log(`  - ${warning}`);
        }
      }
    });

  skills
    .command('project-list')
    .description('List skills snapshotted in the project SKILLS/ directory')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const projectSkills = discoverProjectSkills(repoRoot);
      const warnings: string[] = [];
      for (const skill of projectSkills) {
        for (const w of skill.warnings) {
          warnings.push(`${skill.id}: ${w}`);
        }
      }
      if (options.json) {
        console.log(
          JSON.stringify({
            ok: true,
            data: { skills: projectSkills },
            artifacts: [],
            warnings,
          }),
        );
        return;
      }
      if (projectSkills.length === 0) {
        console.log('No project skills found.');
      } else {
        for (const skill of projectSkills) {
          console.log(`${skill.id}\t${skill.title}`);
        }
      }
    });

  skills
    .command('copy [skillId]')
    .description('Copy a user-profile skill into the project SKILLS/ directory')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--all', 'Copy all user-profile skills')
    .option('--force', 'Overwrite existing destination')
    .option('--json', 'Output canonical JSON envelope')
    .action(
      (
        skillId: string | undefined,
        options: { repo: string; all?: boolean; force?: boolean; json?: boolean },
      ) => {
        const repoRoot = path.resolve(options.repo);

        if (options.all) {
          const result = copyAllSkills({ repoRoot, force: options.force });
          if (options.json) {
            console.log(
              JSON.stringify({
                ok: true,
                data: {
                  copied: result.copied,
                  skipped: result.skipped,
                  errors: result.errors,
                },
                artifacts: result.copied.map((id) =>
                  path.join(repoRoot, 'SKILLS', id, 'SKILL.md'),
                ),
                warnings: result.skipped.map(
                  (id) => `${id}: destination exists; pass --force to overwrite`,
                ),
              }),
            );
            return;
          }
          if (result.copied.length > 0) {
            console.log(`copied: ${result.copied.join(', ')}`);
          }
          if (result.skipped.length > 0) {
            console.log(`skipped (already exists): ${result.skipped.join(', ')}`);
          }
          for (const err of result.errors) {
            console.error(`error copying ${err.skillId}: ${err.error.message}`);
          }
          return;
        }

        if (!skillId) {
          const message = 'skill id is required when --all is not specified';
          if (options.json) {
            console.log(
              JSON.stringify({
                ok: false,
                error: { code: 'MISSING_SKILL_ID', message, details: [] },
              }),
            );
          } else {
            console.error(message);
          }
          process.exitCode = 1;
          return;
        }

        const result = copySkill({
          skillId,
          repoRoot,
          force: options.force,
        });
        if (!result.ok) {
          if (options.json) {
            console.log(
              JSON.stringify({
                ok: false,
                error: {
                  code: result.error?.code ?? 'UNKNOWN',
                  message: result.error?.message ?? 'copy failed',
                  path: result.error?.path,
                  details: [],
                },
              }),
            );
          } else {
            console.error(`copy failed: ${result.error?.message ?? 'unknown error'}`);
          }
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          console.log(
            JSON.stringify({
              ok: true,
              data: { skill_id: result.skillId, destination: result.destination },
              artifacts: result.destination ? [result.destination] : [],
              warnings: [],
            }),
          );
        } else {
          console.log(`copied ${result.skillId} -> ${result.destination}`);
        }
      },
    );

  // context-build command
  program
    .command('context-build <task>')
    .description('create a run, scan the repo, and build flash input artifacts')
    .option('--repo <path>', 'repository root (default: cwd)', process.cwd())
    .option('--json', 'output canonical JSON envelope')
    .action(async (task: string, options: { repo?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo ?? process.cwd());
      const result = await runContextBuild({ task, repoRoot, jsonOutput: options.json });

      if (result.status === 'error') {
        if (options.json) {
          console.log(
            JSON.stringify({
              ok: false,
              error: {
                code: result.error?.code ?? 'UNKNOWN',
                message: result.error?.message ?? 'context-build failed',
                path: result.error?.path,
                details: result.error?.details ?? [],
              },
            }),
          );
        } else {
          console.error(`context-build failed: ${result.error?.message ?? 'unknown error'}`);
        }
        process.exitCode = 1;
        return;
      }

      const artifactPaths: string[] = result.artifacts ?? [];
      if (options.json) {
        console.log(
          JSON.stringify({
            ok: true,
            data: {
              run_id: result.run_id,
              runDir: result.runDir,
              flash_dir: result.runDir ? path.join(result.runDir, 'flash') : undefined,
            },
            artifacts: artifactPaths,
            warnings: result.warnings ?? [],
          }),
        );
      } else {
        console.log(`run_id: ${result.run_id}`);
        console.log(`runDir: ${result.runDir}`);
        if (artifactPaths.length > 0) {
          console.log('artifacts:');
          for (const p of artifactPaths) {
            console.log(`  ${p}`);
          }
        }
        if ((result.warnings ?? []).length > 0) {
          console.log('warnings:');
          for (const w of result.warnings ?? []) {
            console.log(`  ${w}`);
          }
        }
      }
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
