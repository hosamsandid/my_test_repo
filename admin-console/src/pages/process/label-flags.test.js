import { test } from 'node:test';
import assert from 'node:assert/strict';

import { labelFlags, isGateLabel, isBrakeLabel, classifyLabel } from './label-flags.js';

// Unit tests for the client-side gate/brake classifier (#928). The rule must
// agree with makeLabelClassifier in admin-console/api/process-graph.js: flags
// only, never the label's name.

const REGISTRY = [
  { name: 'approved-for-dispatch', humanGate: true, brake: false },
  { name: 'human-decision-required', humanGate: false, brake: true },
  { name: 'ready-for-review', humanGate: false, brake: false },
];

test('labelFlags reads the registry entry, defaults to no flags', () => {
  assert.deepEqual(labelFlags(REGISTRY, 'approved-for-dispatch'), { humanGate: true, brake: false });
  assert.deepEqual(labelFlags(REGISTRY, 'human-decision-required'), { humanGate: false, brake: true });
  assert.deepEqual(labelFlags(REGISTRY, 'ready-for-review'), { humanGate: false, brake: false });
  assert.deepEqual(labelFlags(REGISTRY, 'never-registered'), { humanGate: false, brake: false });
});

test('labelFlags tolerates a missing/blank registry and blank names', () => {
  assert.deepEqual(labelFlags(undefined, 'x'), { humanGate: false, brake: false });
  assert.deepEqual(labelFlags(REGISTRY, ''), { humanGate: false, brake: false });
  assert.deepEqual(labelFlags(REGISTRY, null), { humanGate: false, brake: false });
});

test('labelFlags trims the looked-up name (the dialog input is untrimmed)', () => {
  assert.deepEqual(labelFlags(REGISTRY, '  approved-for-dispatch  '), { humanGate: true, brake: false });
});

// AC5 — the client warns on the flag, whatever the label is called.
test('isGateLabel is driven by the humanGate flag, not the name', () => {
  assert.equal(isGateLabel(REGISTRY, 'approved-for-dispatch'), true);
  assert.equal(isGateLabel(REGISTRY, 'ready-for-review'), false);
});

// AC8 — the retired conventions carry no meaning of their own any more.
test('the retired human:* / hold / needs:human names are NOT gates or brakes', () => {
  for (const name of ['human:approved', 'human:dispatch', 'hold', 'needs:human']) {
    assert.equal(isGateLabel(REGISTRY, name), false, `${name} must not be a gate`);
    assert.equal(isBrakeLabel(REGISTRY, name), false, `${name} must not be a brake`);
    assert.equal(classifyLabel(REGISTRY, name), 'agent');
  }
});

test("isGateLabel also honours a channel port's gate: 'human'", () => {
  const channels = [
    { artifact: 'issue', from: 'ba', label: 'design-approved', gate: 'human' },
    { artifact: 'pr', from: 'dev', label: 'ready-for-review' },
  ];
  assert.equal(isGateLabel([], 'design-approved', channels), true);
  assert.equal(isGateLabel([], 'ready-for-review', channels), false, 'an ungated channel label is plain');
  assert.equal(isGateLabel([], 'design-approved'), false, 'without the channels there is nothing to read');
});

// AC3 — a brake is agent-appliable, so it must classify as a brake and never a gate.
test('a brake label is a brake, not a gate', () => {
  assert.equal(isBrakeLabel(REGISTRY, 'human-decision-required'), true);
  assert.equal(isGateLabel(REGISTRY, 'human-decision-required'), false);
  assert.equal(classifyLabel(REGISTRY, 'human-decision-required'), 'brake');
});

test('classifyLabel: gate wins when a label carries both flags (mirrors the server)', () => {
  const both = [{ name: 'both', humanGate: true, brake: true }];
  assert.equal(classifyLabel(both, 'both'), 'gate');
});

test('classifyLabel: an unknown label is a plain agent label', () => {
  assert.equal(classifyLabel(REGISTRY, 'brand-new-label'), 'agent');
});
