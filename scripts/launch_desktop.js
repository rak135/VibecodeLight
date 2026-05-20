const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const rendererSource = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer');
const rendererOutput = path.join(repoRoot, 'dist-desktop', 'app', 'desktop', 'renderer');

execSync('npx tsc --project tsconfig.desktop.json', { stdio: 'inherit' });
fs.rmSync(rendererOutput, { recursive: true, force: true });
fs.cpSync(rendererSource, rendererOutput, { recursive: true });
execSync('electron dist-desktop/app/desktop/main.js', {
  stdio: 'inherit',
  env: { ...process.env, VIBECODE_REPO: process.env.VIBECODE_REPO || repoRoot },
});
