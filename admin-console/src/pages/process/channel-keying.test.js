import { test } from 'node:test';
import assert from 'node:assert/strict';

import { upsertChannel, removeChannelFrom, chLabelKey, hasChannel } from './channel-ops.js';

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

test('upsert: an authored wakePrompt override is carried on the port, trimmed (#868)', () => {
  const ch = upsertChannel([], { artifact: 'pr', from: 'dev', wakePrompt: '  Review carefully.  ' });
  assert.equal(ch[0].wakePrompt, 'Review carefully.');
});

test('upsert: a blank wakePrompt is dropped from the port (#868)', () => {
  const ch = upsertChannel([], { artifact: 'pr', from: 'dev', wakePrompt: '   ' });
  assert.ok(!('wakePrompt' in ch[0]), 'a whitespace-only override is treated as no override');
});

test('upsert: re-drawing the same channel can clear a prior wakePrompt (#868)', () => {
  let ch = upsertChannel([], { artifact: 'pr', from: 'dev', wakePrompt: 'Custom.' });
  ch = upsertChannel(ch, { artifact: 'pr', from: 'dev' }); // same key, no override
  assert.equal(ch.length, 1);
  assert.ok(!('wakePrompt' in ch[0]), 'an in-place edit without an override clears the stale one');
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

// ─── claim opt-out on the port (#958) ────────────────────────────────────────

test('upsertChannel persists only an explicit autoClaim:false', () => {
  const base = { artifact: 'pr', from: 'dev', label: 'ready-for-test' };
  // Default (auto-claim ON) leaves the port clean — no `autoClaim: true` noise.
  assert.deepEqual(upsertChannel([], base), [base]);
  assert.deepEqual(upsertChannel([], { ...base, autoClaim: true }), [base]);
  assert.deepEqual(upsertChannel([], { ...base, autoClaim: undefined }), [base]);
  // Opt-out is recorded, since the reconciler must see it to skip the claim.
  assert.deepEqual(upsertChannel([], { ...base, autoClaim: false }),
    [{ ...base, autoClaim: false }]);
});

test('upsertChannel toggles the claim opt-out in place, on the same (artifact, from, label) key', () => {
  // The editor toggle is an upsert on the existing port, not a new sibling.
  const off = upsertChannel([{ artifact: 'pr', from: 'dev', label: 'go' }],
    { artifact: 'pr', from: 'dev', label: 'go', autoClaim: false });
  assert.equal(off.length, 1);
  assert.equal(off[0].autoClaim, false);
  const on = upsertChannel(off, { artifact: 'pr', from: 'dev', label: 'go' });
  assert.equal(on.length, 1);
  assert.equal('autoClaim' in on[0], false, 're-enabling must clear the flag, not set it true');
});

test('upsertChannel keeps the claim opt-out independent per label sibling', () => {
  let list = upsertChannel([], { artifact: 'pr', from: 'dev', label: 'a', autoClaim: false });
  list = upsertChannel(list, { artifact: 'pr', from: 'dev', label: 'b' });
  assert.equal(list.length, 2);
  assert.equal(list.find(c => c.label === 'a').autoClaim, false);
  assert.equal('autoClaim' in list.find(c => c.label === 'b'), false);
});

test('#2578: upsertChannel drops a legacy transport key instead of persisting it', () => {
  // A caller passing transport (a stale client) writes no transport field.
  assert.deepEqual(
    upsertChannel([], { artifact: 'pr', from: 'rev', label: 'approved', transport: 'internal' }),
    [{ artifact: 'pr', from: 'rev', label: 'approved' }]);
  // Re-saving a legacy port that still carries it (e.g. `{ ...c, autoClaim }`)
  // rewrites the entry without the key.
  const out = upsertChannel([{ artifact: 'pr', from: 'rev', label: 'go', transport: 'internal' }],
    { artifact: 'pr', from: 'rev', label: 'go', transport: 'internal', autoClaim: false });
  assert.deepEqual(out, [{ artifact: 'pr', from: 'rev', label: 'go', autoClaim: false }]);
});

// #2665: the create dialog marks a re-drawn channel as existing.
test('hasChannel matches the full (artifact, from, label) key', () => {
  const list = [
    { artifact: 'pr', from: 'dev' },
    { artifact: 'pr', from: 'rev', label: 'ready-to-merge' },
  ];
  assert.equal(hasChannel(list, { artifact: 'pr', from: 'dev', label: '' }), true);
  assert.equal(hasChannel(list, { artifact: 'pr', from: 'dev', label: '  ' }), true);
  assert.equal(hasChannel(list, { artifact: 'pr', from: 'dev', label: 'approved' }), false);
  assert.equal(hasChannel(list, { artifact: 'issue', from: 'dev', label: '' }), false);
  assert.equal(hasChannel(list, { artifact: 'pr', from: 'rev', label: ' ready-to-merge ' }), true);
  assert.equal(hasChannel(list, { artifact: 'pr', from: 'other', label: '' }), false);
  assert.equal(hasChannel(undefined, { artifact: 'pr', from: 'dev', label: '' }), false);
});
