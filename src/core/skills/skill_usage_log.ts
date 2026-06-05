import fs from 'fs';
import path from 'path';

export type SkillUsageCommand = 'list' | 'show' | 'path';

export interface SkillUsageEvent {
  timestamp: string;
  run_id: string;
  command: SkillUsageCommand;
  ok: boolean;
  source: 'repo_skills_dir';
  skill_id?: string;
  source_path?: string;
  error?: string;
}

export interface AppendSkillUsageOptions {
  runDir: string;
  vibecodeRoot?: string;
  event: SkillUsageEvent;
}

function appendJsonl(filePath: string, line: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${line}\n`, 'utf8');
}

export function appendSkillUsage(opts: AppendSkillUsageOptions): string[] {
  const line = JSON.stringify(opts.event);
  const written: string[] = [];

  const runLog = path.join(opts.runDir, 'terminal', 'skill_usage.jsonl');
  try {
    appendJsonl(runLog, line);
    written.push(runLog);
  } catch {
    // best-effort: telemetry must not crash CLI commands
  }

  if (opts.vibecodeRoot) {
    const globalLog = path.join(opts.vibecodeRoot, 'logs', 'skill_usage.jsonl');
    try {
      appendJsonl(globalLog, line);
      written.push(globalLog);
    } catch {
      // best-effort
    }
  }

  return written;
}
