import fs from 'fs';
import path from 'path';

import { Command } from 'commander';

import {
  emitCliStructuredError,
  makeCliStructuredError,
  type CliStructuredError,
} from '../structured_output.js';
import {
  buildSkillsCatalog,
  discoverProjectSkills,
} from '../../../core/skills/catalog.js';
import { copyAllSkills, copySkill } from '../../../core/skills/copy.js';
import {
  isSafeSkillId,
  readSelectedSkillsManifest,
  resolveSkillSourcePath,
} from '../../../core/skills/selected_manifest.js';
import { appendSkillUsage, type SkillUsageCommand } from '../../../core/skills/skill_usage_log.js';
import { getWorkspacePaths } from '../../../core/workspace/paths.js';

function logSkillUsage(
  repoRoot: string,
  runId: string,
  command: SkillUsageCommand,
  ok: boolean,
  extra: { skillId?: string; sourcePath?: string; errorCode?: string } = {},
): void {
  try {
    const paths = getWorkspacePaths(repoRoot);
    const runDir = path.join(paths.runs, runId);
    appendSkillUsage({
      runDir,
      vibecodeRoot: paths.vibecode,
      event: {
        timestamp: new Date().toISOString(),
        run_id: runId,
        command,
        ok,
        source: 'repo_skills_dir',
        ...(extra.skillId ? { skill_id: extra.skillId } : {}),
        ...(extra.sourcePath ? { source_path: extra.sourcePath } : {}),
        ...(extra.errorCode ? { error: extra.errorCode } : {}),
      },
    });
  } catch {
    // logging must not break the CLI command
  }
}

function emitSkillsError(prefix: string, error: CliStructuredError, json?: boolean): void {
  emitCliStructuredError(error, { json, prefix });
}

