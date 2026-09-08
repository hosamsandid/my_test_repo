import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLE_ADMIN, ROLE_MEMBER, ROLE_OPTIONS, ROLE_LABELS, ROLE_HINTS,
  READ_ONLY_NOTICE, SUCCESSOR_NOTICE, SOLE_MEMBER_NOTICE, NO_CANDIDATES_NOTICE,
  canManageMembers, directoryIndex, memberRows, shareCandidates, filterCandidates,
  candidateLabel, addControlState, adminCount, handoverRequirement,
  removeState, roleChangeState, setRoleRequest, removeRequest, shareSubtitle,
  membershipWriteError,
} from './team-share-view.js';

// Pure client decisions for the team Share panel (#2082, #2041 AC8–AC10).
// Two themes run through these: the read/write split (a Team Member may READ
// the member list — D9 — so nothing may gate the list on `canManageTeam`), and
// D4 (the last Team Admin cannot simply leave).

const ALICE = { id: 'u-alice', displayName: 'Alice A', email: 'alice@corp' };
const BOB = { id: 'u-bob', displayName: 'Bob B', email: 'bob@corp' };
const CAROL = { id: 'u-carol', displayName: 'Carol C', email: '' };
const DIRECTORY = [BOB, ALICE, CAROL];

const admin = userId => ({ id: `m-${userId}`, userId, teamId: 't1', role: ROLE_ADMIN });
const member = userId => ({ id: `m-${userId}`, userId, teamId: 't1', role: ROLE_MEMBER });

// ── The client mirror of canManageTeam ──────────────────────────────────────

test('canManageMembers mirrors canManageTeam: admin, or Team Admin of THIS team', () => {
  const teamAdmin = { userId: 'u-alice', admin: false, teams: [{ teamId: 't1', role: ROLE_ADMIN }] };
  const plainMember = { userId: 'u-bob', admin: false, teams: [{ teamId: 't1', role: ROLE_MEMBER }] };
  const otherTeamAdmin = { userId: 'u-carol', admin: false, teams: [{ teamId: 't2', role: ROLE_ADMIN }] };

  assert.equal(canManageMembers(teamAdmin, 't1'), true);
  assert.equal(canManageMembers(plainMember, 't1'), false, 'D9 — a member changes nothing');
  assert.equal(canManageMembers(otherTeamAdmin, 't1'), false, 'admin of another team is not admin here');
  assert.equal(canManageMembers({ admin: true, teams: [] }, 't1'), true, 'scope.all short-circuit');
});

test('canManageMembers fails closed on a missing session or team id', () => {
  assert.equal(canManageMembers(null, 't1'), false);
  assert.equal(canManageMembers({ admin: true }, ''), false, 'no team id is not "any team"');
  assert.equal(canManageMembers({ teams: null }, 't1'), false);
});

// ── AC10: the open directory, name + email ONLY ─────────────────────────────

test('the directory projection carries display name and email and nothing else', () => {
  // The route strips the rest, but a widened payload must not reach the DOM.
  const leaky = [{
    id: 'u-alice', displayName: 'Alice A', email: 'alice@corp',
    systemAdmin: true, githubHandle: 'alice-gh', hasPassword: true, subject: 'alice@sso',
  }];
  const entry = directoryIndex(leaky).get('u-alice');
  assert.deepEqual(Object.keys(entry).sort(), ['displayName', 'email', 'id']);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'systemAdmin'), false, 'D2');
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'githubHandle'), false, 'D11');
});

test('a member row never carries an admin indicator either', () => {
  // The edge case: "searching returns a System Admin user → shown as a normal
  // person". It falls out of the projection, so assert it on the ROW too.
  const rows = memberRows([admin('u-alice')], [{ ...ALICE, systemAdmin: true }], null);
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'systemAdmin'), false);
  assert.equal(rows[0].label, 'Alice A');
  assert.equal(rows[0].role, ROLE_ADMIN, 'the TEAM role is shown — that is not the sysadmin flag');
});

test('candidateLabel is name + email, and drops the dash when there is no email', () => {
  assert.equal(candidateLabel(ALICE), 'Alice A — alice@corp');
  assert.equal(candidateLabel(CAROL), 'Carol C');
  assert.equal(candidateLabel(null), '');
});

