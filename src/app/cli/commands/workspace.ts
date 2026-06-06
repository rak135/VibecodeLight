import path from 'path';

import { Command } from 'commander';

import { initWorkspace } from '../../../core/workspace/initializer.js';
import { emitCliStructuredError, makeCliStructuredError, printJson } from '../structured_output.js';

function initArtifacts(repoRoot: string, entries: readonly string[]): string[] {
  return entries.map((entry) => path.join(repoRoot, entry));
}

export function registerWorkspaceCommands(program: Command): void {
  program
    .command('init')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope to stdout')
    .description('Initialize the VibecodeLight workspace')
    .action(async (options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      try {
        const result = await initWorkspace(repoRoot);
        if (options.json) {
          printJson({
            ok: true,
            data: result,
            artifacts: initArtifacts(repoRoot, [...result.created, ...result.existing]),
            warnings: [],
          });
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitCliStructuredError(
          makeCliStructuredError('INIT_FAILED', `failed to initialize workspace: ${message}`, repoRoot, [message]),
          { json: options.json, prefix: 'init failed' },
        );
      }
    });
}
