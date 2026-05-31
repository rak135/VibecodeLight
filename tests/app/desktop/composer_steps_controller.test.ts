import ComposerSteps from '../../../src/app/desktop/renderer/composer_steps.js';

// The composer step controller is a DOM-free state machine behind the result
// steps in the desktop composer overlay (01 PIPELINE PROGRESS / 02 CONTEXT
// FLASH). Pipeline Progress is a first-class artifact view, not a temporary
// loading panel — it must remain visible and selected after the run completes,
// warns, or fails, until the user explicitly clicks another step or starts a
// new run.

function snapshot() {
  return ComposerSteps.createStepController();
}

function findStep(state: ReturnType<ReturnType<typeof snapshot>['getState']>, id: string) {
  return state.steps.find((step) => step.id === id);
}

describe('composer step controller', () => {
  test('default state lists both Pipeline Progress and Context Flash as stable steps', () => {
    const ctrl = ComposerSteps.createStepController();
    const state = ctrl.getState();

    expect(state.steps.map((s) => s.id)).toEqual(['pipeline-progress', 'context-flash']);
    expect(state.steps.map((s) => s.number)).toEqual(['01', '02']);
    expect(state.steps.map((s) => s.visible)).toEqual([true, true]);
    expect(findStep(state, 'pipeline-progress')!.active).toBe(true);
    expect(findStep(state, 'context-flash')!.active).toBe(false);
    expect(findStep(state, 'pipeline-progress')!.enabled).toBe(true);
    // Context Flash starts disabled — there is no data yet.
    expect(findStep(state, 'context-flash')!.enabled).toBe(false);
    expect(state.activeStepId).toBe('pipeline-progress');
    expect(state.runState).toBe('idle');
  });

  test('startRun selects Pipeline Progress, clears events, disables Context Flash', () => {
    const ctrl = ComposerSteps.createStepController();
    // Simulate a prior completed run where the user clicked into Context Flash.
    ctrl.addProgressEvent({ phase: 'scan_started', message: 'first run' });
    ctrl.markCompleted();
    ctrl.selectStep('context-flash');
    expect(ctrl.getState().activeStepId).toBe('context-flash');

    ctrl.startRun();
    const state = ctrl.getState();

    expect(state.activeStepId).toBe('pipeline-progress');
    expect(state.events).toEqual([]);
    expect(findStep(state, 'context-flash')!.enabled).toBe(false);
    expect(state.runState).toBe('running');
  });

  // A. Progress tab persists after success
  test('after completion Pipeline Progress stays visible AND selected; Context Flash enabled but not active', () => {
    const ctrl = ComposerSteps.createStepController();
    ctrl.startRun();
    ctrl.addProgressEvent({ phase: 'scan_started', label: 'scan', status: 'started' });
    ctrl.addProgressEvent({ phase: 'flash_input_built', label: 'flash input', status: 'completed' });
    ctrl.markCompleted();

    const state = ctrl.getState();
    const pp = findStep(state, 'pipeline-progress')!;
    const cf = findStep(state, 'context-flash')!;

    expect(pp.visible).toBe(true);
    expect(pp.active).toBe(true);
    expect(cf.visible).toBe(true);
    expect(cf.active).toBe(false);
    expect(cf.enabled).toBe(true);
    expect(state.events.length).toBe(2);
    expect(state.runState).toBe('completed');
  });

  // B. Progress tab persists after warning completion
  test('pipeline_completed_with_warnings leaves Pipeline Progress visible and selected', () => {
    const ctrl = ComposerSteps.createStepController();
    ctrl.startRun();
    ctrl.addProgressEvent({ phase: 'scan_started', label: 'scan', status: 'started' });
    ctrl.markWarned();

    const state = ctrl.getState();
    const pp = findStep(state, 'pipeline-progress')!;
    expect(pp.visible).toBe(true);
    expect(pp.active).toBe(true);
    expect(state.runState).toBe('warned');
    expect(state.events.length).toBe(1);
  });

  // C. Progress tab persists after failure; failed event preserved
  test('pipeline_failed leaves Pipeline Progress visible and selected, with failed event preserved', () => {
    const ctrl = ComposerSteps.createStepController();
    ctrl.startRun();
    ctrl.addProgressEvent({ phase: 'pipeline_failed', message: 'boom', status: 'failed' });
    ctrl.markFailed();

    const state = ctrl.getState();
    const pp = findStep(state, 'pipeline-progress')!;
    expect(pp.active).toBe(true);
    expect(pp.visible).toBe(true);
    expect(state.runState).toBe('failed');
    // The failed event row must remain in the buffer for the renderer to show.
    expect(state.events.some((e) => e.phase === 'pipeline_failed')).toBe(true);
  });

  // D. Manual switching works
  test('user click switches between Pipeline Progress and Context Flash after completion', () => {
    const ctrl = ComposerSteps.createStepController();
    ctrl.startRun();
    ctrl.addProgressEvent({ phase: 'scan_started', label: 'scan', status: 'started' });
    ctrl.markCompleted();

    expect(ctrl.selectStep('context-flash')).toBe(true);
    expect(ctrl.getState().activeStepId).toBe('context-flash');

    expect(ctrl.selectStep('pipeline-progress')).toBe(true);
    expect(ctrl.getState().activeStepId).toBe('pipeline-progress');
    // Progress events are preserved across the round trip.
    expect(ctrl.getState().events.length).toBe(1);
  });

  test('selecting a disabled step is a no-op', () => {
    const ctrl = ComposerSteps.createStepController();
    // Context Flash starts disabled.
    expect(ctrl.selectStep('context-flash')).toBe(false);
    expect(ctrl.getState().activeStepId).toBe('pipeline-progress');
  });

  // E. New run resets to Pipeline Progress and clears old progress
  test('starting a new run after manual switch resets to Pipeline Progress with empty events', () => {
    const ctrl = ComposerSteps.createStepController();
    ctrl.startRun();
    ctrl.addProgressEvent({ phase: 'scan_started', label: 'scan', status: 'started' });
    ctrl.markCompleted();
    ctrl.selectStep('context-flash');
    expect(ctrl.getState().activeStepId).toBe('context-flash');

    ctrl.startRun();
    const state = ctrl.getState();

    expect(state.activeStepId).toBe('pipeline-progress');
    expect(state.events).toEqual([]);
    expect(state.runState).toBe('running');
    // Context Flash is gated again until fresh data arrives.
    expect(findStep(state, 'context-flash')!.enabled).toBe(false);
  });

  // F. Regression for current bug
  test('after completion the step list contains BOTH Pipeline Progress and Context Flash (not Context Flash only)', () => {
    const ctrl = ComposerSteps.createStepController();
    ctrl.startRun();
    ctrl.markCompleted();
    const ids = ctrl.getState().steps.filter((s) => s.visible).map((s) => s.id);
    expect(ids).toContain('pipeline-progress');
    expect(ids).toContain('context-flash');
    expect(ids).not.toEqual(['context-flash']);
  });

  test('events arriving after run completion do NOT change the active step away from Pipeline Progress', () => {
    const ctrl = ComposerSteps.createStepController();
    ctrl.startRun();
    ctrl.markCompleted();
    // Simulate a trailing event arriving after run_completed.
    ctrl.addProgressEvent({ phase: 'trailing_event', status: 'completed' });
    expect(ctrl.getState().activeStepId).toBe('pipeline-progress');
  });

  test('pipeline_warning events are buffered and survive a switch to Context Flash and back', () => {
    const ctrl = ComposerSteps.createStepController();
    ctrl.startRun();
    ctrl.addProgressEvent({
      phase: 'pipeline_warning',
      label: 'Scanner',
      message: 'pnpm not available on PATH.',
      status: 'warning',
    });
    ctrl.addProgressEvent({
      phase: 'pipeline_warning',
      label: 'Scanner',
      message: 'npm not available on PATH.',
      status: 'warning',
    });
    ctrl.addProgressEvent({
      phase: 'pipeline_completed_with_warnings',
      label: 'Run',
      message: 'Pipeline completed with 2 warnings.',
      status: 'warning',
    });
    ctrl.markWarned();

    // Switch to Context Flash and back.
    expect(ctrl.selectStep('context-flash')).toBe(true);
    expect(ctrl.selectStep('pipeline-progress')).toBe(true);

    const state = ctrl.getState();
    const warningMessages = state.events
      .filter((e) => e.phase === 'pipeline_warning')
      .map((e) => e.message);
    expect(warningMessages).toEqual([
      'pnpm not available on PATH.',
      'npm not available on PATH.',
    ]);
    expect(state.events.some((e) => e.phase === 'pipeline_completed_with_warnings')).toBe(true);
    // Pipeline Progress is selected after switching back so the user can read
    // the warning rows.
    expect(state.activeStepId).toBe('pipeline-progress');
  });

  test('onChange callback fires on every state transition', () => {
    const calls: string[] = [];
    const ctrl = ComposerSteps.createStepController({
      onChange: (state) => calls.push(state.runState + ':' + state.activeStepId),
    });
    ctrl.startRun();
    ctrl.addProgressEvent({ phase: 'scan_started' });
    ctrl.markCompleted();
    ctrl.selectStep('context-flash');
    ctrl.startRun();

    expect(calls).toEqual([
      'running:pipeline-progress',
      'running:pipeline-progress',
      'completed:pipeline-progress',
      'completed:context-flash',
      'running:pipeline-progress',
    ]);
  });
});
