export interface LlmAdapter {
  // eslint-disable-next-line no-unused-vars
  run(_input: FlashInput): Promise<FlashAdapterResult>;
}

export interface FlashInput {
  flashInputMd: string;
  runId: string;
  workspaceRoot: string;
}

export interface FlashAdapterResult {
  flashOutputMd: string;
  toolCalls: ToolCallRecord[];
  meta: Record<string, unknown>;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  status: 'ok' | 'refused' | 'error';
  resultSummary: string;
  timestamp: string;
  pathAccessed?: string;
}
