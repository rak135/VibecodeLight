import fs from 'fs';
import path from 'path';

import type { ToolCallRecord } from './base.js';
import { ToolAccessError } from './errors.js';

export interface FlashToolRunnerOptions {
  workspaceRoot: string;
  runId: string;
}

export interface SearchTextResult {
  path: string;
  line: number;
  lineText: string;
}

const SKIP_DIRS = new Set(['.git', '.vibecode', 'node_modules', 'dist', 'build', 'coverage', '.venv', '__pycache__']);
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function summarize(value: string | string[] | SearchTextResult[]): string {
  if (typeof value === 'string') {
    return `${value.length} characters`;
  }
  return `${value.length} entr${value.length === 1 ? 'y' : 'ies'}`;
}

export class FlashToolRunner {
  private readonly workspaceRoot: string;
  private readonly runDir: string;
  private readonly toolCalls: ToolCallRecord[] = [];

  constructor(opts: FlashToolRunnerOptions) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.runDir = path.join(this.workspaceRoot, '.vibecode', 'runs', opts.runId);
  }

  getToolCalls(): ToolCallRecord[] {
    return this.toolCalls.map((call) => ({ ...call, args: { ...call.args } }));
  }

  readFile(filePath: string): string {
    return this.runTool('read_file', { path: filePath }, () => {
      const resolved = this.resolveInsideWorkspace(filePath);
      const content = fs.readFileSync(resolved, 'utf8');
      return { result: content, pathAccessed: resolved };
    });
  }

  read_file(filePath: string): string {
    return this.readFile(filePath);
  }

  listDir(dirPath: string): string[] {
    return this.runTool('list_dir', { path: dirPath }, () => {
      const resolved = this.resolveInsideWorkspace(dirPath);
      const entries = fs.readdirSync(resolved).sort((a, b) => a.localeCompare(b));
      return { result: entries, pathAccessed: resolved };
    });
  }

  list_dir(dirPath: string): string[] {
    return this.listDir(dirPath);
  }

  readArtifact(name: string): string {
    return this.runTool('read_artifact', { name }, () => {
      const resolved = this.resolveInsideRunDir(name);
      const content = fs.readFileSync(resolved, 'utf8');
      return { result: content, pathAccessed: resolved };
    });
  }

  read_artifact(name: string): string {
    return this.readArtifact(name);
  }

  searchText(query: string): SearchTextResult[] {
    return this.runTool('search_text', { query }, () => {
      if (!query) {
        throw new ToolAccessError('search_text query is required');
      }
      const results: SearchTextResult[] = [];
      this.walkWorkspace(this.workspaceRoot, (filePath) => {
        if (results.length >= MAX_SEARCH_RESULTS) {
          return;
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          return;
        }
        if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) {
          return;
        }
        let content: string;
        try {
          content = fs.readFileSync(filePath, 'utf8');
        } catch {
          return;
        }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].includes(query)) {
            results.push({
              path: path.relative(this.workspaceRoot, filePath),
              line: index + 1,
              lineText: lines[index],
            });
            if (results.length >= MAX_SEARCH_RESULTS) {
              break;
            }
          }
        }
      });
      return { result: results, pathAccessed: this.workspaceRoot };
    });
  }

  search_text(query: string): SearchTextResult[] {
    return this.searchText(query);
  }

  private resolveInsideWorkspace(inputPath: string): string {
    const resolved = path.resolve(this.workspaceRoot, inputPath);
    if (!isInside(this.workspaceRoot, resolved)) {
      throw new ToolAccessError(`tool access refused outside workspace: ${inputPath}`, {
        path: resolved,
        details: [`workspaceRoot: ${this.workspaceRoot}`],
      });
    }
    return resolved;
  }

  private resolveInsideRunDir(name: string): string {
    const resolved = path.resolve(this.runDir, name);
    if (!isInside(this.runDir, resolved) || !isInside(this.workspaceRoot, resolved)) {
      throw new ToolAccessError(`artifact access refused outside run directory: ${name}`, {
        path: resolved,
        details: [`runDir: ${this.runDir}`],
      });
    }
    return resolved;
  }

  private runTool<T>(
    tool: string,
    args: Record<string, unknown>,
    fn: () => { result: T; pathAccessed?: string },
  ): T {
    try {
      const { result, pathAccessed } = fn();
      this.log({
        tool,
        args,
        status: 'ok',
        resultSummary: summarize(result as string | string[] | SearchTextResult[]),
        timestamp: new Date().toISOString(),
        pathAccessed,
      });
      return result;
    } catch (error) {
      const status = error instanceof ToolAccessError ? 'refused' : 'error';
      const message = error instanceof Error ? error.message : String(error);
      this.log({
        tool,
        args,
        status,
        resultSummary: message,
        timestamp: new Date().toISOString(),
        pathAccessed: error instanceof ToolAccessError ? error.path : undefined,
      });
      throw error;
    }
  }

  private log(record: ToolCallRecord): void {
    this.toolCalls.push(record);
  }

  // eslint-disable-next-line no-unused-vars
  private walkWorkspace(dir: string, onFile: (_filePath: string) => void): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (!isInside(this.workspaceRoot, fullPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          this.walkWorkspace(fullPath, onFile);
        }
      } else if (entry.isFile()) {
        onFile(fullPath);
      }
    }
  }
}