// ── The member list ─────────────────────────────────────────────────────────

test('member rows resolve names from the directory, sorted, with "you" marked', () => {
  const rows = memberRows([member('u-bob'), admin('u-alice')], DIRECTORY, 'u-bob');
  assert.deepEqual(rows.map(r => r.label), ['Alice A', 'Bob B'], 'sorted by display name');
  assert.deepEqual(rows.map(r => r.role), [ROLE_ADMIN, ROLE_MEMBER]);
  assert.deepEqual(rows.map(r => r.you), [false, true]);
  assert.equal(rows[0].email, 'alice@corp');
});

test('a membership whose user record is gone is shown, not dropped', () => {
  // Hiding it would hide the reason a hand-over is being demanded.
  const rows = memberRows([admin('u-ghost'), member('u-bob')], DIRECTORY, null);
  const ghost = rows.find(r => r.userId === 'u-ghost');
  assert.ok(ghost, 'the row survives');
  assert.equal(ghost.known, false);
  assert.equal(ghost.label, 'Unknown user');
  assert.equal(adminCount(rows), 1, 'and it still counts as an admin');
});

test('an unrecognised role reads as the LESS powerful one', () => {
  const rows = memberRows([{ id: 'm1', userId: 'u-bob', role: 'owner' }], DIRECTORY, null);
  assert.equal(rows[0].role, ROLE_MEMBER, 'never guess a role up');
});

test('memberRows tolerates junk input', () => {
  assert.deepEqual(memberRows(null, null, null), []);
  assert.deepEqual(memberRows([null, {}, { userId: '' }], DIRECTORY, null), []);
});

test('shareSubtitle counts people and admins, singular and plural', () => {
  assert.equal(shareSubtitle([]), 'Nobody has access yet.');
  assert.equal(shareSubtitle(memberRows([admin('u-alice')], DIRECTORY, null)), '1 person · 1 Team Admin');
  assert.equal(
    shareSubtitle(memberRows([admin('u-alice'), admin('u-bob'), member('u-carol')], DIRECTORY, null)),
    '3 people · 2 Team Admins',
  );
});

// ── AC10: the picker offers existing accounts only ──────────────────────────

test('candidates are the directory minus the people already on the team', () => {
  const rows = memberRows([admin('u-alice')], DIRECTORY, null);
  const cands = shareCandidates(DIRECTORY, rows);
  assert.deepEqual(cands.map(c => c.id), ['u-bob', 'u-carol'], 'sorted, Alice excluded');
});

test('the search filters on name and email, case-insensitively, never on the id', () => {
  const cands = shareCandidates(DIRECTORY, []);
  assert.deepEqual(filterCandidates(cands, 'ALICE').map(c => c.id), ['u-alice']);
  assert.deepEqual(filterCandidates(cands, 'bob@corp').map(c => c.id), ['u-bob']);
  assert.deepEqual(filterCandidates(cands, 'u-carol'), [], 'an id is not something a colleague knows');
  assert.equal(filterCandidates(cands, '   ').length, 3, 'a blank query filters nothing');
});

test('the Add control states its own reason for being inert', () => {
  const cands = shareCandidates(DIRECTORY, []);
  assert.deepEqual(
    addControlState({ candidates: cands, selectedId: 'u-bob' }),
    { placeholder: 'Select a colleague to add…', disabled: false, notice: '' },
  );
  assert.equal(addControlState({ candidates: cands, selectedId: '' }).disabled, true, 'nothing picked');
  assert.equal(addControlState({ candidates: cands, selectedId: 'u-bob', busy: true }).disabled, true);

  const noMatch = addControlState({ candidates: cands, selectedId: 'u-bob', query: 'zzz' });
  assert.equal(noMatch.disabled, true);
  assert.match(noMatch.placeholder, /No match/);

  // D3: everyone is in already — say why, rather than showing an empty picker.
  const exhausted = addControlState({ candidates: [], selectedId: '' });
  assert.equal(exhausted.placeholder, 'Everyone already has access');
  assert.equal(exhausted.notice, NO_CANDIDATES_NOTICE);
  assert.match(exhausted.notice, /System Admin/, 'D3 — names the step that does exist');
});

