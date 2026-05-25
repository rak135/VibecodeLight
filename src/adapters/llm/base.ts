export interface LlmAdapter {
  run(_input: FlashInput): Promise<FlashAdapterResult>;
}

export interface FlashInput {
  flashInputMd: string;
  flashDir: string;
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
