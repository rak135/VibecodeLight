import fs from 'fs';
import { spawnSync } from 'child_process';

import { Command } from 'commander';
import YAML from 'yaml';

import { getConfigPaths } from '../../../core/config/index.js';

function pythonAvailable(): boolean {
  const result = spawnSync('python', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check local prerequisites and workspace status')
    .action(() => {
      const root = process.cwd();
      const configPath = getConfigPaths(root).localConfig;
      const configExists = fs.existsSync(configPath);
      let configStatus = 'missing';
      if (configExists) {
        try {
          YAML.parse(fs.readFileSync(configPath, 'utf8'));
          configStatus = 'ok';
        } catch {
          configStatus = 'invalid';
        }
      }
      const nodeStatus = process.versions.node;
      const pythonStatus = pythonAvailable() ? 'ok' : 'missing';
      console.log(`status: ok`);
      console.log(`node: ${nodeStatus}`);
      console.log(`.vibecode/config.yaml: ${configStatus}`);
      console.log(`python: ${pythonStatus}`);
    });
}
