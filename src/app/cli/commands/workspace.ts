import path from 'path';

import { Command } from 'commander';

import { initWorkspace } from '../../../core/workspace/initializer.js';

export function registerWorkspaceCommands(program: Command): void {
  program
    .command('init')
    .option('--repo <path>', 'Repository path', process.cwd())
    .description('Initialize the VibecodeLight workspace')
    .action(async (options: { repo: string }) => {
      const result = await initWorkspace(path.resolve(options.repo));
      console.log(JSON.stringify(result, null, 2));
    });
}
