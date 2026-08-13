import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinList, missingFieldsHint } from './submit-hint.js';

test('joinList — empty / one / two / three', () => {
  assert.equal(joinList([]), '');
  assert.equal(joinList(['Name']), 'Name');
  assert.equal(joinList(['Name', 'Prompt']), 'Name and Prompt');
  assert.equal(joinList(['Name', 'Env', 'Prompt']), 'Name, Env and Prompt');
});

test('joinList — drops falsy entries', () => {
  assert.equal(joinList(['Name', '', null, 'Prompt', undefined]), 'Name and Prompt');
  assert.equal(joinList(null), '');
});

test('missingFieldsHint — empty when every field is filled', () => {
  assert.equal(
    missingFieldsHint([
      { label: 'Display Name', filled: true },
      { label: 'System Prompt', filled: true },
    ]),
    '',
  );
});

test('missingFieldsHint — names a single missing field', () => {
  assert.equal(
    missingFieldsHint([
      { label: 'Display Name', filled: true },
      { label: 'System Prompt', filled: false },
    ]),
    'Fill in System Prompt to continue.',
  );
});

test('missingFieldsHint — names several, preserving form order', () => {
  assert.equal(
    missingFieldsHint([
      { label: 'Display Name', filled: false },
      { label: 'ID', filled: true },
      { label: 'Working Environment', filled: false },
      { label: 'System Prompt', filled: false },
    ]),
    'Fill in Display Name, Working Environment and System Prompt to continue.',
  );
});

test('missingFieldsHint — tolerates null / undefined / holes', () => {
  assert.equal(missingFieldsHint(null), '');
  assert.equal(missingFieldsHint(undefined), '');
  assert.equal(
    missingFieldsHint([null, { label: 'Instance ID', filled: false }, undefined]),
    'Fill in Instance ID to continue.',
  );
});
