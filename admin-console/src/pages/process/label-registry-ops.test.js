import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelsAfterSet, labelsAfterRemove, assertLabelsUnused, registryRows } from './label-registry-ops.js';

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

// #2716 — deleting unused registry entries.

test('labelsAfterRemove drops the named entries (trimmed) and keeps the rest with their flags', () => {
  const cur = [{ name: 'a-jvc', humanGate: true }, { name: ' b ', brake: true }, { name: 'keep', humanGate: true }, { name: '' }, null];
  assert.deepEqual(labelsAfterRemove(cur, ['a-jvc', 'b']), [{ name: 'keep', humanGate: true }]);
  assert.deepEqual(labelsAfterRemove(cur, 'a-jvc'), [{ name: ' b ', brake: true }, { name: 'keep', humanGate: true }]);
  assert.deepEqual(labelsAfterRemove(undefined, ['x']), []);
});

test('assertLabelsUnused passes for unused names and rejects names used at save time', () => {
  assert.doesNotThrow(() => assertLabelsUnused(['a', ' b '], ['a', 'b', 'c']));
  assert.throws(() => assertLabelsUnused(['a', 'used'], ['a']), /now used in the flow: used/);
  assert.throws(() => assertLabelsUnused(['a'], undefined), /now used in the flow: a/);
});

test('registryRows sorts, trims, derives kind and marks unused labels', () => {
  assert.deepEqual(registryRows([
    { name: 'z', humanGate: true, brake: true },
    { name: ' old-jvc ', brake: true },
    { name: 'mid' },
    { name: '' },
  ], ['old-jvc']), [
    { name: 'mid', kind: 'agent', unused: false },
    { name: 'old-jvc', kind: 'brake', unused: true },
    { name: 'z', kind: 'gate', unused: false },
  ]);
  assert.deepEqual(registryRows([{ name: 'a' }]), [{ name: 'a', kind: 'agent', unused: false }]);
});
