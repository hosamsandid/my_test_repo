'use strict';

// Unit tests for the pure team-derived assist-synthesis binding decision (#1213).
// Run: node --test orchestrator/assist-binding.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { endpointScope, endpointUsableByTeam, pickAssistEndpoint } = require('./assist-binding');

const teamEp = { id: 'ep-team', scope: 'team', teamId: 'alpha', authType: 'api-key', defaultModelId: 'm1' };
const systemEp = { id: 'ep-sys', scope: 'system', assignedTeamIds: ['alpha', 'beta'], authType: 'api-key' };
const legacyEp = { id: 'ep-legacy', teamId: 'alpha' }; // pre-#798: no scope/authType
const oauthEp = { id: 'ep-oauth', scope: 'team', teamId: 'alpha', authType: 'oauth-token' };

test('endpointScope normalizes legacy + system records', () => {
  assert.equal(endpointScope(systemEp), 'system');
  assert.equal(endpointScope(teamEp), 'team');
  assert.equal(endpointScope(legacyEp), 'team'); // no scope field → team
  assert.equal(endpointScope(null), 'team');
});

test('endpointUsableByTeam — team-scoped is usable only by its owning team', () => {
  assert.equal(endpointUsableByTeam(teamEp, 'alpha'), true);
  assert.equal(endpointUsableByTeam(teamEp, 'beta'), false);
});

test('endpointUsableByTeam — system-scoped is usable by every assigned team', () => {
  assert.equal(endpointUsableByTeam(systemEp, 'alpha'), true);
  assert.equal(endpointUsableByTeam(systemEp, 'beta'), true);
  assert.equal(endpointUsableByTeam(systemEp, 'gamma'), false);
});

test('endpointUsableByTeam — legacy record (no scope) treated as team-scoped', () => {
  assert.equal(endpointUsableByTeam(legacyEp, 'alpha'), true);
  assert.equal(endpointUsableByTeam(legacyEp, 'beta'), false);
});

test('endpointUsableByTeam — missing teamId collapses to default', () => {
  const def = { id: 'ep-def', scope: 'team', teamId: 'default', authType: 'api-key' };
  assert.equal(endpointUsableByTeam(def, undefined), true);
  assert.equal(endpointUsableByTeam(def, null), true);
});

test('endpointUsableByTeam — oauth-token seats are never usable for synthesis', () => {
  assert.equal(endpointUsableByTeam(oauthEp, 'alpha'), false);
});

test('endpointUsableByTeam — junk input is safe', () => {
  assert.equal(endpointUsableByTeam(null, 'alpha'), false);
  assert.equal(endpointUsableByTeam('nope', 'alpha'), false);
});

const index = [teamEp, systemEp, legacyEp, oauthEp];

test('pickAssistEndpoint — unset id → unset (use .env)', () => {
  assert.deepEqual(pickAssistEndpoint(index, '', 'alpha'), { ep: null, reason: 'unset' });
  assert.deepEqual(pickAssistEndpoint(index, null, 'alpha'), { ep: null, reason: 'unset' });
});

test('pickAssistEndpoint — unknown id → not-found', () => {
  assert.deepEqual(pickAssistEndpoint(index, 'ghost', 'alpha'), { ep: null, reason: 'not-found' });
});

test('pickAssistEndpoint — oauth id → oauth-excluded', () => {
  assert.deepEqual(pickAssistEndpoint(index, 'ep-oauth', 'alpha'), { ep: null, reason: 'oauth-excluded' });
});

test('pickAssistEndpoint — foreign team → not-usable', () => {
  assert.deepEqual(pickAssistEndpoint(index, 'ep-team', 'beta'), { ep: null, reason: 'not-usable' });
});

test('pickAssistEndpoint — usable team-scoped id → ok with the record', () => {
  const r = pickAssistEndpoint(index, 'ep-team', 'alpha');
  assert.equal(r.reason, 'ok');
  assert.equal(r.ep, teamEp);
});

test('pickAssistEndpoint — usable system-scoped id for an assigned team → ok', () => {
  const r = pickAssistEndpoint(index, 'ep-sys', 'beta');
  assert.equal(r.reason, 'ok');
  assert.equal(r.ep, systemEp);
});

test('pickAssistEndpoint — a non-array index is tolerated (→ not-found)', () => {
  assert.deepEqual(pickAssistEndpoint(null, 'ep-team', 'alpha'), { ep: null, reason: 'not-found' });
  assert.deepEqual(pickAssistEndpoint(undefined, 'ep-team', 'alpha'), { ep: null, reason: 'not-found' });
});
