import {
  buildCodeGraphContext,
  writeCodeGraphContextArtifacts,
  type CodeGraphArtifactWriteResult,
  type CodeGraphContextMode,
  type CodeGraphContextResult,
  type CodeGraphContextRunner,
  type CodeGraphReadinessProvider,
} from '../../adapters/codegraph/codegraph_context.js';
import type { CodeGraphMcpContextRunner } from '../../adapters/codegraph/codegraph_mcp.js';
import type { CodeGraphTransport } from '../../adapters/codegraph/codegraph_transport.js';
import type { TaskIntent } from '../../adapters/task_normalizer/index.js';
import { buildCodeGraphTask } from '../prompting/codegraph_task.js';
import { augmentExternalToolsWithCodeGraphContext } from '../scanning/external_tools.js';

export interface BuildAndWriteCodeGraphRunContextInput {
  repoRoot: string;
  task: string;
  taskIntent: TaskIntent;
  runDir: string;
  scanDir: string;
  mode: CodeGraphContextMode;
  transport: CodeGraphTransport;
  runner?: CodeGraphContextRunner;
  readinessProvider?: CodeGraphReadinessProvider;
  command?: string;
  mcpRunner?: CodeGraphMcpContextRunner;
  onBuildError?: (error: unknown) => CodeGraphContextResult;
}

export interface BuildAndWriteCodeGraphRunContextResult extends CodeGraphArtifactWriteResult {
  codegraphResult: CodeGraphContextResult;
  codegraphArtifacts: CodeGraphArtifactWriteResult;
  canonicalArtifacts: string[];
  legacyArtifacts: string[];
}

export async function buildAndWriteCodeGraphRunContext(
  input: BuildAndWriteCodeGraphRunContextInput,
): Promise<BuildAndWriteCodeGraphRunContextResult> {
  const codegraphTask = buildCodeGraphTask(input.task, input.taskIntent);
  let codegraphResult: CodeGraphContextResult;
  try {
    codegraphResult = await buildCodeGraphContext({
      repoRoot: input.repoRoot,
      task: codegraphTask,
      mode: input.mode,
      transport: input.transport,
      ...(input.runner ? { runner: input.runner } : {}),
      ...(input.readinessProvider ? { readinessProvider: input.readinessProvider } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.mcpRunner ? { mcpRunner: input.mcpRunner } : {}),
    });
  } catch (error) {
    if (!input.onBuildError) throw error;
    codegraphResult = input.onBuildError(error);
  }

  const codegraphArtifacts = writeCodeGraphContextArtifacts({
    runDir: input.runDir,
    result: codegraphResult,
  });
  augmentExternalToolsWithCodeGraphContext(input.scanDir, codegraphResult);

  const canonicalArtifacts = [
    codegraphArtifacts.usageArtifact,
    ...(codegraphArtifacts.contextArtifact ? [codegraphArtifacts.contextArtifact] : []),
    ...(codegraphArtifacts.repoAtlasArtifact ? [codegraphArtifacts.repoAtlasArtifact] : []),
    ...(codegraphArtifacts.repoAtlasJsonArtifact ? [codegraphArtifacts.repoAtlasJsonArtifact] : []),
  ];
  const legacyArtifacts = [
    ...(codegraphArtifacts.legacyRepoAtlasArtifact ? [codegraphArtifacts.legacyRepoAtlasArtifact] : []),
    ...(codegraphArtifacts.legacyRepoAtlasJsonArtifact ? [codegraphArtifacts.legacyRepoAtlasJsonArtifact] : []),
  ];

  return {
    codegraphResult,
    codegraphArtifacts,
    canonicalArtifacts,
    legacyArtifacts,
    ...codegraphArtifacts,
  };
}
