import fs from 'fs';
import path from 'path';

import {
  CODEGRAPH_COMMAND,
  CODEGRAPH_DIR_NAME,
  defaultVersionProbe,
  type CodeGraphVersionProbe,
  type CodeGraphVersionProbeResult,
} from './codegraph_cli.js';

/**
 * Command form used to start the upstream CodeGraph MCP server.
 * VibecodeLight Phase 1A integrates with the existing CodeGraph MCP server.
 * It never implements its own CodeGraph MCP server.
 */
export const CODEGRAPH_MCP_SERVER_ARGS = ['serve', '--mcp'] as const;

/** Default self-test timeout (ms) for the upstream MCP handshake + tools/list. */
export const CODEGRAPH_MCP_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Tools the upstream CodeGraph MCP server is expected to expose. The self-test
 * fails when any of these are missing; additional tools are accepted.
 */
export const REQUIRED_CODEGRAPH_MCP_TOOLS = [
  'codegraph_status',
  'codegraph_context',
  'codegraph_search',
  'codegraph_files',
] as const;

/**
 * Optional tools that the upstream server is known to expose. They are
 * neither required nor rejected; they are surfaced verbatim in the self-test
 * result so callers can see what is available.
 */
export const OPTIONAL_CODEGRAPH_MCP_TOOLS = [
  'codegraph_trace',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_impact',
  'codegraph_node',
  'codegraph_explore',
] as const;

// ---------------------------------------------------------------------------
// Detection (does not start the MCP server)
// ---------------------------------------------------------------------------

export interface CodeGraphMcpCapability {
  /** Whether the `codegraph` command is callable. */
  binaryAvailable: boolean;
  /** Reported version when the version probe succeeded. */
  binaryVersion?: string;
  /** Repository root used for the capability check. */
  repoRoot: string;
  /** Whether the resolved repo path exists on disk. */
  repoRootExists: boolean;
  /** Whether the resolved repo path is a directory. */
  repoRootIsDirectory: boolean;
  /** Whether `<repoRoot>/.codegraph/` is present. */
  codegraphDirPresent: boolean;
  /** Command form the upstream MCP server is started with. */
  serverCommand: string;
  serverArgs: string[];
  /** Non-fatal warnings collected during detection. */
  warnings: string[];
}

export interface DetectCodeGraphMcpCapabilityOptions {
  /** Override the codegraph command name. Defaults to `codegraph`. */
  command?: string;
  /** Override the read-only version probe (used by tests). */
  versionProbe?: CodeGraphVersionProbe;
}

/**
 * Detect whether the upstream CodeGraph MCP server is likely usable. This is a
 * read-only check: it never starts a long-running MCP server and never mutates
 * the repository. Use {@link runCodeGraphMcpSelfTest} for the live handshake.
 */
