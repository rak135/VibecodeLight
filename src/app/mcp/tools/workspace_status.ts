import fs from 'fs';

import {
  getCodeGraphStatus,
  getCodeGraphStatusJson,
  type CodeGraphActionRunner,
  type CodeGraphStatusJsonResult,
  type CodeGraphStatusResult,
} from '../../../adapters/codegraph/codegraph_actions.js';
import {
  resolveCodeGraphBinary,
  type CodeGraphBinaryResolution,
} from '../../../adapters/codegraph/codegraph_binary_resolver.js';
import { LlmAdapterError } from '../../../adapters/llm/errors.js';
import { resolveRunDir } from '../../../core/runs/run_resolver.js';
import { getRunInfo } from '../../../core/runs/run_display.js';
import {
  defaultGitReadOnlyRunner,
  getReadOnlyGitStatus,
  type GitReadOnlyRunner,
  type GitStatusResult,
} from '../../../core/workspace/git_status.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  WORKSPACE_STATUS_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import {
  buildAgentGuidanceRuntime,
  buildGuidanceStatusSummary,
} from '../../../core/agent_guidance/agent_guidance_runtime.js';

const TOOL_NAME = 'vibecode_workspace_status';
const ALLOWED_KEYS = new Set<string>();

export interface WorkspaceStatusToolDeps {
  /** Test seam: inject a read-only git runner. */
  gitRunner?: GitReadOnlyRunner;
  /** Test seam: inject a CodeGraph status resolver. */
  codegraphStatus?: (repoRoot: string) => Promise<CodeGraphStatusResult>;
  /** Test seam: override the upstream-call runner used by the default status path. */
  runner?: CodeGraphActionRunner;
  /** Test seam: override the binary resolution result. */
  binary?: CodeGraphBinaryResolution;
  /** Test seam: override Agent Guidance config environment. */
  env?: Record<string, string | undefined>;
  /** Test seam: inject a runner for `codegraph status --json`. */
  codegraphStatusRunner?: CodeGraphActionRunner;
}

interface CurrentRunSummary {
  run_id: string;
  run_dir: string;
  has_final_prompt: boolean;
  has_context_pack: boolean;
  has_flash_output: boolean;
  has_codegraph_usage: boolean;
}

function currentRunSummary(repoRoot: string): CurrentRunSummary | null {
  try {
    const { runId, runDir } = resolveRunDir(repoRoot, 'latest');
    if (!fs.existsSync(runDir)) return null;
    const info = getRunInfo(runDir);
    return {
      run_id: runId,
      run_dir: runDir,
      has_final_prompt: Boolean(info.artifacts.final_prompt),
      has_context_pack: Boolean(info.artifacts.context_pack),
      has_flash_output: Boolean(info.artifacts.flash_output),
      has_codegraph_usage: Boolean(info.artifacts.codegraph_usage),
    };
  } catch (err) {
    if (err instanceof LlmAdapterError) return null;
    return null;
  }
}

function renderText(data: {
  repo_root: string;
  git: GitStatusResult;
  current_run: CurrentRunSummary | null;
  codegraph: { available: boolean; initialized: boolean };
  guidance_status?: { enabled: boolean; source: string; guidance_hash: string };
}): string {
  const lines: string[] = ['# Vibecode workspace status', ''];
  lines.push(`repo_root: ${data.repo_root}`);
  if (data.git.ok) {
    lines.push(`git_branch: ${data.git.branch}`);
    lines.push(`git_head: ${data.git.head}`);
    lines.push(`git_dirty: ${data.git.dirty ? 'yes' : 'no'}`);
    lines.push(
      `changed: modified=${data.git.changed.modified} staged=${data.git.changed.staged} untracked=${data.git.changed.untracked}`,
    );
    if (data.git.changed.first_paths.length > 0) {
      lines.push('first_paths:');
      for (const p of data.git.changed.first_paths) lines.push(`  - ${p}`);
    }
  } else {
    lines.push('git: (not available — see warnings)');
  }
  lines.push('');
  if (data.current_run) {
    lines.push(`current_run: ${data.current_run.run_id}`);
    lines.push(
      `  artifacts: final_prompt=${data.current_run.has_final_prompt ? 'yes' : 'no'} context_pack=${
        data.current_run.has_context_pack ? 'yes' : 'no'
      } flash_output=${data.current_run.has_flash_output ? 'yes' : 'no'} codegraph_usage=${
        data.current_run.has_codegraph_usage ? 'yes' : 'no'
      }`,
    );
  } else {
    lines.push('current_run: (none)');
  }
  lines.push('');
  lines.push(
    `codegraph: available=${data.codegraph.available ? 'yes' : 'no'} initialized=${
      data.codegraph.initialized ? 'yes' : 'no'
    }`,
  );
  if (data.guidance_status) {
    lines.push(
      `guidance: enabled=${data.guidance_status.enabled ? 'yes' : 'no'} source=${data.guidance_status.source} hash=${data.guidance_status.guidance_hash}`,
    );
  }
  return lines.join('\n');
}

