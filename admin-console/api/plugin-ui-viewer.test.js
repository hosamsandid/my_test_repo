'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveViewerRole, uiSubPath, visibleScopes } = require('./plugin-ui-viewer');

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
