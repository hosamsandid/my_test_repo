'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  resolveAuthEnabled,
  describeAuthMode,
  authModeLogLine,
  singleUserElevationWarning,
} = require('./auth-mode');
const {
  computeScope,
  describeAuthz,
  isKnownPrincipal,
  visibleTeam,
  canManageTeam,
  visibleCredential,
} = require('./scope');

// ── the flag ────────────────────────────────────────────────────────────────

test('AUTH_ENABLED defaults to off — an upgraded stack keeps today’s behaviour', () => {
  assert.equal(resolveAuthEnabled({}), false);
  assert.equal(resolveAuthEnabled({ AUTH_ENABLED: undefined }), false);
  assert.equal(resolveAuthEnabled(), false);
});

test('AUTH_ENABLED accepts the usual on-tokens, case- and space-insensitively', () => {
  for (const raw of ['true', 'TRUE', ' True ', '1', 'yes', 'on']) {
    assert.equal(resolveAuthEnabled({ AUTH_ENABLED: raw }), true, `expected on for '${raw}'`);
  }
});

test('AUTH_ENABLED accepts the usual off-tokens', () => {
  for (const raw of ['', 'false', 'FALSE', '0', 'no', 'off', '  ']) {
    assert.equal(resolveAuthEnabled({ AUTH_ENABLED: raw }), false, `expected off for '${raw}'`);
  }
});

// A typo must not silently start filtering the console; it is reported instead.
test('an unrecognised AUTH_ENABLED value is off and flagged as unrecognised', () => {
  const mode = describeAuthMode({ AUTH_ENABLED: 'enabled' });
  assert.equal(mode.enabled, false);
  assert.equal(mode.recognised, false);
  assert.equal(mode.raw, 'enabled');
  assert.match(authModeLogLine({ AUTH_ENABLED: 'enabled' }), /not a recognised boolean/);
});

test('the boot log line names the mode in plain language', () => {
  assert.match(authModeLogLine({}), /single-user \(compatibility\)/);
  assert.match(authModeLogLine({ AUTH_ENABLED: 'true' }), /multi-user/);
});

// ── the footgun warning ─────────────────────────────────────────────────────

test('single-user mode with named non-admin users warns, naming the count', () => {
  const users = [
    { id: 'u1', subject: 'ada@example.com', systemAdmin: true },
    { id: 'u2', subject: 'bob@example.com' },
    { id: 'u3', subject: 'cyd@example.com' },
  ];
  const warning = singleUserElevationWarning(users, {});
  assert.match(warning, /2 non-admin user record\(s\)/);
  assert.match(warning, /AUTH_ENABLED=true/);
});

test('the genuine single-user case (no user records) does not warn', () => {
  assert.equal(singleUserElevationWarning([], {}), null);
  assert.equal(singleUserElevationWarning(undefined, {}), null);
});

test('a stack whose only records are System Admins does not warn', () => {
  const users = [{ id: 'u1', subject: 'ada@example.com', systemAdmin: true }];
  assert.equal(singleUserElevationWarning(users, {}), null);
});

test('multi-user mode never warns, however many users exist', () => {
  const users = [{ id: 'u2', subject: 'bob@example.com' }];
  assert.equal(singleUserElevationWarning(users, { AUTH_ENABLED: 'true' }), null);
});

// ── computeScope in single-user compatibility mode ──────────────────────────

const USERS = [
  { id: 'u-admin', subject: 'ada@example.com', systemAdmin: true },
  { id: 'u-member', subject: 'bob@example.com' },
];
const MEMBERSHIPS = [{ userId: 'u-member', teamId: 'team-a', role: 'team-member' }];

test('single-user mode: a team member becomes the implicit System Admin', () => {
  const scope = computeScope({
    username: 'bob@example.com', adminUsername: 'admin',
    users: USERS, memberships: MEMBERSHIPS, authEnabled: false,
  });
  assert.equal(scope.all, true);
  assert.equal(visibleTeam(scope, 'team-b'), true, 'a foreign team must be visible');
  assert.equal(canManageTeam(scope, 'team-b'), true, 'management must be ungated');
});

// Ownership-keyed behaviour has to keep working, or the mode would break audit
// attribution and personal credentials rather than merely widen visibility.
test('single-user mode still resolves userId from the matching record', () => {
  const scope = computeScope({
    username: 'BOB@example.com', adminUsername: 'admin',
    users: USERS, memberships: MEMBERSHIPS, authEnabled: false,
  });
  assert.equal(scope.userId, 'u-member');
});

test('single-user mode keeps the env admin’s historical userId: null shape', () => {
  const scope = computeScope({
    username: 'admin', adminUsername: 'admin',
    users: USERS, memberships: MEMBERSHIPS, authEnabled: false,
  });
  assert.deepEqual(
    { all: scope.all, userId: scope.userId, teamIds: [...scope.teamIds], roles: [...scope.roles] },
    { all: true, userId: null, teamIds: [], roles: [] },
  );
});

