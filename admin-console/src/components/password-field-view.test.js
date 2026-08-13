import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordInputType, revealToggleLabel } from './password-field-view.js';

test('passwordInputType: masked by default, plain text when revealed', () => {
  assert.equal(passwordInputType(false), 'password');
  assert.equal(passwordInputType(true), 'text');
});

test('revealToggleLabel: names the action the click performs, not the state', () => {
  // Masked → the button will SHOW the password; revealed → it will HIDE it.
  assert.equal(revealToggleLabel(false), 'Show password');
  assert.equal(revealToggleLabel(true), 'Hide password');
});
