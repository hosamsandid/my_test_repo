// Pure schema tests (#705) — no Playwright, run with `node --test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateJourney,
  validateStepNames,
  referencedStepNames,
  JourneyValidationError,
} = require('./schema');

function baseJourney(overrides = {}) {
  return {
    journeyVersion: 1,
    id: 'demo',
    title: 'Demo',
    steps: [{ id: 's1', action: { do: 'wizard.open' } }],
    ...overrides,
  };
}

test('accepts a minimal valid journey', () => {
  const j = baseJourney();
  assert.equal(validateJourney(j), j);
});

test('accepts the full v1 shape (fixtures, narrative-only, action/assert/screenshot)', () => {
  const j = baseJourney({
    order: 10,
    lanes: ['ci'],
    fixtures: [{ fixture: 'teamEnv', params: { teamId: 't' } }],
    steps: [
      { kind: 'narrative-only', narrative: 'intro' },
      {
        id: 'process-step',
        narrative: 'prose',
        action: { do: 'wizard.selectProcessTemplate', templateName: 'Core SDLC' },
        assert: { do: 'wizard.expectFlowPreview' },
        screenshot: 'process-step-core-sdlc',
      },
    ],
  });
  assert.doesNotThrow(() => validateJourney(j));
});

test('rejects a wrong journeyVersion', () => {
  assert.throws(() => validateJourney(baseJourney({ journeyVersion: 2 })), JourneyValidationError);
});

test('rejects a non-slug id and screenshot', () => {
  assert.throws(() => validateJourney(baseJourney({ id: 'Not A Slug' })), /id .* must be a slug/);
  assert.throws(
    () => validateJourney(baseJourney({ steps: [{ action: { do: 'x.y' }, screenshot: 'Bad Shot' }] })),
    /screenshot .* must be a slug/,
  );
});

test('rejects an action/assert without a "do"', () => {
  assert.throws(
    () => validateJourney(baseJourney({ steps: [{ action: { templateName: 'x' } }] })),
    /action\.do must be a non-empty step name/,
  );
});

test('rejects a bare step with no action/assert/screenshot', () => {
  assert.throws(
    () => validateJourney(baseJourney({ steps: [{ narrative: 'just prose' }] })),
    /mark it "kind: narrative-only"/,
  );
});

test('rejects a narrative-only step carrying an action or screenshot', () => {
  assert.throws(
    () => validateJourney(baseJourney({ steps: [{ kind: 'narrative-only', narrative: 'x', action: { do: 'a.b' } }] })),
    /narrative-only and cannot carry an action/,
  );
  assert.throws(
    () => validateJourney(baseJourney({ steps: [{ kind: 'narrative-only', narrative: 'x', screenshot: 'shot' }] })),
    /narrative-only and cannot carry a screenshot/,
  );
});

test('rejects duplicate screenshot ids', () => {
  assert.throws(
    () =>
      validateJourney(
        baseJourney({
          steps: [
            { action: { do: 'a.b' }, screenshot: 'dup' },
            { action: { do: 'a.c' }, screenshot: 'dup' },
          ],
        }),
      ),
    /duplicate screenshot id "dup"/,
  );
});

test('rejects an empty steps list', () => {
  assert.throws(() => validateJourney(baseJourney({ steps: [] })), /steps must be a non-empty list/);
});

test('referencedStepNames dedups action + assert do-names in order', () => {
  const j = baseJourney({
    steps: [
      { action: { do: 'wizard.open' } },
      { action: { do: 'wizard.selectProcessTemplate' }, assert: { do: 'wizard.expectFlowPreview' } },
      { assert: { do: 'wizard.expectFlowPreview' } }, // dup — dropped
    ],
  });
  assert.deepEqual(referencedStepNames(j), [
    'wizard.open',
    'wizard.selectProcessTemplate',
    'wizard.expectFlowPreview',
  ]);
});

test('validateStepNames passes when every name is known', () => {
  const j = baseJourney({ steps: [{ action: { do: 'wizard.open' } }] });
  assert.doesNotThrow(() => validateStepNames(j, new Set(['wizard.open'])));
});

test('validateStepNames rejects an unknown step with a clear, listing error', () => {
  const j = baseJourney({ steps: [{ action: { do: 'wizard.doesNotExist' } }] });
  assert.throws(
    () => validateStepNames(j, new Set(['wizard.open', 'wizard.next'])),
    (err) =>
      err instanceof JourneyValidationError &&
      /unknown step "wizard\.doesNotExist"/.test(err.message) &&
      /Known steps: wizard\.next, wizard\.open/.test(err.message),
  );
});