// The personal tier is checked before scope.all (#1567) and keys on userId, so
// the mode must not hand one human another human's personal credential.
test('single-user mode does NOT breach the personal-credential tier', () => {
  const scope = computeScope({
    username: 'bob@example.com', adminUsername: 'admin',
    users: USERS, memberships: MEMBERSHIPS, authEnabled: false,
  });
  const mine = { id: 'k1', scope: 'personal', teamId: null, userId: 'u-member' };
  const theirs = { id: 'k2', scope: 'personal', teamId: null, userId: 'u-admin' };
  assert.equal(visibleCredential(scope, mine), true);
  assert.equal(visibleCredential(scope, theirs), false, 'another human’s personal credential leaked');
});

test('single-user mode relaxes authorization, not authentication', () => {
  const scope = computeScope({ username: '', users: USERS, authEnabled: false });
  assert.equal(scope.all, false, 'an unauthenticated caller must still see nothing');
  assert.equal(scope.userId, null);
});

// ── multi-user mode is byte-for-byte today's behaviour ──────────────────────

test('multi-user mode narrows a team member to their own memberships', () => {
  const scope = computeScope({
    username: 'bob@example.com', adminUsername: 'admin',
    users: USERS, memberships: MEMBERSHIPS, authEnabled: true,
  });
  assert.equal(scope.all, false);
  assert.equal(visibleTeam(scope, 'team-a'), true);
  assert.equal(visibleTeam(scope, 'team-b'), false);
  assert.equal(canManageTeam(scope, 'team-a'), false, 'a team-member may not manage');
});

// The parameter defaults ON while the env flag defaults OFF — a missing argument
// must never silently grant full visibility.
test('the authEnabled parameter fails closed when omitted', () => {
  const scope = computeScope({
    username: 'bob@example.com', adminUsername: 'admin',
    users: USERS, memberships: MEMBERSHIPS,
  });
  assert.equal(scope.all, false);
});

// ── describeAuthz + the IAP gate ────────────────────────────────────────────

test('describeAuthz reports the mode alongside the visibility it granted', () => {
  const single = describeAuthz({
    username: 'bob@example.com', adminUsername: 'admin',
    users: USERS, memberships: MEMBERSHIPS, authEnabled: false,
  });
  assert.equal(single.admin, true);
  assert.equal(single.authEnabled, false, 'a client cannot otherwise tell why they are admin');

  const multi = describeAuthz({
    username: 'bob@example.com', adminUsername: 'admin',
    users: USERS, memberships: MEMBERSHIPS, authEnabled: true,
  });
  assert.equal(multi.admin, false);
  assert.equal(multi.authEnabled, true);
  assert.deepEqual(multi.teams, [{ teamId: 'team-a', role: 'team-member' }]);
});

// #1415: an unregistered IAP identity must keep falling through to the login
// form. isKnownPrincipal reads envAdmin/userId, never scope.all, so single-user
// mode cannot turn a stranger who passed IAP into a silent System Admin.
test('single-user mode does not weaken the IAP auto-login gate', () => {
  const stranger = describeAuthz({
    username: 'nobody@example.com', adminUsername: 'admin',
    users: USERS, memberships: MEMBERSHIPS, authEnabled: false,
  });
  assert.equal(stranger.admin, true, 'they would be the operator once signed in');
  assert.equal(stranger.userId, null);
  assert.equal(isKnownPrincipal(stranger), false, 'an unregistered IAP identity must not auto-login');
});

// ── wiring guard over api.js ────────────────────────────────────────────────
//
// The flag is useless if the one chokepoint does not pass it. api.js has no
// exports, so the wiring is asserted by reading the source (comments stripped —
// this ticket adds comments naming the very identifiers below).

// ORDER MATTERS: line comments are stripped FIRST. api.js's own prose mentions
// `/api/*` routes inside a `//` comment, and that `/*` pairs with the next `*/`
// hundreds of lines later — stripping block comments first swallows the code
// this guard is looking for, and the guard then fails for a reason that has
// nothing to do with the wiring.
function apiSource() {
  const raw = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  return raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

test('api.js resolves AUTH_ENABLED once and threads it through both consumers', () => {
  const src = apiSource();
  assert.match(src, /const AUTH_ENABLED = resolveAuthEnabled\(process\.env\)/,
    'the flag is not resolved from the environment');

  const getScopeAt = src.indexOf('function getScope(req)');
  assert.ok(getScopeAt > 0, 'getScope not found');
  const getScopeBody = src.slice(getScopeAt, src.indexOf('\n}', getScopeAt));
  assert.match(getScopeBody, /authEnabled: AUTH_ENABLED/,
    'getScope — the single scope chokepoint — does not pass the mode');

  const authzAt = src.indexOf('describeAuthz: (subject) => describeAuthz({');
  assert.ok(authzAt > 0, 'the describeAuthz resolver not found');
  const authzBody = src.slice(authzAt, src.indexOf('}),', authzAt));
  assert.match(authzBody, /authEnabled: AUTH_ENABLED/,
    'the session authz descriptor does not pass the mode');
});

test('api.js states the mode at boot and warns about elevated users', () => {
  const src = apiSource();
  assert.match(src, /authModeLogLine\(process\.env\)/, 'the mode is never logged');
  assert.match(src, /singleUserElevationWarning\(/, 'the elevation footgun is never surfaced');
});
