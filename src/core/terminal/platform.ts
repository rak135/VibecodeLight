export interface PlatformEchoMarker {
  command: string;
  marker: string;
  newline: string;
}

export function buildMarkerCommand(marker: string, platform: typeof process.platform = process.platform): string {
  if (platform === 'win32') {
    return `Write-Output "${marker.replace(/"/g, '``"')}"`;
  }
  return `printf "${marker.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}\\n"`;
}

export function buildGitStatusCommand(marker: string, platform: typeof process.platform = process.platform): string {
  return `git status --short; ${buildMarkerCommand(marker, platform)}`;
}

export function platformEchoMarker(platform: typeof process.platform = process.platform): PlatformEchoMarker {
  const marker = `VIBECODE_PTY_OK_${Date.now()}`;
  if (platform === 'win32') {
    return { command: `Write-Output "${marker}"`, marker, newline: '\r' };
  }
  return { command: `printf "${marker}\\n"`, marker, newline: '\n' };
}