export function registerSkillsCommands(program: Command): void {
  const skills = program.command('skills').description('Manage VibecodeLight skills');

  skills
    .command('show <skillId>')
    .description("Print the current content of a selected repo-local skill")
    .option('--run-id <runId>', 'Run id whose selected skills are queried')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((skillId: string, options: { runId?: string; repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const runId = (options.runId ?? '').trim();
      if (!runId) {
        const err = makeCliStructuredError(
          'RUN_ID_REQUIRED',
          '--run-id is required',
          '',
          ['Pass --run-id <runId> identifying which run\'s selected skills to query.'],
        );
        emitSkillsError('skills show failed', err, options.json);
        return;
      }
      if (!isSafeSkillId(skillId)) {
        const err = makeCliStructuredError(
          'UNSAFE_SKILL_ID',
          `unsafe skill id: ${skillId}`,
          '',
          ['Skill ids must match /^[a-zA-Z0-9._-]+$/.'],
        );
        logSkillUsage(repoRoot, runId, 'show', false, { skillId, errorCode: err.code });
        emitSkillsError('skills show failed', err, options.json);
        return;
      }
      const paths = getWorkspacePaths(repoRoot);
      const runDir = path.join(paths.runs, runId);
      const manifest = readSelectedSkillsManifest(runDir);
      if (!manifest) {
        const err = makeCliStructuredError(
          'RUN_NOT_FOUND',
          `no selected-skills manifest for run ${runId}`,
          path.join(runDir, 'skills', 'manifest.json'),
        );
        logSkillUsage(repoRoot, runId, 'show', false, { skillId, errorCode: err.code });
        emitSkillsError('skills show failed', err, options.json);
        return;
      }
      const entry = manifest.selected_skills.find((s) => s.id === skillId);
      if (!entry) {
        const err = makeCliStructuredError(
          'SKILL_NOT_SELECTED',
          `skill "${skillId}" was not selected for run ${runId}`,
        );
        logSkillUsage(repoRoot, runId, 'show', false, { skillId, errorCode: err.code });
        emitSkillsError('skills show failed', err, options.json);
        return;
      }
      const resolved = resolveSkillSourcePath(repoRoot, skillId);
      if (!resolved || !fs.existsSync(resolved.filePath)) {
        const err = makeCliStructuredError(
          'SKILL_FILE_NOT_FOUND',
          `skill file not found for "${skillId}"`,
          resolved?.filePath ?? path.join(repoRoot, 'SKILLS', `${skillId}.md`),
        );
        logSkillUsage(repoRoot, runId, 'show', false, { skillId, errorCode: err.code });
        emitSkillsError('skills show failed', err, options.json);
        return;
      }
      const content = fs.readFileSync(resolved.filePath, 'utf8');
      logSkillUsage(repoRoot, runId, 'show', true, {
        skillId,
        sourcePath: resolved.relativePath,
      });
      if (options.json) {
        console.log(
          JSON.stringify({
            ok: true,
            data: {
              run_id: runId,
              skill_id: skillId,
              source_path: resolved.relativePath,
              content,
            },
            artifacts: [resolved.filePath],
            warnings: [],
          }),
        );
      } else {
        process.stdout.write(content);
        if (!content.endsWith('\n')) process.stdout.write('\n');
      }
    });

  skills
    .command('path <skillId>')
    .description('Print the resolved path of a selected repo-local skill')
    .option('--run-id <runId>', 'Run id whose selected skills are queried')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((skillId: string, options: { runId?: string; repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const runId = (options.runId ?? '').trim();
      if (!runId) {
        const err = makeCliStructuredError(
          'RUN_ID_REQUIRED',
          '--run-id is required',
          '',
          ['Pass --run-id <runId> identifying which run\'s selected skills to query.'],
        );
        emitSkillsError('skills path failed', err, options.json);
        return;
      }
      if (!isSafeSkillId(skillId)) {
        const err = makeCliStructuredError(
          'UNSAFE_SKILL_ID',
          `unsafe skill id: ${skillId}`,
          '',
          ['Skill ids must match /^[a-zA-Z0-9._-]+$/.'],
        );
        logSkillUsage(repoRoot, runId, 'path', false, { skillId, errorCode: err.code });
        emitSkillsError('skills path failed', err, options.json);
        return;
      }
      const paths = getWorkspacePaths(repoRoot);
      const runDir = path.join(paths.runs, runId);
      const manifest = readSelectedSkillsManifest(runDir);
      if (!manifest) {
        const err = makeCliStructuredError(
          'RUN_NOT_FOUND',
          `no selected-skills manifest for run ${runId}`,
          path.join(runDir, 'skills', 'manifest.json'),
        );
        logSkillUsage(repoRoot, runId, 'path', false, { skillId, errorCode: err.code });
        emitSkillsError('skills path failed', err, options.json);
        return;
      }
      const entry = manifest.selected_skills.find((s) => s.id === skillId);
      if (!entry) {
        const err = makeCliStructuredError(
          'SKILL_NOT_SELECTED',
          `skill "${skillId}" was not selected for run ${runId}`,
        );
        logSkillUsage(repoRoot, runId, 'path', false, { skillId, errorCode: err.code });
        emitSkillsError('skills path failed', err, options.json);
        return;
      }
      const resolved = resolveSkillSourcePath(repoRoot, skillId);
      if (!resolved || !fs.existsSync(resolved.filePath)) {
        const err = makeCliStructuredError(
          'SKILL_FILE_NOT_FOUND',
          `skill file not found for "${skillId}"`,
          resolved?.filePath ?? path.join(repoRoot, 'SKILLS', `${skillId}.md`),
        );
        logSkillUsage(repoRoot, runId, 'path', false, { skillId, errorCode: err.code });
        emitSkillsError('skills path failed', err, options.json);
        return;
      }
      logSkillUsage(repoRoot, runId, 'path', true, {
        skillId,
        sourcePath: resolved.relativePath,
      });
      if (options.json) {
        console.log(
          JSON.stringify({
            ok: true,
            data: {
              run_id: runId,
              skill_id: skillId,
              source_path: resolved.relativePath,
              absolute_path: resolved.filePath,
            },
            artifacts: [resolved.filePath],
            warnings: [],
          }),
        );
      } else {
        console.log(resolved.filePath);
      }
    });

  skills
    .command('list')
    .description('List skills (user-profile and project SKILLS/). With --run-id, list only skills selected for that run.')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--run-id <runId>', 'Limit output to skills selected for this run')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; runId?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);

      if (options.runId) {
        const runId = options.runId.trim();
        const paths = getWorkspacePaths(repoRoot);
        const runDir = path.join(paths.runs, runId);
        const manifest = readSelectedSkillsManifest(runDir);
        if (!manifest) {
          const err = makeCliStructuredError(
            'RUN_NOT_FOUND',
            `no selected-skills manifest for run ${runId}`,
            path.join(runDir, 'skills', 'manifest.json'),
          );
          logSkillUsage(repoRoot, runId, 'list', false, { errorCode: err.code });
          emitSkillsError('skills list failed', err, options.json);
          return;
        }
        logSkillUsage(repoRoot, runId, 'list', true);
        if (options.json) {
          console.log(
            JSON.stringify({
              ok: true,
              data: {
                run_id: manifest.run_id,
                skills_dir: manifest.skills_dir,
                selected_skills: manifest.selected_skills,
              },
              artifacts: [],
              warnings: [],
            }),
          );
          return;
        }
        if (manifest.selected_skills.length === 0) {
          console.log('No skills selected for this run.');
        } else {
          for (const skill of manifest.selected_skills) {
            console.log(`${skill.id}\t${skill.title}`);
          }
        }
        return;
      }

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
          const err = makeCliStructuredError('MISSING_SKILL_ID', message);
          emitSkillsError('skills copy failed', err, options.json);
          return;
        }

        const result = copySkill({
          skillId,
          repoRoot,
          force: options.force,
        });
        if (!result.ok) {
          const err = makeCliStructuredError(
            result.error?.code ?? 'UNKNOWN',
            result.error?.message ?? 'copy failed',
            result.error?.path,
          );
          emitSkillsError('skills copy failed', err, options.json);
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

}