export function detectCodeGraphMcpCapability(
  repoRoot: string,
  options: DetectCodeGraphMcpCapabilityOptions = {},
): CodeGraphMcpCapability {
  const command = options.command ?? CODEGRAPH_COMMAND;
  const probe = options.versionProbe ?? defaultVersionProbe;
  const warnings: string[] = [];

  let repoRootExists = false;
  let repoRootIsDirectory = false;
  try {
    if (fs.existsSync(repoRoot)) {
      repoRootExists = true;
      repoRootIsDirectory = fs.statSync(repoRoot).isDirectory();
    }
  } catch (error) {
    warnings.push(`CODEGRAPH_REPO_STAT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!repoRootExists) {
    warnings.push(`CODEGRAPH_REPO_NOT_FOUND: repo path does not exist: ${repoRoot}`);
  } else if (!repoRootIsDirectory) {
    warnings.push(`CODEGRAPH_REPO_NOT_DIRECTORY: repo path is not a directory: ${repoRoot}`);
  }

  let codegraphDirPresent = false;
  if (repoRootIsDirectory) {
    try {
      const dir = path.join(repoRoot, CODEGRAPH_DIR_NAME);
      codegraphDirPresent = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch (error) {
      warnings.push(`CODEGRAPH_DIR_CHECK_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let binaryAvailable = false;
  let binaryVersion: string | undefined;
  let probeResult: CodeGraphVersionProbeResult;
  try {
    probeResult = probe(command);
  } catch (error) {
    probeResult = { found: false, warning: error instanceof Error ? error.message : String(error) };
  }
  if (probeResult.found) {
    binaryAvailable = true;
    binaryVersion = probeResult.version;
    if (!binaryVersion && probeResult.warning) {
      warnings.push(`CODEGRAPH_VERSION_UNAVAILABLE: ${probeResult.warning}`);
    }
  } else {
    const detail = probeResult.warning ? `: ${probeResult.warning}` : '';
    warnings.push(`CODEGRAPH_NOT_FOUND: codegraph command was not found or not callable${detail}`);
  }

  return {
    binaryAvailable,
    binaryVersion,
    repoRoot,
    repoRootExists,
    repoRootIsDirectory,
    codegraphDirPresent,
    serverCommand: command,
    serverArgs: [...CODEGRAPH_MCP_SERVER_ARGS],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Self-test (starts the upstream MCP server and queries tools/list)
// ---------------------------------------------------------------------------

export interface CodeGraphMcpSelfTestRunnerInput {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}

export type CodeGraphMcpSelfTestRunnerOutcome =
  | { ok: true; tools: string[]; warnings?: string[] }
  | { ok: false; code: string; message: string; warnings?: string[] };

/**
 * Pluggable MCP self-test runner. The default runner uses the official
 * `@modelcontextprotocol/sdk` stdio client transport. Tests inject a fake so
 * they never spawn a real codegraph process.
 */
export type CodeGraphMcpSelfTestRunner = (
  input: CodeGraphMcpSelfTestRunnerInput,
) => Promise<CodeGraphMcpSelfTestRunnerOutcome>;

export interface CodeGraphMcpSelfTestOptions {
  /** Repository root used as cwd for the spawned server. */
  repoRoot: string;
  /** Override the codegraph command name. */
  command?: string;
  /** Override the server args (defaults to ['serve', '--mcp']). */
  args?: readonly string[];
  /** Test seam: inject a fake MCP runner. */
  runner?: CodeGraphMcpSelfTestRunner;
  /** Skip detection and run regardless of binary availability. */
  skipCapabilityCheck?: boolean;
  /** Inject capability detection (tests only). */
  detectCapability?: (
    repoRoot: string,
    options?: DetectCodeGraphMcpCapabilityOptions,
  ) => CodeGraphMcpCapability;
  /** Override the read-only version probe (used by detection in tests). */
  versionProbe?: CodeGraphVersionProbe;
  /** Self-test timeout in milliseconds. */
  timeoutMs?: number;
}

export interface CodeGraphMcpSelfTestResult {
  ok: boolean;
  transport: 'stdio';
  serverCommand: string;
  serverArgs: string[];
  repoRoot: string;
  tools: string[];
  expectedToolsPresent: boolean;
  missingTools: string[];
  warnings: string[];
  error?: { code: string; message: string };
}

/**
 * Run the CodeGraph MCP self-test:
 *
 * 1. Detect that the codegraph binary and repo root look usable.
 * 2. Spawn the upstream MCP server: `codegraph serve --mcp`.
 * 3. Perform the MCP initialize handshake.
 * 4. Call `tools/list` and verify the expected tools are present.
 * 5. Shut down the child cleanly.
 *
 * The self-test never calls `codegraph init/sync/index/watch`, never mutates
 * the repository, and never calls a live LLM.
 */
export async function runCodeGraphMcpSelfTest(
  options: CodeGraphMcpSelfTestOptions,
): Promise<CodeGraphMcpSelfTestResult> {
  const command = options.command ?? CODEGRAPH_COMMAND;
  const args = (options.args ?? CODEGRAPH_MCP_SERVER_ARGS).slice();
  const timeoutMs = options.timeoutMs ?? CODEGRAPH_MCP_DEFAULT_TIMEOUT_MS;
  const repoRoot = options.repoRoot;
  const warnings: string[] = [];

  const detectFn = options.detectCapability ?? detectCodeGraphMcpCapability;
  const capability = options.skipCapabilityCheck
    ? undefined
    : detectFn(repoRoot, {
        command,
        ...(options.versionProbe ? { versionProbe: options.versionProbe } : {}),
      });

  if (capability) {
    warnings.push(...capability.warnings);
    if (!capability.repoRootExists || !capability.repoRootIsDirectory) {
      return {
        ok: false,
        transport: 'stdio',
        serverCommand: command,
        serverArgs: args,
        repoRoot,
        tools: [],
        expectedToolsPresent: false,
        missingTools: [...REQUIRED_CODEGRAPH_MCP_TOOLS],
        warnings,
        error: {
          code: 'CODEGRAPH_MCP_REPO_INVALID',
          message: !capability.repoRootExists
            ? `repo path does not exist: ${repoRoot}`
            : `repo path is not a directory: ${repoRoot}`,
        },
      };
    }
    if (!capability.binaryAvailable) {
      return {
        ok: false,
        transport: 'stdio',
        serverCommand: command,
        serverArgs: args,
        repoRoot,
        tools: [],
        expectedToolsPresent: false,
        missingTools: [...REQUIRED_CODEGRAPH_MCP_TOOLS],
        warnings,
        error: {
          code: 'CODEGRAPH_BINARY_NOT_FOUND',
          message: 'codegraph command was not found on PATH',
        },
      };
    }
  }

  const runner = options.runner ?? defaultCodeGraphMcpRunner;
  let outcome: CodeGraphMcpSelfTestRunnerOutcome;
  try {
    outcome = await runner({ command, args, cwd: repoRoot, timeoutMs });
  } catch (error) {
    outcome = {
      ok: false,
      code: 'CODEGRAPH_MCP_SELF_TEST_FAILED',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (outcome.warnings) warnings.push(...outcome.warnings);

  if (!outcome.ok) {
    return {
      ok: false,
      transport: 'stdio',
      serverCommand: command,
      serverArgs: args,
      repoRoot,
      tools: [],
      expectedToolsPresent: false,
      missingTools: [...REQUIRED_CODEGRAPH_MCP_TOOLS],
      warnings,
      error: { code: outcome.code, message: outcome.message },
    };
  }

  const tools = [...outcome.tools];
  const missingTools = REQUIRED_CODEGRAPH_MCP_TOOLS.filter((tool) => !tools.includes(tool));
  const expectedToolsPresent = missingTools.length === 0;

  if (!expectedToolsPresent) {
    return {
      ok: false,
      transport: 'stdio',
      serverCommand: command,
      serverArgs: args,
      repoRoot,
      tools,
      expectedToolsPresent: false,
      missingTools,
      warnings,
      error: {
        code: 'CODEGRAPH_MCP_TOOLS_MISSING',
        message: `CodeGraph MCP server is missing expected tools: ${missingTools.join(', ')}`,
      },
    };
  }

  return {
    ok: true,
    transport: 'stdio',
    serverCommand: command,
    serverArgs: args,
    repoRoot,
    tools,
    expectedToolsPresent: true,
    missingTools: [],
    warnings,
  };
}

/**
 * Default MCP self-test runner. Uses the official MCP stdio client transport
 * from `@modelcontextprotocol/sdk` to perform the handshake and call
 * `tools/list`. The SDK is loaded lazily so that tests that inject a fake
 * runner never load it.
 */
async function defaultCodeGraphMcpRunner(
  input: CodeGraphMcpSelfTestRunnerInput,
): Promise<CodeGraphMcpSelfTestRunnerOutcome> {
  let ClientCtor: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  let StdioCtor: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;
  try {
    ({ Client: ClientCtor } = await import('@modelcontextprotocol/sdk/client/index.js'));
    ({ StdioClientTransport: StdioCtor } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
  } catch (error) {
    return {
      ok: false,
      code: 'CODEGRAPH_MCP_SDK_UNAVAILABLE',
      message: `failed to load @modelcontextprotocol/sdk: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const transport = new StdioCtor({
    command: input.command,
    args: [...input.args],
    cwd: input.cwd,
    stderr: 'pipe',
  });

  const client = new ClientCtor(
    { name: 'vibecode-codegraph-mcp-self-test', version: '0.1.0' },
    { capabilities: {} },
  );

  const timer = new Promise<never>((_resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error(`CodeGraph MCP self-test timed out after ${input.timeoutMs} ms`));
    }, input.timeoutMs);
    if (typeof handle.unref === 'function') handle.unref();
  });

  try {
    await Promise.race([client.connect(transport), timer]);
    const listed = (await Promise.race([client.listTools(), timer])) as { tools?: Array<{ name?: string }> };
    const tools = (listed.tools ?? [])
      .map((tool) => (typeof tool?.name === 'string' ? tool.name : ''))
      .filter((name) => name.length > 0);
    return { ok: true, tools };
  } catch (error) {
    return {
      ok: false,
      code: 'CODEGRAPH_MCP_CONNECTION_FAILED',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await client.close();
    } catch {
      // best-effort; transport.close is called by client.close
    }
  }
}

// ---------------------------------------------------------------------------
// Agent config print
// ---------------------------------------------------------------------------

/** Agents this CLI knows how to print MCP config snippets for in Phase 1A. */
export const SUPPORTED_MCP_AGENTS = ['claude'] as const;
export type SupportedMcpAgent = (typeof SUPPORTED_MCP_AGENTS)[number];

export interface CodeGraphMcpAgentConfigSuccess {
  ok: true;
  agent: SupportedMcpAgent;
  format: 'json';
  snippet: string;
  config: unknown;
}

export interface CodeGraphMcpAgentConfigFailure {
  ok: false;
  error: {
    code: 'AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED' | 'UNKNOWN_AGENT';
    message: string;
    details: string[];
  };
}

export type CodeGraphMcpAgentConfigResult =
  | CodeGraphMcpAgentConfigSuccess
  | CodeGraphMcpAgentConfigFailure;

const KNOWN_BUT_UNIMPLEMENTED_AGENTS = new Set(['codex', 'opencode', 'hermes']);

/**
 * Build a print-only MCP config snippet for the named agent. Phase 1A only
 * supports `claude`; other agents return a structured diagnostic instead of a
 * guessed snippet.
 */
export function buildCodeGraphMcpAgentConfig(agent: string): CodeGraphMcpAgentConfigResult {
  const normalized = agent.trim().toLowerCase();
  if (normalized === 'claude') {
    const config = {
      mcpServers: {
        codegraph: {
          type: 'stdio',
          command: CODEGRAPH_COMMAND,
          args: [...CODEGRAPH_MCP_SERVER_ARGS],
        },
      },
    };
    return {
      ok: true,
      agent: 'claude',
      format: 'json',
      snippet: JSON.stringify(config, null, 2),
      config,
    };
  }

  if (KNOWN_BUT_UNIMPLEMENTED_AGENTS.has(normalized)) {
    return {
      ok: false,
      error: {
        code: 'AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED',
        message: `CodeGraph MCP config format for agent '${normalized}' is not implemented in this phase`,
        details: [
          `Supported agents in this phase: ${SUPPORTED_MCP_AGENTS.join(', ')}.`,
          'See docs/codegraph_mcp_roadmap.md for the planned agent rollout.',
        ],
      },
    };
  }

  return {
    ok: false,
    error: {
      code: 'UNKNOWN_AGENT',
      message: `unknown agent: ${agent}`,
      details: [`Known agents: ${[...SUPPORTED_MCP_AGENTS, ...KNOWN_BUT_UNIMPLEMENTED_AGENTS].sort().join(', ')}.`],
    },
  };
}
