'use strict';

// Unit + integration coverage for the process-draft access model (#2068).
//
// Worth saying plainly, because it is the reason this file is longer than a
// sibling would be: **there was no unit or integration test for any draft route
// before this ticket** — `bp-removal-guard.test.js` only asserted that the
// import route still exists. So AC18's two-user loop is the first one, and it
// is written here against the decision module rather than over HTTP: api.js
// boots Express and cannot be required (the constraint every api-side guard in
// this directory works around), and every decision the loop makes — including
// the status codes — lives in `draft-access.js` precisely so it can be driven.
// The companion `draft-routes-access.test.js` reads api.js's source to prove the
// routes still call into it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const da = require('./draft-access');

const ADMIN = { all: true, userId: null };                 // env single-admin
const SYSADMIN = { all: true, userId: 'u-root' };          // System-Admin user
const alice = { all: false, userId: 'u-alice', teamIds: new Set() };
const bob = { all: false, userId: 'u-bob', teamIds: new Set() };
const carol = { all: false, userId: 'u-carol', teamIds: new Set() };

const draftOf = (accessUserIds, createdBy = 'u-alice') => ({
  processTemplateVersion: 1, name: 'Sprint plan', roles: [], createdBy, accessUserIds,
});

// ── normalisation ───────────────────────────────────────────────────────────

test('a record written before this ticket normalizes to an EMPTY access set', () => {
  // Fail-closed on purpose: the startup migration is what keeps upgrade-day
  // drafts reachable, not a permissive default here.
  const legacy = { name: 'Old', roles: [] };
  assert.deepEqual(da.normalizeAccess(legacy), { createdBy: null, accessUserIds: [] });
  assert.equal(da.canAccessDraft(alice, legacy), false);
  assert.equal(da.canAccessDraft(SYSADMIN, legacy), true);
});

test('normalizeAccess dedupes, trims and drops non-strings without throwing', () => {
  const d = { createdBy: '  u-alice ', accessUserIds: ['u-a', 'u-a', ' u-b ', 42, null, '', 'u-c'] };
  assert.deepEqual(da.normalizeAccess(d), { createdBy: 'u-alice', accessUserIds: ['u-a', 'u-b', 'u-c'] });
  for (const junk of [null, undefined, 7, 'nope', []]) {
    assert.deepEqual(da.normalizeAccess(junk), { createdBy: null, accessUserIds: [] });
  }
});

// ── the one predicate (AC3, DD7) ────────────────────────────────────────────

test('AC3/AC6 — access is membership of the set, with a scope.all shortcut', () => {
  const d = draftOf(['u-alice']);
  assert.equal(da.canAccessDraft(alice, d), true);
  assert.equal(da.canAccessDraft(bob, d), false);
  assert.equal(da.canAccessDraft(SYSADMIN, d), true, 'DD7 — a System Admin sees all drafts');
  assert.equal(da.canAccessDraft(null, d), false);
});

test('DD7 — drafts follow visibleAgent, NOT the personal-credential tier', () => {
  // The distinction is the whole point of DD7: `ownsPersonalCredential` is
  // checked BEFORE `scope.all` so not even an admin sees a personal credential.
  // A draft is the opposite, and this is the assertion that pins the choice.
  const someoneElses = draftOf(['u-bob'], 'u-bob');
  assert.equal(da.canAccessDraft(SYSADMIN, someoneElses), true);
  assert.equal(da.canAccessDraft(ADMIN, someoneElses), true);
});

test('a caller with no user identity fails closed unless it is the env admin', () => {
  // scope.js:29-31 — the env single-admin login resolves to userId: null. It
  // passes on `all`, never on membership; a non-admin nobody passes on neither.
  const d = draftOf(['u-alice']);
  assert.equal(da.canAccessDraft({ all: false, userId: null }, d), false);
  assert.equal(da.canAccessDraft(ADMIN, d), true);
});

test('AC7 — "not yours" and "does not exist" are the SAME response', () => {
  const absent = da.authorizeDraft(alice, null);
  const forbidden = da.authorizeDraft(bob, draftOf(['u-alice']));
  assert.deepEqual(absent, forbidden);
  assert.equal(absent.status, 404);
  assert.equal(absent.ok, false);
});