export function buildWorkspaceStatusTool(deps: WorkspaceStatusToolDeps = {}): McpToolDefinition {
  const inputSchema: JsonSchema = WORKSPACE_STATUS_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode workspace status',
    description:
      'Current read-only workspace status: git branch/head/dirty, changed-file counts, current run/artifact availability, CodeGraph status. Call this together with workspace_info when entering a repo. Read-only — never mutates git.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', unknown.message),
        });
      }

      const warnings: string[] = [];

      // Git is read-only; non-git repos surface as warnings, never as errors.
      const runner = deps.gitRunner ?? defaultGitReadOnlyRunner;
      const git = getReadOnlyGitStatus(input.context.repoRoot, runner);
      if (!git.ok) {
        for (const w of git.warnings) warnings.push(w);
      }

      // CodeGraph status is non-fatal; failures become warnings.
      let status: CodeGraphStatusResult;
      try {
        if (deps.codegraphStatus) {
          status = await deps.codegraphStatus(input.context.repoRoot);
        } else {
          const binary =
            deps.binary ??
            resolveCodeGraphBinary({ cliOption: input.context.codegraphBinary ?? null, env: process.env });
          status = await getCodeGraphStatus(input.context.repoRoot, {
            command: binary.command,
            binary,
            ...(deps.runner ? { runner: deps.runner } : {}),
          });
        }
      } catch (err) {
        status = {
          ok: false,
          available: false,
          initialized: false,
          warnings: [err instanceof Error ? err.message : String(err)],
        };
      }
      if (!status.available) {
        warnings.push('CODEGRAPH_UNAVAILABLE: upstream CodeGraph binary is not detected.');
      } else if (!status.initialized) {
        warnings.push('CODEGRAPH_NOT_INITIALIZED: run `vibecode codegraph init --repo <path>` once.');
      }
      for (const w of status.warnings) warnings.push(w);

      // Run `codegraph status --json` for freshness data when available+initialized.
      let codegraphStatusJson: CodeGraphStatusJsonResult | null = null;
      if (status.available && status.initialized) {
        const binary =
          deps.binary ??
          resolveCodeGraphBinary({ cliOption: input.context.codegraphBinary ?? null, env: process.env });
        const statusJsonResult = await getCodeGraphStatusJson(input.context.repoRoot, {
          command: binary.command,
          binary,
          ...(deps.codegraphStatusRunner ? { runner: deps.codegraphStatusRunner } : {}),
        });
        codegraphStatusJson = statusJsonResult.data;
        for (const w of statusJsonResult.warnings) warnings.push(w);
      }

      const currentRun = currentRunSummary(input.context.repoRoot);
      if (!currentRun) warnings.push('NO_CURRENT_RUN: no .vibecode/current pointer — call vibecode prompt or vibecode context-build first.');
      const runtime = input.context.agentGuidance ?? buildAgentGuidanceRuntime({ env: deps.env });
      const guidanceStatus = buildGuidanceStatusSummary(runtime);

      const data = {
        repo_root: input.context.repoRoot,
        git: git.ok
          ? {
              branch: git.branch,
              head: git.head,
              dirty: git.dirty,
              changed: git.changed,
            }
          : null,
        current_run: currentRun,
        codegraph: {
          available: status.available,
          initialized: status.initialized,
          version: status.version ?? null,
          status_json: codegraphStatusJson,
        },
        guidance_status: guidanceStatus,
      };

      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: renderText({
          repo_root: input.context.repoRoot,
          git,
          current_run: currentRun,
          codegraph: data.codegraph,
          guidance_status: guidanceStatus,
        }),
        data,
        warnings,
        durationMs: Date.now() - started,
      });
    },
  };
}
