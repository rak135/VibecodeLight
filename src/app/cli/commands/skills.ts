import path from 'path';

import { Command } from 'commander';

import {
  buildSkillsCatalog,
  discoverProjectSkills,
} from '../../../core/skills/catalog.js';
import { copyAllSkills, copySkill } from '../../../core/skills/copy.js';

export function registerSkillsCommands(program: Command): void {
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

}
