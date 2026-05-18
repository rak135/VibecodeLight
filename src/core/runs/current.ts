import fs from 'fs';
import path from 'path';

import { RunManifest } from '../models/index.js';

export async function updateCurrent(vibecodePath: string, runManifest: RunManifest): Promise<void> {
  const currentDir = path.join(vibecodePath, 'current');
  fs.mkdirSync(currentDir, { recursive: true });
  fs.writeFileSync(
    path.join(currentDir, 'run_manifest.json'),
    `${JSON.stringify(runManifest, null, 2)}\n`,
    'utf8',
  );
}
