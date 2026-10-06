'use strict';

// Guards the wiring of the draft access model into the routes (#2068).
//
// `draft-access.test.js` proves the decisions; what a unit test cannot see is
// whether api.js still *reaches* them. api.js boots Express and cannot be
// required, so this reads its source — the same drift-guard technique the
// sibling api guards use.
//
// The specific failure this exists for: every one of these gates is invisible
// when it goes missing. A route that stops calling the predicate returns the
// right data to the caller who is allowed — and to everyone else too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** Slice one route's body out, so a match elsewhere in the 17k-line file cannot
 *  stand in for the gate that is actually missing. */
function route(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return stripComments(API_SRC.slice(start, end));
}

/** The comments here name the very ACs under test, so strip them first. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const LIST = () => route("app.get('/api/process/drafts',");
const CREATE = () => route("app.post('/api/process/drafts',");
const READ = () => route("app.get('/api/process/drafts/:id',");
const UPDATE = () => route("app.put('/api/process/drafts/:id',");
const REMOVE = () => route("app.delete('/api/process/drafts/:id',");
const IMPORT = () => route("app.post('/api/process/drafts/import-briefings',");
const ACCESS_READ = () => route("app.get('/api/process/drafts/:id/access',");
const ACCESS_ADD = () => route("app.post('/api/process/drafts/:id/access',");
const ACCESS_DEL = () => route("app.delete('/api/process/drafts/:id/access/:userId',");
const VISIBILITY = () => route("app.put('/api/process/drafts/:id/visibility',");

test('the module is wired in at all', () => {
  assert.match(API_SRC, /require\('\.\/draft-access'\)/);
});

test('AC6 — the list route filters on the shared predicate', () => {
  const src = LIST();
  assert.match(src, /getScope\(req\)/, 'the list must resolve the caller');
  // #2870 — the list filters on the READ predicate (holders + "Visible to
  // everyone"), and tells the row whether the viewer may edit.
  assert.match(src, /if \(!draftAccess\.canViewDraft\(scope, d\)\) return null;/);
  assert.match(src, /canEdit: draftAccess\.canAccessDraft\(scope, d\)/);
  assert.doesNotMatch(src, /res\.json\(drafts\)[\s\S]*canViewDraft/, 'the filter must precede the response');
});

test('AC16 — the list carries the access view, and never a raw user id', () => {
  const src = LIST();
  assert.match(src, /draftAccess\.draftAccessView\(/);
  // The only way an id could reach the row is by being spread from the record;
  // the projection is explicit, so assert the fields are not hand-picked here.
  assert.doesNotMatch(src, /createdBy:/, 'the view helper owns the projection');
});

test('AC3/AC7 — every write by-id route goes through the one holder gate', () => {
  // Including the access and visibility routes: sharing is itself gated on
  // having access, and #2870 AC11 — a "Visible to everyone" reader is refused
  // here by the server, not only by a hidden button.
  for (const [name, src] of [
    ['PUT', UPDATE()], ['DELETE', REMOVE()],
    ['GET access', ACCESS_READ()], ['POST access', ACCESS_ADD()], ['DELETE access', ACCESS_DEL()],
    ['PUT visibility', VISIBILITY()],
  ]) {
    assert.match(src, /requireDraftAccess\(req, res,/, `${name} must call the holder gate`);
    assert.doesNotMatch(src, /requireDraftRead/, `${name} must not use the read gate`);
  }
});

test('#2870 AC9/AC10 — only the plain GET uses the read gate, and flags read-only', () => {
  const src = READ();
  assert.match(src, /requireDraftRead\(req, res, req\.params\.id\)/);
  assert.doesNotMatch(src, /requireDraftAccess/);
  assert.match(src, /viewerCanEdit: verdict\.canEdit/);
  const gate = stripComments(API_SRC.slice(
    API_SRC.indexOf('function requireDraftRead'),
    API_SRC.indexOf('function requireDraftRead') + 600,
  ));
  assert.match(gate, /draftAccess\.authorizeDraftRead\(getScope\(req\), readDraft\(id\)\)/);
  assert.doesNotMatch(gate, /status\(40[13]\)/);
});

test('AC7 — the gate answers with the module\'s indistinguishable 404', () => {
  const gate = stripComments(API_SRC.slice(
    API_SRC.indexOf('function requireDraftAccess'),
    API_SRC.indexOf('function requireDraftAccess') + 900,
  ));
  assert.match(gate, /draftAccess\.authorizeDraft\(getScope\(req\), readDraft\(id\)\)/);
  assert.match(gate, /res\.status\(verdict\.status\)\.json\(\{ error: verdict\.error, code: verdict\.code \}\)/);
  // A hand-written 403/404 here would re-introduce the existence oracle.
  assert.doesNotMatch(gate, /status\(40[13]\)/);
});

test('AC1 — both create paths stamp from the caller, never from the body', () => {
  for (const [name, src] of [['POST', CREATE()], ['import-briefings', IMPORT()]]) {
    assert.match(src, /draftAccess\.newDraftAccess\(getScope\(req\)\)/, `${name} must stamp`);
    assert.doesNotMatch(src, /createdBy:\s*(req|body)/, `${name} must not read a body createdBy`);
  }
});

test('AC1 — an imported processTemplate cannot carry an access set in', () => {
  // Export/Import must not become a way to grant yourself access, or to grant
  // access to someone who never asked for it.
  const src = CREATE();
  // #2579 routes the import through coerceImportBundle first; the strip then
  // applies to that coerced copy — which must itself come from the body.
  assert.match(src, /coerceImportBundle\(req\.body\.processTemplate\)/);
  assert.match(src, /bundle = \{ \.\.\.draftAccess\.stripAccessFields\((?:req\.body\.processTemplate|coerced)\)/);
  assert.ok(
    src.indexOf('stripAccessFields') < src.indexOf('const draft = {'),
    'the access set must be stripped before the draft is built and stored',
  );
});

test('AC4/AC5 — the save route strips the incoming pair and carries the stored one', () => {
  const src = UPDATE();
  assert.match(src, /const body = draftAccess\.stripAccessFields\(req\.body \|\| \{\}\)/);
  assert.match(src, /\.\.\.draftAccess\.carryAccessFields\(existing\)/);
  // Ordering matters: the carry has to come after the body spread or the forged
  // copy wins. Assert the spread of `body` precedes it inside the literal.
  const literal = src.slice(src.indexOf('const draft = {'));
  assert.ok(
    literal.indexOf('...body') < literal.indexOf('carryAccessFields'),
    'carryAccessFields must be spread AFTER the request body, or a forged set wins',
  );
});

test('AC12/D3 — the share route only accepts existing accounts, all-or-nothing (#2870)', () => {
  const src = ACCESS_ADD();
  assert.match(src, /Array\.isArray\(req\.body\?\.userIds\) \? req\.body\.userIds : \[req\.body\?\.userId\]/);
  assert.match(src, /draftAccess\.addAccessMany\(d, userIds, \{ knownUserIds: new Set\(users\.keys\(\)\) \}\)/);
  // The refusal must return BEFORE the one write, or a partial set could land.
  assert.ok(
    src.indexOf('if (!result.ok) return') < src.indexOf('writeJsonAtomic'),
    'validation must precede the write',
  );
  assert.equal((src.match(/writeJsonAtomic\(/g) || []).length, 1, 'a bulk share is ONE write');
});

test('#2870 AC8/AC13 — the visibility route writes only the flag', () => {
  const src = VISIBILITY();
  assert.match(src, /draftAccess\.setVisibility\(d, req\.body\?\.visibleToEveryone\)/);
  assert.match(src, /writeJsonAtomic\(draftPath\(id\), result\.draft\)/);
  assert.doesNotMatch(src, /accessUserIds|validateProcessTemplate/);
});

test('AC9 — the unshare route relays the module\'s refusal rather than its own', () => {
  const src = ACCESS_DEL();
  assert.match(src, /draftAccess\.removeAccess\(d, userId\)/);
  assert.match(src, /res\.status\(result\.status\)\.json\(\{ error: result\.error, code: result\.code \}\)/);
});

test('sharing writes ONLY the access set, never the bundle', () => {
  // Otherwise a share would be a way past validateProcessTemplate.
  for (const src of [ACCESS_ADD(), ACCESS_DEL()]) {
    assert.match(src, /writeJsonAtomic\(draftPath\(id\), \{ \.\.\.d, accessUserIds: result\.accessUserIds \}\)/);
    assert.doesNotMatch(src, /validateProcessTemplate/);
  }
});

test('AC2 — no draft route branches on createdBy', () => {
  const routes = [LIST(), CREATE(), READ(), UPDATE(), REMOVE(), IMPORT(), ACCESS_READ(), ACCESS_ADD(), ACCESS_DEL(), VISIBILITY()];
  for (const src of routes) {
    assert.doesNotMatch(
      src, /if\s*\([^)]*createdBy/,
      'a route conditional on createdBy re-introduces the owner as an '
      + 'authorization concept, which DD2 removed',
    );
  }
});

test('AC14 — deleting a user strips them from every draft, after the record is gone', () => {
  const src = route("app.delete('/api/admin/users/:id',");
  assert.match(src, /stripUserFromDrafts\(req\.params\.id\)/);
  assert.match(src, /if \(status < 400\)/, 'only strip after a successful delete');
  // Best-effort: a failed strip must not turn a completed offboarding into a 500.
  assert.match(src, /catch \(err\)/);
  const helper = stripComments(API_SRC.slice(
    API_SRC.indexOf('function stripUserFromDrafts'),
    API_SRC.indexOf('function backfillDraftAccess'),
  ));
  assert.match(helper, /draftAccess\.stripUserFromDraft\(d, userId\)/);
  // DD3a — this path must NOT use the never-empty rule.
  assert.doesNotMatch(helper, /removeAccess/);
});

test('AC15 — the migration runs at startup, beside the other backfills', () => {
  const listen = API_SRC.slice(API_SRC.indexOf("app.listen(4000"));
  assert.match(listen, /backfillDraftAccess\(\)/);
  assert.match(listen, /catch \(err\) \{ console\.error\(`\[Admin\] Draft access backfill failed/);
  const fn = stripComments(API_SRC.slice(
    API_SRC.indexOf('function backfillDraftAccess'),
    API_SRC.indexOf('function requireDraftAccess'),
  ));
  assert.match(fn, /draftAccess\.firstSystemAdminId\(users\)/);
  assert.match(fn, /draftAccess\.migrateDraftAccess\(d, \{ systemAdminId, allUserIds \}\)/);
});

test('D2/D11 — the open user directory exists and projects through the module', () => {
  const src = route("app.get('/api/users/directory',");
  assert.match(src, /draftAccess\.userDirectory\(readJsonFile\(USERS_INDEX, \[\]\)\)/);
  // It must NOT be the admin route in disguise: no proxy, no scope.all gate
  // (which would make sharing System-Admin-only), and no extra fields.
  assert.doesNotMatch(src, /callAdmin|proxyAdmin|denyAdmin|scope\.all/);
});

test('AC10 — the Team Wizard gallery is filtered by consuming the same endpoint', () => {
  // The surface a Flows-page-only fix would miss. It is correct precisely
  // because it does NOT have its own list route: `StepProcess.jsx` reads
  // `/api/process/drafts`, so the server-side filter reaches it unchanged.
  const step = fs.readFileSync(
    path.join(__dirname, '../src/pages/team-setup/StepProcess.jsx'), 'utf8',
  );
  assert.match(step, /useApi\('\/api\/process\/drafts'\)/);
  assert.equal(
    (step.match(/\/api\/process\/drafts(?!\/)/g) || []).length >= 1, true,
    'the wizard must keep reading the shared, filtered list endpoint',
  );
  // No second, unfiltered source of drafts anywhere on the client.
  assert.doesNotMatch(step, /process-drafts/);
});
