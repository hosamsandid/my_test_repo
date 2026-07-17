// Runner sequencing tests (#705) — no Playwright, `node --test`. Drives
// runJourneySteps with fake test/registry/recorder to assert the loop's ordering
// and error propagation without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runJourneySteps, stepLabel, splitCall } = require('./runner');

// A `test` double whose `.step` just runs the body (like Playwright's does).
const fakeTest = { step: async (_label, body) => body() };

function fakeRecorder() {
  const captured = [];
  return { captured, capture: async (_page, id) => captured.push(id) };
}

function fakeRegistry(calls) {
  return {
    resolve: (name) => async (ctx, params) => {
      calls.push({ name, params });
    },
  };
}

test('splitCall separates do-name from opaque params', () => {
  assert.deepEqual(splitCall({ do: 'wizard.selectProcessTemplate', templateName: 'Core SDLC' }), {
    name: 'wizard.selectProcessTemplate',
    params: { templateName: 'Core SDLC' },
  });
});

test('runs action then assert then screenshot, in that order', async () => {
  const calls = [];
  const recorder = fakeRecorder();
  const journey = {
    steps: [
      {
        id: 'process-step',
        action: { do: 'wizard.selectProcessTemplate', templateName: 'Core SDLC' },
        assert: { do: 'wizard.expectFlowPreview' },
        screenshot: 'process-step-core-sdlc',
      },
    ],
  };
  await runJourneySteps(journey, { page: {} }, { test: fakeTest, registry: fakeRegistry(calls), recorder });
  assert.deepEqual(calls.map((c) => c.name), ['wizard.selectProcessTemplate', 'wizard.expectFlowPreview']);
  assert.deepEqual(recorder.captured, ['process-step-core-sdlc']);
});

test('skips narrative-only steps (no action, no capture)', async () => {
  const calls = [];
  const recorder = fakeRecorder();
  const journey = {
    steps: [
      { kind: 'narrative-only', narrative: 'intro' },
      { action: { do: 'wizard.open' } },
    ],
  };
  await runJourneySteps(journey, { page: {} }, { test: fakeTest, registry: fakeRegistry(calls), recorder });
  assert.deepEqual(calls.map((c) => c.name), ['wizard.open']);
  assert.equal(recorder.captured.length, 0);
});

test('propagates an unknown-step resolution error (AC3)', async () => {
  const recorder = fakeRecorder();
  const registry = {
    resolve: (name) => {
      throw new Error(`journey-runner: unknown step "${name}"`);
    },
  };
  const journey = { steps: [{ action: { do: 'wizard.nope' } }] };
  await assert.rejects(
    () => runJourneySteps(journey, { page: {} }, { test: fakeTest, registry, recorder }),
    /unknown step "wizard\.nope"/,
  );
});

test('a captured screenshot after a failing assert is never staged', async () => {
  // The screenshot line is only reached if the assert passes — a failing assert
  // throws first, so the recorder stays empty (mirrors "publish nothing on fail").
  const recorder = fakeRecorder();
  const registry = {
    resolve: (name) => async () => {
      if (name === 'wizard.expectFlowPreview') throw new Error('assert failed');
    },
  };
  const journey = {
    steps: [{ action: { do: 'wizard.open' }, assert: { do: 'wizard.expectFlowPreview' }, screenshot: 'shot' }],
  };
  await assert.rejects(() => runJourneySteps(journey, { page: {} }, { test: fakeTest, registry, recorder }));
  assert.equal(recorder.captured.length, 0);
});

test('stepLabel is human-readable for the report', () => {
  assert.equal(
    stepLabel({ id: 'process-step', action: { do: 'wizard.selectProcessTemplate' } }, 1),
    'process-step · wizard.selectProcessTemplate',
  );
  assert.equal(stepLabel({ kind: 'narrative-only' }, 0), 'narrative-only [0]');
});
