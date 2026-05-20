const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const rendererSource = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer');
const rendererOutput = path.join(repoRoot, 'dist-desktop', 'app', 'desktop', 'renderer');
const xtermSource = path.join(repoRoot, 'node_modules', '@xterm', 'xterm');
const xtermVendorOutput = path.join(rendererOutput, 'vendor', 'xterm');

execSync('npx tsc --project tsconfig.desktop.json', { stdio: 'inherit' });
fs.rmSync(rendererOutput, { recursive: true, force: true });
fs.cpSync(rendererSource, rendererOutput, { recursive: true });

const xtermJs = path.join(xtermSource, 'lib', 'xterm.js');
const xtermCss = path.join(xtermSource, 'css', 'xterm.css');
if (!fs.existsSync(xtermJs) || !fs.existsSync(xtermCss)) {
  throw new Error(
    `xterm vendor assets missing under ${xtermSource}; run "pnpm install" to restore @xterm/xterm`,
  );
}
fs.mkdirSync(xtermVendorOutput, { recursive: true });
fs.copyFileSync(xtermJs, path.join(xtermVendorOutput, 'xterm.js'));
fs.copyFileSync(xtermCss, path.join(xtermVendorOutput, 'xterm.css'));

execSync('electron dist-desktop/app/desktop/main.js', {
  stdio: 'inherit',
  env: { ...process.env, VIBECODE_REPO: process.env.VIBECODE_REPO || repoRoot },
});
