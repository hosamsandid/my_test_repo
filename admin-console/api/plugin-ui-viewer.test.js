'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  resolveViewerRole,
  uiSubPath,
  visibleScopes,
  isGloballyVisibleUi,
  effectiveViewerRole,
} = require('./plugin-ui-viewer');

function scope({ all = false, teamIds = [], roles = [] } = {}) {
  return { all, teamIds: new Set(teamIds), roles: new Map(roles) };
}

// ── resolveViewerRole ───────────────────────────────────────────────────────

test('a System Admin is always system-admin', () => {
  assert.equal(resolveViewerRole(scope({ all: true }), []), 'system-admin');
  // Even with no granted teams — full visibility outranks the grant set.
  assert.equal(resolveViewerRole(scope({ all: true }), ['alpha']), 'system-admin');
});

test('the caller gets their role in a granted team', () => {
  const member = scope({ teamIds: ['alpha'], roles: [['alpha', 'team-member']] });
  assert.equal(resolveViewerRole(member, ['alpha']), 'team-member');
  const admin = scope({ teamIds: ['alpha'], roles: [['alpha', 'team-admin']] });
  assert.equal(resolveViewerRole(admin, ['alpha']), 'team-admin');
});

test('team-admin outranks team-member across several granted teams', () => {
  const s = scope({
    teamIds: ['alpha', 'beta'],
    roles: [['alpha', 'team-member'], ['beta', 'team-admin']],
  });
  assert.equal(resolveViewerRole(s, ['alpha', 'beta']), 'team-admin');
});

test('a role in a team the plugin is NOT granted to does not count', () => {
  const s = scope({ teamIds: ['alpha', 'gamma'], roles: [['gamma', 'team-admin'], ['alpha', 'team-member']] });
  // Plugin granted only to alpha → the gamma admin role is irrelevant.
  assert.equal(resolveViewerRole(s, ['alpha']), 'team-member');
});

test('no membership in any granted team → null (no access)', () => {
  const s = scope({ teamIds: ['gamma'], roles: [['gamma', 'team-admin']] });
  assert.equal(resolveViewerRole(s, ['alpha']), null);
  assert.equal(resolveViewerRole(scope(), ['alpha']), null);
});

// ── uiSubPath ───────────────────────────────────────────────────────────────

test('the mount root maps to /', () => {
  assert.equal(uiSubPath('/plugins/test-mgmt/ui', 'test-mgmt'), '/');
  assert.equal(uiSubPath('/plugins/test-mgmt/ui/', 'test-mgmt'), '/');
});

test('a sub-path is stripped of the mount prefix and its query', () => {
  assert.equal(uiSubPath('/plugins/test-mgmt/ui/runs', 'test-mgmt'), '/runs');
  assert.equal(uiSubPath('/plugins/test-mgmt/ui/admin?x=1', 'test-mgmt'), '/admin');
  assert.equal(uiSubPath('/plugins/test-mgmt/ui/runs/42#frag', 'test-mgmt'), '/runs/42');
});

test('anything not under the mount collapses to /', () => {
  assert.equal(uiSubPath('/plugins/other/ui/x', 'test-mgmt'), '/');
  assert.equal(uiSubPath('', 'test-mgmt'), '/');
});

// ── visibleScopes ─────────────────────────────────────────────────────────────

test('a full-visibility admin sees every derived scope', () => {
  const list = [{ scopeId: 'alpha', teamId: 'alpha' }, { scopeId: 'beta', teamId: 'beta' }];
  assert.deepEqual(visibleScopes(scope({ all: true }), list), list);
});

test('a non-admin sees only scopes whose team they belong to', () => {
  const list = [{ scopeId: 'alpha', teamId: 'alpha' }, { scopeId: 'beta', teamId: 'beta' }];
  const s = scope({ teamIds: ['alpha'], roles: [['alpha', 'team-member']] });
  assert.deepEqual(visibleScopes(s, list), [{ scopeId: 'alpha', teamId: 'alpha' }]);
});

// ── isGloballyVisibleUi (#1599) ──────────────────────────────────────────────

test('isGloballyVisibleUi is true only for ui.global === true', () => {
  assert.equal(isGloballyVisibleUi({ ui: { global: true } }), true);
  assert.equal(isGloballyVisibleUi({ ui: { global: false } }), false);
  assert.equal(isGloballyVisibleUi({ ui: {} }), false);
  assert.equal(isGloballyVisibleUi({}), false);
  assert.equal(isGloballyVisibleUi(null), false);
});

// ── effectiveViewerRole (#1599) ──────────────────────────────────────────────

test('effectiveViewerRole returns the grant-derived role when there is one', () => {
  const member = scope({ teamIds: ['alpha'], roles: [['alpha', 'team-member']] });
  // Grant role wins even when globally visible (no downgrade).
  assert.equal(effectiveViewerRole(member, ['alpha'], { globalVisible: true }), 'team-member');
  const admin = scope({ teamIds: ['alpha'], roles: [['alpha', 'team-admin']] });
  assert.equal(effectiveViewerRole(admin, ['alpha'], { globalVisible: true }), 'team-admin');
  // A System Admin keeps system-admin.
  assert.equal(effectiveViewerRole(scope({ all: true }), [], { globalVisible: true }), 'system-admin');
});

test('a viewer with no grant role is admitted as team-member ONLY when globally visible', () => {
  const stranger = scope({ teamIds: ['gamma'], roles: [['gamma', 'team-admin']] });
  // Not global → no access, exactly as before.
  assert.equal(effectiveViewerRole(stranger, ['alpha'], { globalVisible: false }), null);
  assert.equal(effectiveViewerRole(stranger, ['alpha']), null);
  // Global → ordinary team-member of the general routes (never elevated).
  assert.equal(effectiveViewerRole(stranger, ['alpha'], { globalVisible: true }), 'team-member');
  // A global plugin with no grants at all still admits any authenticated user.
  assert.equal(effectiveViewerRole(scope(), [], { globalVisible: true }), 'team-member');
});

// ── viewerTeamRoles ─────────────────────────────────────────────────────────

const { viewerTeamRoles } = require('./plugin-ui-viewer');

test('viewerTeamRoles: one entry per in-scope granted team, the caller\'s role in THAT team', () => {
  const s = scope({ teamIds: ['A', 'B', 'C'], roles: [['A', 'team-admin'], ['B', 'team-member'], ['C', 'team-admin']] });
  // C is not granted → absent; A/B keep their own role, not the max.
  assert.deepEqual(viewerTeamRoles(s, ['A', 'B']), { A: 'team-admin', B: 'team-member' });
});

test('viewerTeamRoles: a System Admin is system-admin in every granted team', () => {
  assert.deepEqual(viewerTeamRoles(scope({ all: true }), ['A', 'B']), { A: 'system-admin', B: 'system-admin' });
});

test('viewerTeamRoles: a purely-global viewer (no grant membership) gets an empty map', () => {
  assert.deepEqual(viewerTeamRoles(scope({ teamIds: ['Z'], roles: [['Z', 'team-admin']] }), ['A']), {});
});