// ── D4: the last-admin hand-over ────────────────────────────────────────────

test('removing an ordinary member, or a co-admin, needs no successor', () => {
  const rows = memberRows([admin('u-alice'), admin('u-bob'), member('u-carol')], DIRECTORY, null);
  assert.equal(handoverRequirement({ rows, userId: 'u-carol', action: 'remove' }).kind, 'none');
  assert.equal(handoverRequirement({ rows, userId: 'u-alice', action: 'remove' }).kind, 'none');
});

test('removing the LAST admin demands a successor, offered from the team only', () => {
  const rows = memberRows([admin('u-alice'), member('u-bob'), member('u-carol')], DIRECTORY, null);
  const req = handoverRequirement({ rows, userId: 'u-alice', action: 'remove' });
  assert.equal(req.kind, 'successor');
  assert.equal(req.notice, SUCCESSOR_NOTICE);
  assert.deepEqual(req.candidates.map(c => c.userId), ['u-bob', 'u-carol']);
  // The store refuses an outsider (that would be a second invitation path),
  // so an outsider must never be offered.
  assert.equal(req.candidates.some(c => c.userId === 'u-alice'), false, 'never yourself either');
});

test('demoting the last admin is the same refusal as removing them', () => {
  const rows = memberRows([admin('u-alice'), member('u-bob')], DIRECTORY, null);
  assert.equal(handoverRequirement({ rows, userId: 'u-alice', action: 'demote' }).kind, 'successor');
  // …but a PROMOTION is never gated.
  assert.equal(roleChangeState({
    rows, userId: 'u-bob', nextRole: ROLE_ADMIN, canManage: true,
  }).needsSuccessor, false);
});

test('the sole member of a team is a dead end, not a hand-over', () => {
  const rows = memberRows([admin('u-alice')], DIRECTORY, null);
  for (const action of ['remove', 'demote']) {
    const req = handoverRequirement({ rows, userId: 'u-alice', action });
    assert.equal(req.kind, 'blocked', action);
    assert.equal(req.notice, SOLE_MEMBER_NOTICE);
    assert.deepEqual(req.candidates, []);
  }
  assert.match(SOLE_MEMBER_NOTICE, /delete the team/, 'names the way out');
});

test('a target who is not on the team at all is inert, never a hand-over', () => {
  const rows = memberRows([admin('u-alice')], DIRECTORY, null);
  const req = handoverRequirement({ rows, userId: 'u-nobody', action: 'remove' });
  assert.equal(req.kind, 'absent');
  assert.equal(removeState({ rows, userId: 'u-nobody', canManage: true }).disabled, true);
});

test('an unknown action is never treated as a demotion', () => {
  const rows = memberRows([admin('u-alice'), member('u-bob')], DIRECTORY, null);
  assert.equal(handoverRequirement({ rows, userId: 'u-alice', action: 'promote' }).kind, 'none');
  assert.equal(handoverRequirement({ rows }).kind, 'absent', 'and no target is absent');
});

// ── AC9: read-only for a Team Member, in every control ──────────────────────

test('without rights every write control is inert and says why', () => {
  const rows = memberRows([admin('u-alice'), member('u-bob')], DIRECTORY, 'u-bob');
  for (const state of [
    removeState({ rows, userId: 'u-alice', canManage: false }),
    roleChangeState({ rows, userId: 'u-alice', nextRole: ROLE_MEMBER, canManage: false }),
    roleChangeState({ rows, userId: 'u-bob', nextRole: ROLE_ADMIN, canManage: false }),
  ]) {
    assert.equal(state.disabled, true);
    assert.equal(state.hint, READ_ONLY_NOTICE);
    assert.equal(state.needsSuccessor, false, 'no rights ⇒ no hand-over prompt either');
  }
  assert.match(READ_ONLY_NOTICE, /see who has access/, 'the read half is stated, not just the refusal');
});