test('AC6 — the list filter is the same predicate, not a second copy', () => {
  const mine = draftOf(['u-alice']);
  const theirs = draftOf(['u-bob'], 'u-bob');
  const shared = draftOf(['u-bob', 'u-alice'], 'u-bob');
  assert.deepEqual(da.filterVisibleDrafts(alice, [mine, theirs, shared]), [mine, shared]);
  assert.deepEqual(da.filterVisibleDrafts(SYSADMIN, [mine, theirs, shared]).length, 3);
  assert.deepEqual(da.filterVisibleDrafts(alice, null), []);
});

// ── AC2 — createdBy is never an authorization input ─────────────────────────

test('AC2 — no decision function reads createdBy', () => {
  // A source read rather than a behavioural probe, because the defect this
  // guards against is a future `if (draft.createdBy === scope.userId)` that
  // would pass every behavioural test written against today's fixtures.
  const src = fs.readFileSync(path.join(__dirname, 'draft-access.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(src.includes('function canAccessDraft'), 'comment stripping ate the module');
  const enforcement = ['canAccessDraft', 'authorizeDraft', 'filterVisibleDrafts', 'addAccess', 'removeAccess'];
  for (const name of enforcement) {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} not found`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.ok(
      !body.includes('createdBy'),
      `${name} reads createdBy — under DD2 the creator holds no privilege, so `
      + 'no gate may branch on it. It is provenance for display only.',
    );
  }
});

test('AC8 — the creator gets no extra right and no protection', () => {
  // Behavioural half of AC2: every operation is symmetric between the creator
  // and someone they shared with.
  const d = draftOf(['u-alice', 'u-bob'], 'u-alice');
  assert.equal(da.canAccessDraft(bob, d), da.canAccessDraft(alice, d));
  // Bob may remove Alice — the creator — from her own draft.
  const removed = da.removeAccess(d, 'u-alice');
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.accessUserIds, ['u-bob']);
  // ...and the record still says Alice created it. That is history, not a claim.
  assert.equal(da.normalizeAccess(d).createdBy, 'u-alice');
});

// ── creation, and the server-owned fields (AC1/AC4/AC5) ─────────────────────

test('AC1 — a new draft is private to its creator', () => {
  assert.deepEqual(da.newDraftAccess(alice), { createdBy: 'u-alice', accessUserIds: ['u-alice'] });
});

test('an ownerless caller creates an ownerless draft rather than being refused', () => {
  // The env single-admin has no user record. Refusing the create would break the
  // unattended e2e bring-up; the draft stays reachable through `scope.all`.
  const stamp = da.newDraftAccess(ADMIN);
  assert.deepEqual(stamp, { createdBy: null, accessUserIds: [] });
  assert.equal(da.canAccessDraft(ADMIN, stamp), true);
  assert.equal(da.canAccessDraft(alice, stamp), false);
});

test('AC4 — a forged createdBy / access set in a request body is dropped', () => {
  const forged = {
    name: 'Sprint plan', roles: [],
    createdBy: 'u-bob', accessUserIds: ['u-bob', 'u-carol'],
  };
  const stripped = da.stripAccessFields(forged);
  assert.equal('createdBy' in stripped, false);
  assert.equal('accessUserIds' in stripped, false);
  assert.equal(stripped.name, 'Sprint plan', 'nothing else may be touched');
  // ...and what actually lands on the record is the STORED pair.
  const stored = draftOf(['u-alice'], 'u-alice');
  const next = { ...stripped, ...da.carryAccessFields(stored) };
  assert.equal(next.createdBy, 'u-alice');
  assert.deepEqual(next.accessUserIds, ['u-alice']);
});

test('AC5 — a save from a client that never heard of the fields keeps them', () => {
  const stored = draftOf(['u-alice', 'u-bob'], 'u-alice');
  const clientBody = { name: 'Sprint plan', roles: [{ id: 'dev' }] };   // no access fields at all
  const next = { ...da.stripAccessFields(clientBody), ...da.carryAccessFields(stored) };
  assert.equal(next.createdBy, 'u-alice');
  assert.deepEqual(next.accessUserIds, ['u-alice', 'u-bob']);
});

test('sharing survives a rename, because the carry is the same call', () => {
  // The rename path rewrites the record under a NEW id, so the access pair has
  // to be carried across explicitly or it is lost with the old file.
  const stored = draftOf(['u-alice', 'u-bob'], 'u-alice');
  const renamed = { ...da.stripAccessFields({ name: 'Q3 plan', roles: [] }), id: 'q3-plan', ...da.carryAccessFields(stored) };
  assert.deepEqual(renamed.accessUserIds, ['u-alice', 'u-bob']);
  assert.equal(renamed.createdBy, 'u-alice');
});

// ── share / unshare, and the never-empty rule ───────────────────────────────

test('adding is idempotent and reports whether anything changed', () => {
  const d = draftOf(['u-alice']);
  const first = da.addAccess(d, 'u-bob');
  assert.deepEqual(first.accessUserIds, ['u-alice', 'u-bob']);
  assert.equal(first.changed, true);
  const again = da.addAccess({ ...d, accessUserIds: first.accessUserIds }, 'u-bob');
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.deepEqual(again.accessUserIds, ['u-alice', 'u-bob']);
});

test('AC9 — the access set can never be emptied, whoever asks', () => {
  const alone = draftOf(['u-alice']);
  const refused = da.removeAccess(alone, 'u-alice');
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'last_holder');
  assert.match(refused.error, /Delete draft/i, 'the refusal must name the intended action');
  // The rule is on the SET, not on "self" — `removeAccess` is not even told who
  // is asking, which is what makes an admin emptying it equally impossible.
  assert.equal(da.removeAccess.length, 2, 'removeAccess takes (draft, userId) and no caller');
});

test('AC9 — a user who is not the last MAY remove themselves (that is leaving)', () => {
  const shared = draftOf(['u-alice', 'u-bob']);
  const left = da.removeAccess(shared, 'u-alice');
  assert.equal(left.ok, true);
  assert.deepEqual(left.accessUserIds, ['u-bob']);
});

test('removing someone who is not in the set succeeds and changes nothing', () => {
  const d = draftOf(['u-alice']);
  const r = da.removeAccess(d, 'u-nobody');
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.deepEqual(r.accessUserIds, ['u-alice']);
});

test('a blank user id is a 400 on both share and unshare', () => {
  const d = draftOf(['u-alice', 'u-bob']);
  for (const bad of ['', '   ', null, undefined, 7]) {
    assert.equal(da.addAccess(d, bad).status, 400, String(bad));
    assert.equal(da.removeAccess(d, bad).status, 400, String(bad));
  }
});

// ── DD3 / DD3a — user deletion ──────────────────────────────────────────────

test('DD3 — deleting a user strips them from a shared draft', () => {
  const d = draftOf(['u-alice', 'u-bob'], 'u-alice');
  const r = da.stripUserFromDraft(d, 'u-bob');
  assert.equal(r.changed, true);
  assert.deepEqual(r.accessUserIds, ['u-alice']);
});

test('DD3a — a strip that empties the set retains the draft, admin-only', () => {
  // Deliberately NOT the AC9 refusal: silently destroying a document during a
  // user deletion is not recoverable, so the draft survives with nobody on it.
  const solo = draftOf(['u-bob'], 'u-bob');
  const r = da.stripUserFromDraft(solo, 'u-bob');
  assert.equal(r.changed, true);
  assert.deepEqual(r.accessUserIds, []);
  const after = { ...solo, accessUserIds: r.accessUserIds };
  assert.equal(da.canAccessDraft(alice, after), false);
  assert.equal(da.canAccessDraft(SYSADMIN, after), true, 'DD7 is what makes DD3a reachable');
  assert.equal(after.createdBy, 'u-bob', 'createdBy is left as history');
});

// ── AC15 — the migration ────────────────────────────────────────────────────

test('AC15 — a before/after fixture: every existing draft stays reachable', () => {
  const users = [
    { id: 'u-root', systemAdmin: true, createdAt: '2026-02-01T00:00:00Z' },
    { id: 'u-early', systemAdmin: true, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'u-alice', systemAdmin: false, createdAt: '2026-03-01T00:00:00Z' },
    { id: 'u-bob', systemAdmin: false, createdAt: '2026-03-02T00:00:00Z' },
  ];
  const before = [
    { name: 'Sprint plan', roles: [], createdAt: '2026-01-05T00:00:00Z' },
    { name: 'Migration', roles: [] },
  ];
  const systemAdminId = da.firstSystemAdminId(users);
  assert.equal(systemAdminId, 'u-early', 'DD4 — the FIRST System Admin, by createdAt');
  const allUserIds = users.map(u => u.id);

  for (const draft of before) {
    assert.equal(da.canAccessDraft(alice, draft), false, 'precondition: fail-closed before');
    const { changed, draft: after } = da.migrateDraftAccess(draft, { systemAdminId, allUserIds });
    assert.equal(changed, true);
    assert.equal(after.createdBy, 'u-early');
    assert.deepEqual(after.accessUserIds, allUserIds);
    // #2041 D6, literally: every user who can reach it today still can.
    for (const scope of [alice, bob]) {
      assert.equal(da.canAccessDraft(scope, after), true, `${scope.userId} kept access`);
    }
    // ...and someone who is not a user at all still cannot.
    assert.equal(da.canAccessDraft(carol, after), false, 'not a registered user');
    assert.equal(after.name, draft.name, 'the bundle itself is untouched');
  }
});

test('AC15 — re-running the migration is a no-op', () => {
  const already = draftOf(['u-alice']);
  assert.equal(da.needsAccessMigration(already), false);
  const { changed, draft } = da.migrateDraftAccess(already, { systemAdminId: 'u-root', allUserIds: ['u-x'] });
  assert.equal(changed, false);
  assert.equal(draft, already, 'an already-stamped record is returned untouched');
  // A private draft is NOT re-opened to everyone by a later boot — the very
  // regression an "is createdBy missing?" test would have let through.
  assert.deepEqual(da.normalizeAccess(draft).accessUserIds, ['u-alice']);
});

test('an installation with no System Admin record migrates to a null createdBy', () => {
  const { draft } = da.migrateDraftAccess({ name: 'X' }, { systemAdminId: null, allUserIds: [] });
  assert.equal(draft.createdBy, null, 'honest history rather than an invented one');
  assert.deepEqual(draft.accessUserIds, []);
  assert.equal(da.firstSystemAdminId([{ id: 'u1', systemAdmin: false }]), null);
  assert.equal(da.firstSystemAdminId(null), null);
});

// ── AC16 / D2 / D11 — what the surfaces are told ────────────────────────────

test('AC16 — the list view distinguishes private from shared, and names a creator', () => {
  const users = new Map([['u-alice', { id: 'u-alice', displayName: 'Alice A' }]]);
  const mine = da.draftAccessView(draftOf(['u-alice'], 'u-alice'), { viewerId: 'u-alice', usersById: users });
  assert.deepEqual(mine, {
    shared: false, accessCount: 1, createdByYou: true, createdByName: 'Alice A',
    visibleToEveryone: false, canEdit: true, viewerHasAccess: true,
  });

  const theirs = da.draftAccessView(draftOf(['u-alice', 'u-bob'], 'u-alice'), { viewerId: 'u-bob', usersById: users });
  assert.equal(theirs.shared, true);
  assert.equal(theirs.accessCount, 2);
  assert.equal(theirs.createdByYou, false);
  assert.equal(theirs.createdByName, 'Alice A');
});

test('#2859 — viewerHasAccess tells "shared with me" apart from a System Admin\'s view of every draft', () => {
  const shared = da.draftAccessView(draftOf(['u-alice', 'u-bob'], 'u-alice'), { viewerId: 'u-bob' });
  assert.equal(shared.viewerHasAccess, true);
  const adminOnlySees = da.draftAccessView(draftOf(['u-alice'], 'u-alice'), { viewerId: 'u-root' });
  assert.equal(adminOnlySees.viewerHasAccess, false);
  assert.equal(da.draftAccessView(draftOf(['u-alice'], 'u-alice'), { viewerId: null }).viewerHasAccess, false);
});

test('AC16 — no raw user id is ever returned to the list', () => {
  const view = da.draftAccessView(draftOf(['u-alice'], 'u-alice'), { viewerId: null, usersById: new Map() });
  assert.equal(JSON.stringify(view).includes('u-alice'), false);
});

test('a createdBy pointing at a deleted user degrades to a readable label', () => {
  const gone = da.draftAccessView(draftOf(['u-bob'], 'u-ghost'), { viewerId: 'u-bob', usersById: new Map() });
  assert.equal(gone.createdByName, 'Deleted user');
  // An ownerless (env-admin-created) draft claims nothing at all.
  const none = da.draftAccessView(draftOf([], null), { viewerId: 'u-bob', usersById: new Map() });
  assert.equal(none.createdByName, null);
});

test('D2/D11 — the directory projects display name and email ONLY', () => {
  const dir = da.userDirectory([
    { id: 'u-b', displayName: 'Bob B', email: 'bob@x', systemAdmin: true, githubHandle: 'bobgh', subject: 'bob@corp', passwordHash: 'secret' },
    { id: 'u-a', displayName: 'Alice A', email: 'alice@x', systemAdmin: false },
    null,
    { displayName: 'no id' },
  ]);
  assert.deepEqual(dir, [
    { id: 'u-a', displayName: 'Alice A', email: 'alice@x' },
    { id: 'u-b', displayName: 'Bob B', email: 'bob@x' },
  ], 'sorted by display name, and carrying nothing else');
  const serialized = JSON.stringify(dir);
  for (const leak of ['systemAdmin', 'githubHandle', 'subject', 'passwordHash', 'bobgh']) {
    assert.equal(serialized.includes(leak), false, `${leak} must not reach the picker`);
  }
});

test('the resolved access list uses the same projection, and keeps an unknown id', () => {
  const users = new Map([['u-alice', { id: 'u-alice', displayName: 'Alice A', email: 'a@x', systemAdmin: true }]]);
  const list = da.resolveAccessList(draftOf(['u-alice', 'u-ghost']), users);
  assert.deepEqual(list, [
    { id: 'u-alice', displayName: 'Alice A', email: 'a@x' },
    { id: 'u-ghost', displayName: 'Deleted user', email: '' },
  ]);
  assert.equal(JSON.stringify(list).includes('systemAdmin'), false);
});

// ── AC18 — the two-user loop ────────────────────────────────────────────────

test('AC18 — A creates, B is refused, A shares, B takes over, B is left alone', () => {
  // The loop the concept doc's P2 row names, driven end to end. Each step is
  // exactly what the corresponding route does; only the fs is missing.
  let draft = { name: 'Sprint plan', roles: [], ...da.newDraftAccess(alice) };

  // 1. A created it — private.
  assert.deepEqual(da.filterVisibleDrafts(alice, [draft]), [draft]);
  assert.deepEqual(da.filterVisibleDrafts(bob, [draft]), [], 'B does not see it in the list');

  // 2. ...and a direct GET / PUT / DELETE by id is the AC7 response.
  const refusal = da.authorizeDraft(bob, draft);
  assert.deepEqual(refusal, { ok: false, status: 404, error: 'Draft not found' });
  assert.deepEqual(refusal, da.authorizeDraft(bob, null), 'indistinguishable from absent');

  // 3. A shares with B.
  draft = { ...draft, accessUserIds: da.addAccess(draft, 'u-bob').accessUserIds };
  assert.equal(da.authorizeDraft(bob, draft).ok, true, 'B sees it...');

  // 4. ...and can edit it: the save carries the access pair forward unchanged.
  draft = {
    ...da.stripAccessFields({ name: 'Sprint plan', roles: [{ id: 'dev' }] }),
    ...da.carryAccessFields(draft),
  };
  assert.deepEqual(draft.accessUserIds, ['u-alice', 'u-bob']);

  // 5. DD2 — B can re-share it, and could delete it (the gate is the same one).
  const reshared = da.addAccess(draft, 'u-carol');
  assert.equal(reshared.ok, true);
  assert.deepEqual(reshared.accessUserIds, ['u-alice', 'u-bob', 'u-carol']);
  assert.equal(da.canAccessDraft(bob, draft), true, 'B may delete — same predicate as read');

  // 6. B removes A. From A's own draft. That is the literal meaning of equal.
  draft = { ...draft, accessUserIds: da.removeAccess(draft, 'u-alice').accessUserIds };
  assert.deepEqual(da.filterVisibleDrafts(alice, [draft]), [], 'A no longer sees it');
  assert.equal(da.normalizeAccess(draft).createdBy, 'u-alice', 'but still created it');

  // 7. B, now alone, is refused when removing themselves (AC9).
  const selfRemoval = da.removeAccess(draft, 'u-bob');
  assert.equal(selfRemoval.ok, false);
  assert.equal(selfRemoval.status, 409);
  assert.match(selfRemoval.error, /Delete draft/i);
});


// ── #2870 Part A — bulk share ───────────────────────────────────────────────

const KNOWN = new Set(['u-alice', 'u-bob', 'u-carol', 'u-dave']);

test('#2870 AC5 — a bulk share adds every selected colleague in one result', () => {
  const r = da.addAccessMany(draftOf(['u-alice']), ['u-bob', 'u-carol'], { knownUserIds: KNOWN });
  assert.equal(r.ok, true);
  assert.deepEqual(r.accessUserIds, ['u-alice', 'u-bob', 'u-carol']);
  assert.equal(r.changed, true);
  assert.equal(r.added, 2);
  assert.equal(r.skipped, 0);
});

test('#2870 AC5 — already-present and duplicated ids are skipped without error', () => {
  const r = da.addAccessMany(draftOf(['u-alice', 'u-bob']), ['u-bob', 'u-carol', 'u-carol', 'u-alice'], { knownUserIds: KNOWN });
  assert.equal(r.ok, true);
  assert.deepEqual(r.accessUserIds, ['u-alice', 'u-bob', 'u-carol']);
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 2);
  const none = da.addAccessMany(draftOf(['u-alice', 'u-bob']), ['u-bob'], { knownUserIds: KNOWN });
  assert.equal(none.ok, true);
  assert.equal(none.changed, false, 'nothing to write');
});

test('#2870 AC6 — one unknown id refuses the WHOLE request (all-or-nothing)', () => {
  // E.g. a colleague deleted between selecting and clicking Share.
  const d = draftOf(['u-alice']);
  const r = da.addAccessMany(d, ['u-bob', 'u-ghost', 'u-carol'], { knownUserIds: KNOWN });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, 'unknown_user');
  assert.equal(r.unknownCount, 1);
  assert.match(r.error, /Nothing was shared/);
  assert.equal('accessUserIds' in r, false, 'no partial set is handed back to write');
  assert.deepEqual(da.normalizeAccess(d).accessUserIds, ['u-alice'], 'the stored set is untouched');
});

test('#2870 — an empty or oversized selection is a 400', () => {
  for (const empty of [[], null, undefined, ['', '  ', 7]]) {
    const r = da.addAccessMany(draftOf(['u-alice']), empty, { knownUserIds: KNOWN });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  }
  const many = Array.from({ length: da.MAX_BULK_SHARE + 1 }, (_, i) => `u-${i}`);
  const r = da.addAccessMany(draftOf(['u-alice']), many, { knownUserIds: new Set(many) });
  assert.equal(r.status, 400);
});

test('#2870 — the single-user share shape still works through the bulk path', () => {
  // The route wraps a legacy `{ userId }` body as `[userId]`.
  const r = da.addAccessMany(draftOf(['u-alice']), ['u-bob'], { knownUserIds: KNOWN });
  assert.deepEqual(r.accessUserIds, ['u-alice', 'u-bob']);
  const unknown = da.addAccessMany(draftOf(['u-alice']), [undefined], { knownUserIds: KNOWN });
  assert.equal(unknown.status, 400);
});

// ── #2870 Part B — "Visible to everyone" ────────────────────────────────────

const globalDraft = (accessUserIds = ['u-alice']) => ({ ...draftOf(accessUserIds), visibleToEveryone: true });

test('#2870 AC9 — a global draft is listed for and readable by a non-holder', () => {
  const d = globalDraft();
  assert.equal(da.canViewDraft(bob, d), true);
  assert.equal(da.canAccessDraft(bob, d), false, 'viewing is not holding');
  assert.deepEqual(da.filterVisibleDrafts(bob, [d, draftOf(['u-alice'])]), [d]);
  const read = da.authorizeDraftRead(bob, d);
  assert.equal(read.ok, true);
  assert.equal(read.canEdit, false);
  assert.equal(da.authorizeDraftRead(alice, d).canEdit, true);
});

test('#2870 AC9 — a user created AFTER the switch was turned on sees it too', () => {
  // Nothing is written per user: the predicate is evaluated against the flag
  // on every request, so a brand-new id is covered with no migration.
  const d = globalDraft();
  const newcomer = { all: false, userId: 'u-joined-tomorrow', teamIds: new Set() };
  assert.equal(da.canViewDraft(newcomer, d), true);
  assert.deepEqual(da.normalizeAccess(d).accessUserIds, ['u-alice'], 'no one was added to the set');
});

test('#2870 AC11 — a global-only reader is refused by the write gate with READ_ONLY', () => {
  const r = da.authorizeDraft(bob, globalDraft());
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, 'read_only');
  assert.match(r.error, /Duplicate to my drafts/);
  // A holder of a global draft keeps full rights (DD2 unchanged).
  assert.equal(da.authorizeDraft(alice, globalDraft()).ok, true);
  // A global draft also shared explicitly with Carol: Carol is a full holder.
  assert.equal(da.authorizeDraft(carol, globalDraft(['u-alice', 'u-carol'])).ok, true);
});

test('#2870 AC11 — a NON-global draft still answers the AC7 404 to a stranger', () => {
  assert.deepEqual(da.authorizeDraft(bob, draftOf(['u-alice'])), da.NOT_FOUND);
  assert.deepEqual(da.authorizeDraftRead(bob, draftOf(['u-alice'])), da.NOT_FOUND);
  assert.deepEqual(da.authorizeDraftRead(bob, null), da.NOT_FOUND);
});

test('#2870 — only a strictly-true flag counts, and an ownerless caller stays out', () => {
  for (const v of ['true', 1, 'yes', {}, false, null]) {
    assert.equal(da.canViewDraft(bob, { ...draftOf(['u-alice']), visibleToEveryone: v }), false, String(v));
  }
  assert.equal(da.canViewDraft({ all: false, userId: null }, globalDraft()), false);
  assert.equal(da.canViewDraft(null, globalDraft()), false);
  assert.equal(da.canViewDraft(SYSADMIN, draftOf(['u-alice'])), true, 'DD7 unchanged');
});

test('#2870 AC13 — turning the switch off removes global visibility, the set unchanged', () => {
  const on = da.setVisibility(draftOf(['u-alice', 'u-bob']), true);
  assert.equal(on.ok, true);
  assert.equal(on.changed, true);
  assert.equal(on.draft.visibleToEveryone, true);
  assert.equal(da.canViewDraft(carol, on.draft), true);

  const off = da.setVisibility(on.draft, false);
  assert.equal(off.ok, true);
  assert.equal(off.changed, true);
  assert.equal('visibleToEveryone' in off.draft, false, 'off removes the field');
  assert.deepEqual(off.draft.accessUserIds, ['u-alice', 'u-bob'], 'explicit set unchanged');
  assert.equal(da.canViewDraft(carol, off.draft), false, 'Carol loses it immediately');
  assert.equal(da.canViewDraft(bob, off.draft), true, 'Bob is on the list and keeps it');

  assert.equal(da.setVisibility(off.draft, false).changed, false, 'idempotent');
  assert.equal(da.setVisibility(off.draft, 'yes').status, 400);
});

test('#2870 AC14 — "Visible to everyone" does not count as an access holder', () => {
  const r = da.removeAccess(globalDraft(['u-alice']), 'u-alice');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'last_holder');
});

test('#2870 AC15 — the flag is stripped on import/save and carried from storage', () => {
  const forged = { name: 'Plan', roles: [], visibleToEveryone: true, viewerCanEdit: true };
  const stripped = da.stripAccessFields(forged);
  assert.equal('visibleToEveryone' in stripped, false);
  assert.equal('viewerCanEdit' in stripped, false, 'the response-only annotation is never stored');
  // A normal save cannot turn it ON...
  const privateSave = { ...stripped, ...da.carryAccessFields(draftOf(['u-alice'])) };
  assert.equal('visibleToEveryone' in privateSave, false);
  // ...nor OFF: the stored flag is carried, the incoming copy ignored.
  const globalSave = { ...da.stripAccessFields({ name: 'Plan', visibleToEveryone: false }), ...da.carryAccessFields(globalDraft()) };
  assert.equal(globalSave.visibleToEveryone, true);
});

test('#2870 AC12 — the list view marks a global draft and a read-only row', () => {
  const view = da.draftAccessView(globalDraft(), { viewerId: 'u-bob', usersById: new Map(), canEdit: false });
  assert.equal(view.visibleToEveryone, true);
  assert.equal(view.canEdit, false);
  assert.equal(view.shared, false, 'global is not "shared with N people"');
});

test('#2870 AC2 — the new gates do not read createdBy either', () => {
  const src = fs.readFileSync(path.join(__dirname, 'draft-access.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const name of ['canViewDraft', 'isVisibleToEveryone', 'authorizeDraftRead', 'addAccessMany', 'setVisibility']) {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} not found`);
    assert.ok(!src.slice(start, src.indexOf('\n}\n', start)).includes('createdBy'), `${name} reads createdBy`);
  }
});
