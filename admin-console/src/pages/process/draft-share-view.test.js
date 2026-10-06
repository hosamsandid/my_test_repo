import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LAST_HOLDER_HINT, DRAFT_GONE_MESSAGE,
  draftSubtitle, draftAccessTitle, accessRows, shareCandidates,
  removeState, deleteImpactNotice, isDraftGone, draftWriteError,
  filterCandidates, selectAllIds, pruneSelection, pickerState, shareResultNotice, bulkShareError,
  VISIBLE_TO_EVERYONE_CONFIRM, READ_ONLY_DRAFT_HINT, isReadOnlyDraft, duplicateDraftBody,
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

// ── #2870 Part A — multi-select picker ──────────────────────────────────────

const DIR = [
  { id: 'u-ann', displayName: 'Ann Archer', email: 'ann@example.com' },
  { id: 'u-ben', displayName: 'Ben Baker', email: 'ben@corp.io' },
  { id: 'u-cid', displayName: 'Cid Cole', email: 'cid@example.com' },
];

test('#2870 AC2 — the filter matches display name or email, case-insensitively', () => {
  assert.deepEqual(filterCandidates(DIR, 'ben').map(u => u.id), ['u-ben']);
  assert.deepEqual(filterCandidates(DIR, 'EXAMPLE.com').map(u => u.id), ['u-ann', 'u-cid']);
  assert.deepEqual(filterCandidates(DIR, '  ').length, 3, 'a blank filter lists everyone');
  assert.deepEqual(filterCandidates(null, 'x'), []);
});

test('#2870 AC3 — Select all selects only the filtered result, keeping prior ticks', () => {
  const sel = selectAllIds(new Set(['u-ben']), filterCandidates(DIR, 'example'));
  assert.deepEqual([...sel].sort(), ['u-ann', 'u-ben', 'u-cid']);
  const only = selectAllIds(new Set(), filterCandidates(DIR, 'ann'));
  assert.deepEqual([...only], ['u-ann']);
});

test('#2870 AC4 — the Share button names the count and is inert with nobody selected', () => {
  const none = pickerState({ candidates: DIR, visible: DIR, selected: new Set() });
  assert.equal(none.shareLabel, 'Share');
  assert.equal(none.shareDisabled, true);
  assert.equal(none.clearDisabled, true);
  assert.equal(none.selectAllDisabled, false);

  const some = pickerState({ candidates: DIR, visible: DIR, selected: new Set(['u-ann', 'u-ben']) });
  assert.equal(some.shareLabel, 'Share with 2');
  assert.equal(some.shareDisabled, false);
  assert.equal(some.clearDisabled, false);

  const busy = pickerState({ candidates: DIR, visible: DIR, selected: new Set(['u-ann']), busy: true });
  assert.equal(busy.shareDisabled, true);

  const all = pickerState({ candidates: DIR, visible: DIR, selected: new Set(DIR.map(u => u.id)) });
  assert.equal(all.selectAllDisabled, true, 'nothing left to add');
  assert.equal(pickerState().shareDisabled, true, 'no argument must not throw');
});

test('#2870 edge — everyone already has access: empty state, Share stays disabled', () => {
  const st = pickerState({ candidates: [], visible: [], selected: new Set() });
  assert.match(st.emptyText, /Everyone already has access/);
  assert.equal(st.shareDisabled, true);
  assert.equal(st.selectAllDisabled, true);
  assert.equal(st.filterDisabled, true);
  const nomatch = pickerState({ candidates: DIR, visible: [], query: 'zz' });
  assert.match(nomatch.emptyText, /No colleague matches “zz”/);
});

test('#2870 edge — a colleague who left the candidates drops out of the selection', () => {
  const pruned = pruneSelection(new Set(['u-ann', 'u-gone']), DIR);
  assert.deepEqual([...pruned], ['u-ann']);
});