test('a busy panel disables without inventing a reason', () => {
  const rows = memberRows([admin('u-alice'), admin('u-bob')], DIRECTORY, null);
  const s = removeState({ rows, userId: 'u-bob', canManage: true, busy: true });
  assert.equal(s.disabled, true);
  assert.equal(s.hint, '', 'busy is not a rights problem');
});

// ── The two requests: body vs query is the whole trap ───────────────────────

test('POST carries teamId in the BODY (the upsert that adds and re-roles)', () => {
  assert.deepEqual(setRoleRequest({ teamId: 't1', userId: 'u-bob', role: ROLE_MEMBER }), {
    method: 'POST',
    url: '/api/admin/memberships',
    body: { userId: 'u-bob', teamId: 't1', role: ROLE_MEMBER },
  });
});

test('POST forwards a successor only when one was chosen', () => {
  const withS = setRoleRequest({ teamId: 't1', userId: 'u-alice', role: ROLE_MEMBER, successorUserId: 'u-bob' });
  assert.equal(withS.body.successorUserId, 'u-bob');
  const without = setRoleRequest({ teamId: 't1', userId: 'u-alice', role: ROLE_MEMBER, successorUserId: '' });
  assert.equal(Object.prototype.hasOwnProperty.call(without.body, 'successorUserId'), false,
    'an empty param would be forwarded verbatim by adminQuery and read as a real value');
});

test('DELETE carries teamId in the QUERY — a body would 403 everyone', () => {
  // `canManageTeam(scope, req.query.teamId)` is the gate; `!teamId` fails closed.
  const req = removeRequest({ teamId: 't1', userId: 'u-bob' });
  assert.equal(req.method, 'DELETE');
  assert.equal(req.body, null, 'nothing may ride in a body here');
  const url = new URL(req.url, 'https://console.local');
  assert.equal(url.pathname, '/api/admin/memberships');
  assert.equal(url.searchParams.get('teamId'), 't1');
  assert.equal(url.searchParams.get('userId'), 'u-bob');
  assert.equal(url.searchParams.has('successorUserId'), false);
});

test('DELETE encodes ids rather than splicing them into the query', () => {
  const req = removeRequest({ teamId: 't&1=x', userId: 'u b/c', successorUserId: 'u-bob' });
  const url = new URL(req.url, 'https://console.local');
  assert.equal(url.searchParams.get('teamId'), 't&1=x');
  assert.equal(url.searchParams.get('userId'), 'u b/c');
  assert.equal(url.searchParams.get('successorUserId'), 'u-bob');
});

// ── Errors: the server's own words are the instruction ──────────────────────

test('a D4 refusal is relayed verbatim — it IS the instruction', () => {
  const err = new Error('ignored');
  err.status = 409;
  err.code = 'last-team-admin';
  err.serverMessage = 'Name a successor already in this team before removing its last Team Admin.';
  assert.equal(membershipWriteError(err), err.serverMessage);
});

test('a 403 is reworded, because "Forbidden" does not say what happened', () => {
  const err = new Error('Forbidden');
  err.status = 403;
  err.serverMessage = 'You may not manage members of this team';
  const msg = membershipWriteError(err);
  assert.match(msg, /no longer a Team Admin/);
  assert.match(msg, /reopen the panel/, 'names the recovery');
});

test('a message-less failure falls back without printing "undefined"', () => {
  assert.equal(membershipWriteError(null), 'The change could not be saved.');
  assert.equal(membershipWriteError(new Error('HTTP 502')), 'HTTP 502');
  assert.equal(membershipWriteError(undefined, 'Nope.'), 'Nope.');
});

// ── Role copy ───────────────────────────────────────────────────────────────

test('both roles are offered, least powerful first, and both are explained', () => {
  assert.deepEqual(ROLE_OPTIONS, [ROLE_MEMBER, ROLE_ADMIN]);
  for (const role of ROLE_OPTIONS) {
    assert.ok(ROLE_LABELS[role], role);
    assert.ok(ROLE_HINTS[role].length > 20, `${role} hint says what the role may do`);
  }
  assert.match(ROLE_HINTS[ROLE_MEMBER], /change nothing/, 'D9 stated where the choice is made');
});
