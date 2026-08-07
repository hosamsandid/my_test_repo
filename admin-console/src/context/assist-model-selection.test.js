import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_PREFIX,
  storageKey,
  isAssistSelectionErrorCode,
  validateSelection,
  autoSelect,
  selectionHeaderValue,
  needsSelection,
  selectionLabel,
} from './assist-model-selection.js';

const PROVIDERS = [
  {
    id: 'ep-team-a', name: 'Team A key', scope: 'team',
    models: [
      { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', kind: 'sonnet' },
      { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', kind: 'haiku' },
    ],
    defaultModelId: 'claude-sonnet-4-6',
  },
  {
    id: 'ep-system', name: 'System key', scope: 'system',
    models: [{ id: 'claude-opus-4-1', displayName: 'Opus 4.1', kind: 'opus' }],
    defaultModelId: 'claude-opus-4-1',
  },
];

test('storageKey is per-user, null without a username', () => {
  assert.equal(storageKey('alice'), `${STORAGE_PREFIX}.alice`);
  assert.equal(storageKey(''), null);
  assert.equal(storageKey(undefined), null);
});

test('isAssistSelectionErrorCode matches only the two selection codes', () => {
  assert.equal(isAssistSelectionErrorCode('assist-endpoint-not-permitted'), true);
  assert.equal(isAssistSelectionErrorCode('assist-model-not-selected'), true);
  assert.equal(isAssistSelectionErrorCode('forbidden'), false);
  assert.equal(isAssistSelectionErrorCode(undefined), false);
});

test('validateSelection keeps a still-valid selection', () => {
  assert.deepEqual(
    validateSelection({ endpointId: 'ep-team-a', modelId: 'claude-haiku-4-5' }, PROVIDERS),
    { endpointId: 'ep-team-a', modelId: 'claude-haiku-4-5' },
  );
});

test('validateSelection drops a selection whose provider is gone', () => {
  assert.equal(validateSelection({ endpointId: 'ep-deleted', modelId: 'x' }, PROVIDERS), null);
});

test('validateSelection coerces a removed model to the provider default', () => {
  assert.deepEqual(
    validateSelection({ endpointId: 'ep-team-a', modelId: 'gone' }, PROVIDERS),
    { endpointId: 'ep-team-a', modelId: 'claude-sonnet-4-6' },
  );
});

test('validateSelection returns null for empty input', () => {
  assert.equal(validateSelection(null, PROVIDERS), null);
  assert.equal(validateSelection({ modelId: 'x' }, PROVIDERS), null);
});

test('autoSelect only when exactly one provider', () => {
  assert.equal(autoSelect(PROVIDERS), null);
  assert.equal(autoSelect([]), null);
  assert.deepEqual(
    autoSelect([PROVIDERS[1]]),
    { endpointId: 'ep-system', modelId: 'claude-opus-4-1' },
  );
});

test('autoSelect falls back to first model when default is missing', () => {
  const p = [{ id: 'ep-x', name: 'X', models: [{ id: 'm1' }, { id: 'm2' }] }];
  assert.deepEqual(autoSelect(p), { endpointId: 'ep-x', modelId: 'm1' });
});

test('autoSelect returns null when the sole provider has no model', () => {
  assert.equal(autoSelect([{ id: 'ep-x', name: 'X', models: [] }]), null);
});

test('selectionHeaderValue encodes endpointId:modelId', () => {
  assert.equal(
    selectionHeaderValue({ endpointId: 'ep-team-a', modelId: 'claude-sonnet-4-6' }),
    'ep-team-a:claude-sonnet-4-6',
  );
  assert.equal(selectionHeaderValue(null), null);
  assert.equal(selectionHeaderValue({ endpointId: 'ep-team-a' }), null);
});

test('needsSelection is the ≥2-providers-no-selection attention state', () => {
  assert.equal(needsSelection(null, PROVIDERS), true);
  assert.equal(needsSelection(null, [PROVIDERS[0]]), false);
  assert.equal(needsSelection(null, []), false);
  assert.equal(needsSelection({ endpointId: 'ep-team-a', modelId: 'm' }, PROVIDERS), false);
});

test('selectionLabel renders "provider · model" with display names', () => {
  assert.equal(
    selectionLabel({ endpointId: 'ep-team-a', modelId: 'claude-haiku-4-5' }, PROVIDERS),
    'Team A key · Haiku 4.5',
  );
});

test('selectionLabel falls back to raw ids when the option vanished', () => {
  assert.equal(
    selectionLabel({ endpointId: 'ep-gone', modelId: 'm-gone' }, PROVIDERS),
    'ep-gone · m-gone',
  );
  assert.equal(selectionLabel(null, PROVIDERS), null);
});
