export {
  createVibecodeMcpServer,
  VIBECODE_MCP_SERVER_NAME,
  VIBECODE_MCP_SERVER_VERSION,
  type McpLogLevel,
  type VibecodeMcpServerHandle,
  type VibecodeMcpServerOptions,
} from './server_stdio.js';

export {
  buildVibecodeMcpTools,
  VIBECODE_MCP_TOOL_NAMES,
  type McpServerContext,
  type McpToolDefinition,
  type McpToolHandlerInput,
} from './tool_registry.js';

export {
  MCP_TOOL_CONTRACTS,
  getMcpToolCatalog,
  getMcpToolDetail,
  type McpToolCatalog,
  type McpToolCatalogItem,
  type McpToolOutputContract,
  type McpToolSideEffect,
} from './tool_catalog.js';

export {
  buildMcpError,
  type McpErrorCode,
  type McpStructuredError,
} from './errors.js';

export {
  MCP_TEXT_OUTPUT_LIMIT,
  boundUtf8,
  formatError,
  formatQueryResultFailure,
  formatQueryResultSuccess,
  formatStatusSuccess,
  type McpToolContentBlock,
  type McpToolFormattedResult,
  type McpToolStructured,
} from './format.js';

export {
  MCP_TOOL_USAGE_LOG_RELATIVE_PATH,
  MCP_TOOL_USAGE_LOG_SCHEMA_VERSION,
  appendMcpToolUsage,
  buildMcpToolUsageEvent,
  resolveMcpToolUsageLogPath,
  type McpToolUsageEvent,
  type McpToolUsageInputSummary,
} from './logging.js';

export {
  STATUS_INPUT_SCHEMA,
  SEARCH_INPUT_SCHEMA,
  CONTEXT_INPUT_SCHEMA,
  FILES_INPUT_SCHEMA,
  SYMBOL_INPUT_SCHEMA,
  IMPACT_INPUT_SCHEMA,
  type JsonSchema,
} from './schemas.js';
