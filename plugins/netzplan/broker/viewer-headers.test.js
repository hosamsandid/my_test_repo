'use strict';

// Unit tests for the broker's copy of the §4.8 viewer-header scheme (#1563).
// Dependency-free `node --test`; run by the `netzplan-broker` CI job. Verifies
// the sign/verify round-trip, forgery rejection, and the /admin role gate that
// makes "/admin refused for a Team Member, served for a Team Admin" hold
// broker-side even if the console proxy is bypassed.

const test = require('node:test');
const assert = require('node:assert');

const {
  signViewerHeaders,
  verifyViewerHeaders,
  requiredRoleForPath,
  roleAllows,
} = require('./viewer-headers');

const SECRET = 'shared-signing-secret';

test('sign → verify round-trips the viewer identity', () => {
  const headers = signViewerHeaders({ sub: 'alice', role: 'team-admin', teamIds: ['t2', 't1'] }, SECRET);
  const v = verifyViewerHeaders(headers, SECRET);
  assert.deepEqual(v, { sub: 'alice', role: 'team-admin', teamIds: ['t1', 't2'], teamRoles: {} });
});

test('the per-team role map is signed; roleForTeam answers per team and never elevates', () => {
  const { roleForTeam } = require('./viewer-headers');
  const headers = signViewerHeaders({
    sub: 'alice', role: 'team-admin', teamIds: ['t1', 't2'],
    teamRoles: { t1: 'team-admin', t2: 'team-member' },
  }, SECRET);
  const v = verifyViewerHeaders(headers, SECRET);
  assert.equal(roleForTeam(v, 't1'), 'team-admin');
  assert.equal(roleForTeam(v, 't2'), 'team-member'); // flat role is team-admin, but not HERE
  assert.equal(roleForTeam(v, 't3'), null);
  headers['x-aee-plugin-team-roles'] = 't1=team-admin,t2=team-admin';
  assert.equal(verifyViewerHeaders(headers, SECRET), null);
});

test('a forged / tampered signature is rejected', () => {
  const headers = signViewerHeaders({ sub: 'alice', role: 'team-member', teamIds: ['t1'] }, SECRET);
  // elevate the role without re-signing
  headers['x-aee-plugin-role'] = 'team-admin';
  assert.equal(verifyViewerHeaders(headers, SECRET), null);
  // wrong secret
  assert.equal(verifyViewerHeaders(signViewerHeaders({ sub: 'a', role: 'team-member' }, SECRET), 'other'), null);
  // missing signature
  assert.equal(verifyViewerHeaders({ 'x-aee-plugin-user': 'a' }, SECRET), null);
});

test('/admin needs team-admin; the board root needs team-member', () => {
  assert.equal(requiredRoleForPath('/admin'), 'team-admin');
  assert.equal(requiredRoleForPath('/admin/settings'), 'team-admin');
  assert.equal(requiredRoleForPath('/api/settings'), 'team-admin');
  // content migration (#1566): import is a Team-Admin board replace; export is a read
  assert.equal(requiredRoleForPath('/api/import'), 'team-admin');
  assert.equal(requiredRoleForPath('/api/export'), 'team-member');
  assert.equal(requiredRoleForPath('/'), 'team-member');
  assert.equal(requiredRoleForPath('/api/board'), 'team-member');

  assert.equal(roleAllows('team-member', 'team-admin'), false, 'member refused /admin');
  assert.equal(roleAllows('team-admin', 'team-admin'), true, 'admin served /admin');
  assert.equal(roleAllows('team-member', 'team-member'), true, 'member served board');
});
