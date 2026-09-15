import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADD_MEMBER_TITLE, MATERIALIZE_NOW_DEFAULT, MATERIALIZE_NOW_HINT, MATERIALIZE_NOW_LABEL,
  addMemberBody, addMemberConfirmLabel, addMemberNotice,
} from './add-member-view.js';

// ------------------------------------------------------------- the default

test('#1958 AC1: the checkbox defaults to ON, so pressing straight through materializes', () => {
  assert.equal(MATERIALIZE_NOW_DEFAULT, true);
  assert.deepEqual(addMemberBody(), { materialize: true });
  // …and an opened-but-untouched dialog produces the pre-#1958 request.
  assert.deepEqual(addMemberBody({ materializeNow: MATERIALIZE_NOW_DEFAULT }), { materialize: true });
});

// ---------------------------------------------------------------- the body

test('#1958 AC2: unticking the box asks for a stub', () => {
  assert.deepEqual(addMemberBody({ materializeNow: false }), { materialize: false });
});

test('the preference is always sent explicitly, and only `false` defers', () => {
  // The server rejects a non-boolean (AC5), so the body must never carry one
  // even if the checkbox state arrives as something odd.
  for (const truthy of [true, undefined, null, 'x', 1]) {
    const body = addMemberBody({ materializeNow: truthy });
    assert.equal(typeof body.materialize, 'boolean', `${JSON.stringify(truthy)} → non-boolean`);
    assert.equal(body.materialize, true);
  }
  assert.equal(addMemberBody({ materializeNow: false }).materialize, false);
  // Explicit in both modes: the key is present whichever way the box was left,
  // so one request shape is exercised (mirrors buildLaunchBody).
  assert.ok('materialize' in addMemberBody({ materializeNow: true }));
  assert.ok('materialize' in addMemberBody({ materializeNow: false }));
});

// --------------------------------------------------------- the button label

test('the primary action names the mode it will run in', () => {
  assert.equal(addMemberConfirmLabel({ materializeNow: true }), 'Add member');
  assert.equal(addMemberConfirmLabel({ materializeNow: false }), 'Add member (stub)');
  assert.equal(addMemberConfirmLabel(), 'Add member');
});

test('busy wins over the mode — an in-flight request has one label', () => {
  assert.equal(addMemberConfirmLabel({ busy: true, materializeNow: true }), 'Adding…');
  assert.equal(addMemberConfirmLabel({ busy: true, materializeNow: false }), 'Adding…');
});

// -------------------------------------------------------------- the notice

test('the notice reports the mode the SERVER ran in, not the one we asked for', () => {
  // Stub create: the orchestrator returns materialized:false explicitly.
  const stub = addMemberNotice({ id: 'team1-reviewer', materialized: false });
  assert.match(stub, /team1-reviewer/);
  assert.match(stub, /stub/i);
  assert.match(stub, /Not materialized yet/);
  assert.doesNotMatch(stub, /started/, 'a stub has no container — it cannot have started');
});

test('an ABSENT materialized flag is read as the backend default, never guessed as a stub', () => {
  // The materializing branch of addTeamMember returns { id, userId, seeded,
  // warnings, clones } — no `materialized` key at all. Reading that as a stub
  // would tell the user nothing ran when in fact a repo was cloned.
  const live = addMemberNotice({ id: 'team1-reviewer', userId: '@team1-reviewer:x', seeded: true });
  assert.match(live, /team1-reviewer/);
  assert.match(live, /added and started/);
  assert.doesNotMatch(live, /stub/i);
});

test('the notice survives a payload with no id', () => {
  assert.match(addMemberNotice({}), /Member/);
  assert.match(addMemberNotice(undefined), /Member/);
  assert.match(addMemberNotice({ materialized: false }), /stub/i);
});

// #2308 AC18: a plugin (or clone/skill) sync failure is surfaced to the human
// who performed the add — not silently dropped from the toast.
test('warnings (e.g. a plugin that could not be installed) are appended, not dropped', () => {
  const withWarning = addMemberNotice({
    id: 'team1-reviewer',
    userId: '@team1-reviewer:x',
    seeded: true,
    warnings: ["plugin 'github-issues' could not be installed for 'team1-reviewer': ECONNREFUSED"],
  });
  assert.match(withWarning, /team1-reviewer/);
  assert.match(withWarning, /added and started/);
  assert.match(withWarning, /github-issues.*could not be installed/);
});

test('no warnings key, or an empty one, changes nothing', () => {
  const bare = addMemberNotice({ id: 'm', seeded: true });
  const empty = addMemberNotice({ id: 'm', seeded: true, warnings: [] });
  assert.equal(bare, empty);
  assert.doesNotMatch(bare, /undefined|null/);
});

// ----------------------------------------------------------------- the copy

test('the checkbox copy states both halves of the trade — and the stub costs', () => {
  assert.equal(MATERIALIZE_NOW_LABEL, 'Materialize now');
  assert.match(MATERIALIZE_NOW_HINT, /[Cc]lones the repository/);
  assert.match(MATERIALIZE_NOW_HINT, /stub/);
  // The stub half must name where the member then IS, or the create looks lost:
  // it lands in a collapsed section (#1957), not in the main member list.
  assert.match(MATERIALIZE_NOW_HINT, /Not materialized yet/);
  assert.equal(ADD_MEMBER_TITLE, 'Add member');
});
