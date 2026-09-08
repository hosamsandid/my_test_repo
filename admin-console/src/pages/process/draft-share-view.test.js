import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LAST_HOLDER_HINT, DRAFT_GONE_MESSAGE,
  draftSubtitle, draftAccessTitle, accessRows, shareCandidates, addControlState,
  removeState, deleteImpactNotice, isDraftGone, draftWriteError,
} from './draft-share-view.js';

// Pure client decisions for draft sharing (#2068). The theme running through
// these is DD2: nothing here may take a different branch for the creator.

const ALICE = { id: 'u-alice', displayName: 'Alice A', email: 'alice@x' };
const BOB = { id: 'u-bob', displayName: 'Bob B', email: 'bob@x' };
const CAROL = { id: 'u-carol', displayName: 'Carol C', email: '' };

// ── AC16: the row ───────────────────────────────────────────────────────────

test('a private draft says so, and does not name a creator who is you', () => {
  const sub = draftSubtitle({ roleCount: 2, shared: false, accessCount: 1, createdByYou: true, createdByName: 'Alice A' });
  assert.equal(sub, '2 agents · private');
});

test('a shared draft says how many people have it, and who made it', () => {
  const sub = draftSubtitle({ roleCount: 1, shared: true, accessCount: 3, createdByYou: false, createdByName: 'Alice A' });
  assert.equal(sub, '1 agent · shared with 3 people · by Alice A');
});

test('a creator that could not be resolved simply is not mentioned', () => {
  // `createdByName` is null for an ownerless (env-admin) draft; the row must not
  // invent "by unknown" and must never print an id.
  const sub = draftSubtitle({ roleCount: 0, shared: false, createdByYou: false, createdByName: null });
  assert.equal(sub, '0 agents · private');
});

test('a malformed entry degrades rather than throwing', () => {
  for (const bad of [undefined, null, {}, { roleCount: 'two' }]) {
    assert.match(draftSubtitle(bad), /^0 agents · private$/);
    assert.equal(typeof draftAccessTitle(bad), 'string');
  }
});

test('the row title spells out what shared actually means', () => {
  assert.match(draftAccessTitle({ shared: false }), /Private to you/);
  const shared = draftAccessTitle({ shared: true, accessCount: 2 });
  assert.match(shared, /2 people/);
  assert.match(shared, /delete/, 'the row hint must not undersell equal rights');
});

// ── the access list ─────────────────────────────────────────────────────────

test('the viewer is marked, and that marker is not a privilege', () => {
  const rows = accessRows([ALICE, BOB], 'u-bob');
  assert.deepEqual(rows.map(r => r.you), [false, true]);
  assert.deepEqual(rows.map(r => r.label), ['Alice A', 'Bob B']);
  assert.equal(rows[1].email, 'bob@x');
  // No row carries anything the other does not — nothing is owner-shaped.
  assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(rows[1]).sort());
});

test('a person already holding access is not offered again', () => {
  assert.deepEqual(shareCandidates([ALICE, BOB, CAROL], [ALICE]), [BOB, CAROL]);
  assert.deepEqual(shareCandidates([ALICE], [ALICE]), []);
  assert.deepEqual(shareCandidates(null, null), []);
});

test('the add control says why it is inert rather than just being grey', () => {
  const none = addControlState({ candidates: [], selectedId: '', busy: false });
  assert.match(none.placeholder, /Everyone already has access/);
  assert.equal(none.disabled, true);

  const unpicked = addControlState({ candidates: [BOB], selectedId: '', busy: false });
  assert.match(unpicked.placeholder, /Select a colleague/);
  assert.equal(unpicked.disabled, true);

  assert.equal(addControlState({ candidates: [BOB], selectedId: 'u-bob' }).disabled, false);
  assert.equal(addControlState({ candidates: [BOB], selectedId: 'u-bob', busy: true }).disabled, true);
  assert.equal(addControlState().disabled, true, 'no argument at all must not throw');
});

// ── AC9 ─────────────────────────────────────────────────────────────────────

test('AC9 — the last holder is told why, not silently refused by the server', () => {
  const solo = removeState([ALICE], 'u-alice');
  assert.equal(solo.disabled, true);
  assert.equal(solo.hint, LAST_HOLDER_HINT);
  assert.match(solo.hint, /Delete the draft/i);
});

test('AC9 — with two holders, either may be removed, including yourself', () => {
  assert.deepEqual(removeState([ALICE, BOB], 'u-alice'), { disabled: false, hint: '' });
  assert.deepEqual(removeState([ALICE, BOB], 'u-bob'), { disabled: false, hint: '' });
});

test('the rule is on the set, not on who is asking', () => {
  // removeState is not told the viewer at all, which is what makes the client
  // incapable of drawing an owner-only variant.
  assert.equal(removeState.length, 2);
  assert.equal(removeState([ALICE], 'u-nobody').disabled, true);
});

// ── AC13 ────────────────────────────────────────────────────────────────────

test('AC13 — the delete confirmation names the other people who lose it', () => {
  assert.equal(
    deleteImpactNotice([ALICE, BOB], 'u-alice'),
    'Bob B also has access and will lose this draft.',
  );
  assert.equal(
    deleteImpactNotice([ALICE, BOB, CAROL], 'u-alice'),
    'Bob B and Carol C also have access and will lose this draft.',
  );
});

test('AC13 — a private draft adds nothing to the confirmation', () => {
  assert.equal(deleteImpactNotice([ALICE], 'u-alice'), null);
  assert.equal(deleteImpactNotice([], 'u-alice'), null);
  assert.equal(deleteImpactNotice(null, 'u-alice'), null);
});

test('AC13 — the notice does not depend on the viewer being the creator', () => {
  // Bob, who was shared with, gets the same warning about Alice.
  assert.equal(
    deleteImpactNotice([ALICE, BOB], 'u-bob'),
    'Alice A also has access and will lose this draft.',
  );
});

// ── AC17 ────────────────────────────────────────────────────────────────────

test('AC17 — a 404 on a draft write reads as a sentence, not as a status', () => {
  const gone = Object.assign(new Error('Draft not found'), { status: 404 });
  assert.equal(isDraftGone(gone), true);
  assert.equal(draftWriteError(gone), DRAFT_GONE_MESSAGE);
  assert.match(DRAFT_GONE_MESSAGE, /no longer available/i);
  assert.match(DRAFT_GONE_MESSAGE, /not saved/i, 'the reader must know the edit was lost');
});

test('AC17 — every other failure keeps the server\'s own words', () => {
  const other = Object.assign(new Error('Invalid processTemplate: roles'), { status: 400 });
  assert.equal(draftWriteError(other), 'Invalid processTemplate: roles');
  assert.equal(isDraftGone(other), false);
  assert.equal(draftWriteError(null, 'Save failed.'), 'Save failed.');
  assert.equal(isDraftGone(undefined), false);
});
