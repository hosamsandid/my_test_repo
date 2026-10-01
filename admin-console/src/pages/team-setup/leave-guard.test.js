import test from 'node:test';
import assert from 'node:assert/strict';

import { wizardHasUnsavedInput } from './leave-guard.js';

test('a fresh wizard has nothing to lose', () => {
  assert.equal(wizardHasUnsavedInput({ step: 0, form: { processBundle: null }, launched: false }), false);
});

test('a picked process or any later step is input worth warning about', () => {
  assert.equal(wizardHasUnsavedInput({ step: 0, form: { processBundle: { roles: [] } }, launched: false }), true);
  assert.equal(wizardHasUnsavedInput({ step: 2, form: { processBundle: null }, launched: false }), true);
});

test('after a completed launch the guard is off', () => {
  assert.equal(wizardHasUnsavedInput({ step: 4, form: { processBundle: { roles: [] } }, launched: true }), false);
});