test('#2870 AC5 — the success notice counts what changed, not the selection', () => {
  assert.equal(shareResultNotice({ added: 3, skipped: 0 }), 'Shared with 3 people.');
  assert.equal(shareResultNotice({ added: 1, skipped: 2 }), 'Shared with 1 person. 2 already had access.');
  assert.equal(shareResultNotice({}), 'Shared with 0 people.');
});

test('#2870 AC6 — a refused bulk share says nothing changed and asks for a reload', () => {
  const gone = bulkShareError({ status: 400, code: 'unknown_user', message: '1 selected person no longer has an account. Nothing was shared.' });
  assert.equal(gone.reload, true);
  assert.match(gone.message, /Nothing was shared/);
  const other = bulkShareError({ status: 500 });
  assert.equal(other.reload, false);
  assert.match(other.message, /Nothing was changed/);
  assert.equal(bulkShareError({ status: 404 }).message, draftWriteError({ status: 404 }));
});

// ── #2870 Part B — "Visible to everyone" ────────────────────────────────────

test('#2870 AC12 — a global draft is marked instead of private / shared', () => {
  assert.equal(
    draftSubtitle({ roleCount: 2, shared: true, accessCount: 4, visibleToEveryone: true, canEdit: true, createdByYou: true }),
    '2 agents · Visible to everyone',
  );
  assert.equal(
    draftSubtitle({ roleCount: 1, visibleToEveryone: true, canEdit: false, createdByName: 'Ann Archer' }),
    '1 agent · Visible to everyone · read-only · by Ann Archer',
  );
  assert.match(draftAccessTitle({ visibleToEveryone: true, canEdit: false }), /not change it/);
  assert.match(draftAccessTitle({ visibleToEveryone: true, canEdit: true }), /read-only for them/);
  assert.equal(draftSubtitle({ roleCount: 0, visibleToEveryone: 'yes' }), '0 agents · private', 'strictly true only');
});

test('#2870 AC8 — the confirmation names current AND future users', () => {
  assert.match(VISIBLE_TO_EVERYONE_CONFIRM, /today/);
  assert.match(VISIBLE_TO_EVERYONE_CONFIRM, /later/);
  assert.match(VISIBLE_TO_EVERYONE_CONFIRM, /cannot edit, rename, delete or share/);
});

test('#2870 AC10 — the editor is read-only only when the server says so', () => {
  assert.equal(isReadOnlyDraft({ viewerCanEdit: false }), true);
  assert.equal(isReadOnlyDraft({ viewerCanEdit: true }), false);
  assert.equal(isReadOnlyDraft({}), false, 'an older server keeps today\'s editable canvas');
  assert.equal(isReadOnlyDraft(null), false);
  assert.match(READ_ONLY_DRAFT_HINT, /Duplicate/);
});

test('#2870 AC10 — Duplicate makes a clean private copy', () => {
  const body = duplicateDraftBody({
    id: 'plan', name: 'Plan', roles: [{ id: 'dev' }], copilot: { messages: [] },
    createdBy: 'u-ann', accessUserIds: ['u-ann'], visibleToEveryone: true, viewerCanEdit: false,
    createdAt: 'x', updatedAt: 'y',
  });
  assert.equal(body.name, 'Plan (copy)');
  assert.equal(body.processTemplate.name, 'Plan (copy)');
  assert.deepEqual(body.processTemplate.roles, [{ id: 'dev' }]);
  for (const f of ['id', 'copilot', 'createdBy', 'accessUserIds', 'visibleToEveryone', 'viewerCanEdit', 'createdAt', 'updatedAt']) {
    assert.equal(f in body.processTemplate, false, `${f} must not travel into the copy`);
  }
  assert.equal(duplicateDraftBody(null).name, 'Untitled flow (copy)');
});

test('#2870 AC15 — an export never carries the visibility flag or the read annotation', async () => {
  const { portableBundle } = await import('./bundle-download.js');
  const out = portableBundle({ name: 'P', roles: [], visibleToEveryone: true, viewerCanEdit: false, createdBy: 'u', accessUserIds: ['u'] });
  assert.deepEqual(out, { name: 'P', roles: [] });
});
