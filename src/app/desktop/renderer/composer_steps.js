/*
 * Composer result step controller (renderer-side, plain browser JS).
 *
 * Owns the small state machine behind the composer overlay's result steps:
 *   - 01 PIPELINE PROGRESS
 *   - 02 CONTEXT FLASH
 *
 * Pipeline Progress is a first-class artifact view, not a loading-only panel.
 * It is visible during the run AND after completion/warning/failure, until a
 * new run starts. The controller never auto-switches the active step away from
 * Pipeline Progress when context arrives — only an explicit selectStep() call
 * (driven by a user click) may change the active step.
 *
 * The module is loadable directly in the browser via a <script src> tag and is
 * also importable in Node tests (CommonJS export) so the state transitions can
 * be unit tested without a DOM.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VibecodeComposerSteps = api;
  }
})(
  typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this,
  function () {
    'use strict';

    var PIPELINE_PROGRESS = 'pipeline-progress';
    var CONTEXT_FLASH = 'context-flash';

    function defaultSteps() {
      return [
        {
          id: PIPELINE_PROGRESS,
          number: '01',
          label: 'pipeline progress',
          visible: true,
          enabled: true,
          active: true,
        },
        {
          id: CONTEXT_FLASH,
          number: '02',
          label: 'context flash',
          visible: true,
          enabled: false,
          active: false,
        },
      ];
    }

    function createStepController(options) {
      options = options || {};
      var onChange = typeof options.onChange === 'function' ? options.onChange : null;

      var steps = defaultSteps();
      var events = [];
      var runState = 'idle'; // idle | running | completed | warned | failed

      function findStep(id) {
        for (var i = 0; i < steps.length; i += 1) {
          if (steps[i].id === id) return steps[i];
        }
        return null;
      }

      function snapshot() {
        var copy = steps.map(function (s) {
          return {
            id: s.id,
            number: s.number,
            label: s.label,
            visible: s.visible,
            enabled: s.enabled,
            active: s.active,
          };
        });
        var active = null;
        for (var i = 0; i < copy.length; i += 1) {
          if (copy[i].active) { active = copy[i].id; break; }
        }
        return {
          steps: copy,
          events: events.slice(),
          runState: runState,
          activeStepId: active,
        };
      }

      function notify() {
        if (onChange) onChange(snapshot());
      }

      function setActiveInternal(id) {
        var changed = false;
        for (var i = 0; i < steps.length; i += 1) {
          var nextActive = steps[i].id === id;
          if (steps[i].active !== nextActive) {
            steps[i].active = nextActive;
            changed = true;
          }
        }
        return changed;
      }

      function selectStep(id) {
        var target = findStep(id);
        if (!target) return false;
        if (!target.visible || !target.enabled) return false;
        if (target.active) return false;
        setActiveInternal(id);
        notify();
        return true;
      }

      function setEnabled(id, enabled) {
        var target = findStep(id);
        if (!target) return;
        var next = Boolean(enabled);
        if (target.enabled === next) return;
        target.enabled = next;
        // Never silently move the active step off Pipeline Progress because
        // Context Flash was just disabled — Pipeline Progress is always
        // available, so the active step remains valid.
        notify();
      }

      function startRun() {
        events = [];
        runState = 'running';
        // Force Pipeline Progress active and gate Context Flash until data
        // arrives. We must NOT carry stale context flash content from a prior
        // run into a new run.
        var pp = findStep(PIPELINE_PROGRESS);
        if (pp) { pp.enabled = true; }
        var cf = findStep(CONTEXT_FLASH);
        if (cf) { cf.enabled = false; }
        setActiveInternal(PIPELINE_PROGRESS);
        notify();
      }

      function addProgressEvent(event) {
        if (!event) return;
        events.push(event);
        notify();
      }

      function markCompleted() {
        runState = 'completed';
        var cf = findStep(CONTEXT_FLASH);
        if (cf) cf.enabled = true;
        // Do NOT auto-switch active step to context-flash. Pipeline Progress
        // stays selected so the user can see what just happened.
        notify();
      }

      function markWarned() {
        runState = 'warned';
        var cf = findStep(CONTEXT_FLASH);
        if (cf) cf.enabled = true;
        // Same as completed: stay on Pipeline Progress.
        notify();
      }

      function markFailed() {
        runState = 'failed';
        var cf = findStep(CONTEXT_FLASH);
        if (cf) cf.enabled = true;
        // Failed runs still render an error summary into Context Flash, so the
        // user may click into it; but Pipeline Progress stays selected because
        // the failed event row is the primary signal.
        notify();
      }

      function reset() {
        steps = defaultSteps();
        events = [];
        runState = 'idle';
        notify();
      }

      return {
        getState: snapshot,
        selectStep: selectStep,
        setEnabled: setEnabled,
        startRun: startRun,
        addProgressEvent: addProgressEvent,
        markCompleted: markCompleted,
        markWarned: markWarned,
        markFailed: markFailed,
        reset: reset,
      };
    }

    return {
      createStepController: createStepController,
      PIPELINE_PROGRESS_STEP: PIPELINE_PROGRESS,
      CONTEXT_FLASH_STEP: CONTEXT_FLASH,
    };
  },
);
