/**
 * Identifier for a single pipeline progress event. Each id corresponds to a
 * specific moment in the prompt pipeline. Ids are part of the public progress
 * contract (renderer, CLI, tests, persisted progress_events.jsonl) — do not
 * rename without updating consumers.
 */
export type PipelineEventPhase =
  // Run lifecycle
  | 'run_created'
  | 'run_directory_ready'
  | 'run_completed'
  // Task Normalizer
  | 'task_normalizer_skipped'
  | 'task_normalizer_started'
  | 'task_normalizer_completed'
  | 'task_normalizer_fallback'
  // Scan
  | 'scanner_config_written'
  | 'scan_started'
  | 'scan_completed'
  | 'exact_text_scan_completed'
  // CodeGraph
  | 'codegraph_detect_started'
  | 'codegraph_detect_completed'
  | 'codegraph_detect_only'
  | 'codegraph_use_existing_started'
  | 'codegraph_context_completed'
  | 'codegraph_context_failed'
  | 'codegraph_transport_fallback'
  | 'codegraph_skipped'
  // Flash input
  | 'flash_input_started'
  | 'flash_input_built'
  // Provider / LLM
  | 'provider_resolved'
  | 'flash_request_started'
  | 'flash_stream_delta'
  | 'flash_request_completed'
  | 'flash_request_failed'
  // Back-compat synonyms retained for CLI / IPC consumers.
  | 'flash_response_received'
  | 'flash_output_validated'
  // Flash output / final prompt
  | 'flash_output_parsed'
  | 'flash_output_meta_written'
  | 'context_pack_written'
  | 'final_prompt_rendered'
  | 'final_prompt_written'
  // Outcome
  | 'pipeline_warning'
  | 'pipeline_completed_with_warnings'
  | 'pipeline_failed'
  | 'failed';

/**
 * Status of a single event. Used by the renderer to pick the icon, the CLI to
 * group output, and the progress_events.jsonl artifact for downstream tooling.
 */
export type PipelineEventStatus =
  | 'started'
  | 'completed'
  | 'skipped'
  | 'warning'
  | 'failed';

export interface PipelineEvent {
  /** Stable event identifier (e.g. 'task_normalizer_completed'). */
  phase: PipelineEventPhase;
  /** Coarse status of this event. */
  status: PipelineEventStatus;
  /** Human-readable phase grouping (e.g. 'Task Normalizer'). */
  label: string;
  /** Short user-facing message. */
  message: string;
  /** Optional fine-grained detail (e.g. 'cs → English, 8 hints'). */
  detail?: string;
  /** ISO timestamp at which the event was emitted. */
  timestamp: string;
  /** Elapsed milliseconds since pipeline start. */
  elapsed_ms?: number;
  /** Optional duration for completed events that wrap a measurable step. */
  duration_ms?: number;
  run_id?: string;
  provider_id?: string;
  model_id?: string;
  artifact_path?: string;
  chunk?: string;
}

export type PipelineProgressCallback = (event: PipelineEvent) => void;
