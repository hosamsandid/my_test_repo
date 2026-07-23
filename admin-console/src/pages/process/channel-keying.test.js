import { test } from 'node:test';
import assert from 'node:assert/strict';

import { upsertChannel, removeChannelFrom, chLabelKey } from './channel-ops.js';

// #828 channel keying relaxation: (artifact, from) → (artifact, from, label) so a
// single producer can feed one consumer through differently-labelled channels
// (switch fan-in). These pure helpers are shared by the live + draft adapters.

test('chLabelKey normalizes label to trimmed string / empty', () => {
  assert.equal(chLabelKey('  approved '), 'approved');
  assert.equal(chLabelKey(''), '');
  assert.equal(chLabelKey(undefined), '');
  assert.equal(chLabelKey(null), '');
});

test('upsert: same (artifact, from) + different label adds a fan-in sibling', () => {
  let ch = upsertChannel([], { artifact: 'pr', from: 'rev', label: 'ready-to-merge' });
  ch = upsertChannel(ch, { artifact: 'pr', from: 'rev', label: 'revisions-required' });
  assert.equal(ch.length, 2);
  assert.deepEqual(ch.map(c => c.label), ['ready-to-merge', 'revisions-required']);
  assert.ok(ch.every(c => c.artifact === 'pr' && c.from === 'rev'));
});

test('upsert: same (artifact, from, label) edits in place (updates gate)', () => {
  let ch = upsertChannel([], { artifact: 'pr', from: 'rev', label: 'approved' });
  ch = upsertChannel(ch, { artifact: 'pr', from: 'rev', label: 'approved', gate: 'human' });
  assert.equal(ch.length, 1);
  assert.equal(ch[0].gate, 'human');
});

test('upsert: label-less channels still de-dupe on (artifact, from)', () => {
  let ch = upsertChannel([], { artifact: 'issue', from: 'ba' });
  ch = upsertChannel(ch, { artifact: 'issue', from: 'ba' });
  assert.equal(ch.length, 1);
  assert.equal(ch[0].label, undefined);
});

test('upsert: label-less and labelled from the same producer coexist', () => {
  let ch = upsertChannel([], { artifact: 'pr', from: 'rev' });
  ch = upsertChannel(ch, { artifact: 'pr', from: 'rev', label: 'ready-to-merge' });
  assert.equal(ch.length, 2);
});

test('remove: with a label drops only that fan-in sibling', () => {
  const list = [
    { artifact: 'pr', from: 'rev', label: 'ready-to-merge' },
    { artifact: 'pr', from: 'rev', label: 'revisions-required' },
  ];
  const next = removeChannelFrom(list, { artifact: 'pr', from: 'rev', label: 'ready-to-merge' });
  assert.equal(next.length, 1);
  assert.equal(next[0].label, 'revisions-required');
});

test('remove: label omitted entirely drops every (artifact, from) channel (legacy)', () => {
  const list = [
    { artifact: 'pr', from: 'rev', label: 'a' },
    { artifact: 'pr', from: 'rev', label: 'b' },
    { artifact: 'issue', from: 'rev', label: 'a' },
  ];
  const next = removeChannelFrom(list, { artifact: 'pr', from: 'rev' });
  assert.equal(next.length, 1);
  assert.equal(next[0].artifact, 'issue');
});

test('remove: empty-string label targets the label-less channel specifically', () => {
  const list = [
    { artifact: 'pr', from: 'rev' },
    { artifact: 'pr', from: 'rev', label: 'ready-to-merge' },
  ];
  const next = removeChannelFrom(list, { artifact: 'pr', from: 'rev', label: '' });
  assert.equal(next.length, 1);
  assert.equal(next[0].label, 'ready-to-merge');
});
