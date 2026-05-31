// Type declarations for the plain-JS renderer step controller module.
// Owns the small state machine behind the composer overlay result steps.

export type ComposerStepId = 'pipeline-progress' | 'context-flash';
export type ComposerRunState = 'idle' | 'running' | 'completed' | 'warned' | 'failed';

export interface ComposerStepView {
  id: ComposerStepId;
  number: string;
  label: string;
  visible: boolean;
  enabled: boolean;
  active: boolean;
}

export interface ComposerProgressEvent {
  phase?: string;
  status?: string;
  message?: string;
  label?: string;
  detail?: string;
  [key: string]: unknown;
}

export interface ComposerStepState {
  steps: ComposerStepView[];
  events: ComposerProgressEvent[];
  runState: ComposerRunState;
  activeStepId: ComposerStepId | null;
}

export interface ComposerStepController {
  getState(): ComposerStepState;
  selectStep(id: ComposerStepId | string): boolean;
  setEnabled(id: ComposerStepId | string, enabled: boolean): void;
  startRun(): void;
  addProgressEvent(event: ComposerProgressEvent): void;
  markCompleted(): void;
  markWarned(): void;
  markFailed(): void;
  reset(): void;
}

export interface ComposerStepControllerOptions {
  onChange?: (state: ComposerStepState) => void;
}

export interface ComposerStepsApi {
  createStepController(options?: ComposerStepControllerOptions): ComposerStepController;
  PIPELINE_PROGRESS_STEP: 'pipeline-progress';
  CONTEXT_FLASH_STEP: 'context-flash';
}

declare const api: ComposerStepsApi;
export default api;

declare global {
  interface Window {
    VibecodeComposerSteps?: ComposerStepsApi;
  }
}
