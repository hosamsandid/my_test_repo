import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelsAfterSet } from './label-registry-ops.js';

// #981 — the label-registry update helper both adapters share.

test('labelsAfterSet adds a flagged entry and replaces an existing one', () => {
  assert.deepEqual(labelsAfterSet([], 'ready-3', { humanGate: true }),
    [{ name: 'ready-3', humanGate: true }]);
  assert.deepEqual(
    labelsAfterSet([{ name: 'ready-3', humanGate: true }], 'ready-3', { brake: true }),
    [{ name: 'ready-3', brake: true }]);
});

test('labelsAfterSet drops an entry whose flags are both cleared', () => {
  assert.deepEqual(
    labelsAfterSet([{ name: 'ready-3', humanGate: true }, { name: 'hold', brake: true }], 'ready-3', {}),
    [{ name: 'hold', brake: true }]);
});

test('labelsAfterSet trims and ignores blank names', () => {
  assert.deepEqual(labelsAfterSet([], '  go  ', { humanGate: true }), [{ name: 'go', humanGate: true }]);
  assert.deepEqual(labelsAfterSet([{ name: 'go', brake: true }], '', { humanGate: true }),
    [{ name: 'go', brake: true }]);
});
