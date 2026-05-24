export type PipelineEventPhase =
  | 'run_created'
  | 'scan_started'
  | 'scan_completed'
  | 'flash_input_built'
  | 'provider_resolved'
  | 'flash_request_started'
  | 'flash_response_received'
  | 'flash_output_validated'
  | 'context_pack_written'
  | 'final_prompt_written'
  | 'failed';

export interface PipelineEvent {
  phase: PipelineEventPhase;
  message: string;
  run_id?: string;
  provider_id?: string;
  model_id?: string;
  elapsed_ms?: number;
  artifact_path?: string;
}

export type PipelineProgressCallback = (event: PipelineEvent) => void;
