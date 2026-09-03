import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMPORT_BRIEFINGS_COPY,
  normalizeMissionPath,
  defaultMissionPath,
  importCandidates,
  importSubmitState,
  importRequestBody,
  importErrorText,
} from './import-briefings-view.js';

/* ── AC4: the wording makes clear this is a migration aid ─────────────── */

test('every user-facing string that introduces the action says "migration"', () => {
  // AC4's whole point: a reader who never used BriefingPacks meets this button
  // next to the ordinary flow import and must not read it as a second one.
  for (const key of ['tooltip', 'lead']) {
    assert.match(IMPORT_BRIEFINGS_COPY[key], /migration/i, `${key} does not say what this is for`);
  }
  // …and the lead says which direction the copy goes, since a one-way read is
  // the property that makes it safe to run on a live pack tree.
  assert.match(IMPORT_BRIEFINGS_COPY.lead, /one-way|nothing is written back/i);
  assert.match(IMPORT_BRIEFINGS_COPY.lead, /retired/i, 'the lead must say the model is going away');
});

test('the action and confirm labels name the artifact on both sides', () => {
  assert.match(IMPORT_BRIEFINGS_COPY.action, /BriefingPack/);
  assert.match(IMPORT_BRIEFINGS_COPY.confirm, /draft/i);
  // The trailing ellipsis is the console's "a dialog follows" convention.
  assert.match(IMPORT_BRIEFINGS_COPY.action, /…$/);
});

/* ── path normalization ───────────────────────────────────────────────── */

test('normalizeMissionPath trims and strips wrapping slashes', () => {
  assert.equal(normalizeMissionPath('  /repo/briefings/  '), 'repo/briefings');
  assert.equal(normalizeMissionPath('repo'), 'repo');
  assert.equal(normalizeMissionPath('///'), '');
  assert.equal(normalizeMissionPath(''), '');
  assert.equal(normalizeMissionPath(null), '');
  assert.equal(normalizeMissionPath(undefined), '');
});

test('defaultMissionPath reads a leftover briefingsPath, normalized', () => {
  // The field that wrote it went in #1964, but the epic's hard cut leaves the
  // value on existing configs — it is the only guess available and pre-filling
  // it is what makes the migration one click.
  assert.equal(defaultMissionPath({ briefingsPath: '/repo/' }), 'repo');
  assert.equal(defaultMissionPath({}), '');
  assert.equal(defaultMissionPath(null), '');
});

/* ── the candidate list ───────────────────────────────────────────────── */

test('agents carrying a leftover briefingsPath sort first', () => {
  const rows = importCandidates([
    { id: 'zeta', displayName: 'Zeta', role: 'agent' },
    { id: 'alpha', displayName: 'Alpha', role: 'agent' },
    { id: 'mission', displayName: 'Mission', role: 'agent', briefingsPath: 'work/repo' },
  ]);
  assert.deepEqual(rows.map(r => r.id), ['mission', 'alpha', 'zeta']);
  assert.equal(rows[0].likely, true);
  assert.equal(rows[0].path, 'work/repo');
  assert.equal(rows[1].likely, false);
  assert.equal(rows[1].path, '');
});

test('the picker is NOT filtered by the retired orchestrator role', () => {
  // Filtering on `role === 'orchestrator'` is exactly the thing this epic
  // removes, and it would hide a workspace whose packs were moved onto an
  // ordinary agent — the migration case this action exists for.
  const rows = importCandidates([
    { id: 'plain', displayName: 'Plain', role: 'agent' },
    { id: 'member', displayName: 'Member', role: 'team-member' },
  ]);
  assert.deepEqual(rows.map(r => r.id).sort(), ['member', 'plain']);
});

test('a team agent is excluded — it hosts no workspace of its own', () => {
  const rows = importCandidates([
    { id: 'squad', displayName: 'Squad', role: 'team' },
    { id: 'plain', displayName: 'Plain', role: 'agent' },
  ]);
  assert.deepEqual(rows.map(r => r.id), ['plain']);
});

test('rows fall back to the id when there is no display name, and junk is dropped', () => {
  const rows = importCandidates([null, {}, { id: '' }, { id: 'bare' }]);
  assert.deepEqual(rows, [{ id: 'bare', label: 'bare', path: '', likely: false }]);
});

test('importCandidates tolerates a not-yet-loaded agents payload', () => {
  assert.deepEqual(importCandidates(null), []);
  assert.deepEqual(importCandidates(undefined), []);
  assert.deepEqual(importCandidates('nope'), []);
});

test('a still-loading agent list has copy of its own, distinct from "none"', () => {
  // Both states produce an empty candidate list, but they mean opposite things
  // — one resolves by waiting, the other never will — so the action is held
  // with this sentence rather than opened onto "no agent workspace available".
  assert.match(IMPORT_BRIEFINGS_COPY.loading, /loading|waiting/i);
  assert.notEqual(IMPORT_BRIEFINGS_COPY.loading, IMPORT_BRIEFINGS_COPY.tooltip);
});

/* ── the submit gate ──────────────────────────────────────────────────── */

test('the confirm button is disabled with a reason until an agent is picked', () => {
  const none = importSubmitState({ agentId: '' });
  assert.equal(none.disabled, true);
  assert.match(none.hint, /Pick the agent/);

  const busy = importSubmitState({ agentId: 'a', busy: true });
  assert.equal(busy.disabled, true);
  assert.equal(busy.hint, IMPORT_BRIEFINGS_COPY.busy);

  assert.deepEqual(importSubmitState({ agentId: 'a' }), { disabled: false, hint: null });
  assert.equal(importSubmitState().disabled, true, 'no state at all is not submittable');
});

/* ── the request body ─────────────────────────────────────────────────── */

test('the body carries agentId + a normalized relative path', () => {
  assert.deepEqual(
    importRequestBody({ agentId: 'mission', path: '/work/repo/', label: 'Mission' }),
    { agentId: 'mission', name: 'Mission (imported BriefingPacks)', path: 'work/repo' },
  );
});

test('an empty path is OMITTED rather than sent as an empty string', () => {
  // Absence means "the agent root", the same convention the sibling workspace
  // handlers use for their `?path=` query parameter.
  const body = importRequestBody({ agentId: 'mission', path: '   ', label: 'Mission' });
  assert.deepEqual(body, { agentId: 'mission', name: 'Mission (imported BriefingPacks)' });
  assert.ok(!('path' in body));
});

test('the draft name says the packs are where it came from', () => {
  // The old name was "<agent> (imported)", indistinguishable from a flow-file
  // import once it is sitting in the Drafts list.
  assert.match(importRequestBody({ agentId: 'a', label: 'A' }).name, /BriefingPacks/);
  assert.match(importRequestBody({ agentId: 'a' }).name, /^a \(/, 'falls back to the id');
});

test('no agent yields no body — the caller must not have submitted', () => {
  assert.equal(importRequestBody({ agentId: '' }), null);
  assert.equal(importRequestBody({}), null);
  assert.equal(importRequestBody(), null);
});

/* ── error copy ───────────────────────────────────────────────────────── */

test('the error line keeps the server sentence — it names what to fix', () => {
  // The route answers a missing directory / an unresolvable pack id / a refused
  // path with a specific message; swallowing it would leave the user guessing.
  assert.equal(
    importErrorText(new Error("No BriefingPacks found: 'artifacts/briefings' does not exist")),
    "Import failed: No BriefingPacks found: 'artifacts/briefings' does not exist",
  );
  assert.match(importErrorText(null), /unknown error/);
  assert.match(importErrorText('plain string'), /plain string/);
});
