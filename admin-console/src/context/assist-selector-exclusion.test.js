import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REASON_ALL_OAUTH,
  REASON_TEAM_SCOPE,
  REASON_MIXED,
  classifyExclusions,
  exclusionMessage,
  endpointAssistExclusion,
  assistExclusionInName,
  assistExclusionInBaseUrl,
} from './assist-selector-exclusion.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

const EP_OAUTH = { id: 'ep-oauth', authType: 'oauth-token', scope: 'system', assignedTeamIds: ['t1'] };
const EP_SYSTEM_T1 = { id: 'ep-sys-t1', authType: 'api-key', scope: 'system', assignedTeamIds: ['t1'] };
const EP_SYSTEM_T2 = { id: 'ep-sys-t2', authType: 'api-key', scope: 'system', assignedTeamIds: ['t2'] };
const EP_TEAM_T1   = { id: 'ep-team-t1', authType: 'api-key', scope: 'team', teamId: 't1' };
const EP_TEAM_T2   = { id: 'ep-team-t2', authType: 'api-key', scope: 'team', teamId: 't2' };
const EP_ENV_RO    = { id: '.env', readOnly: true, authType: 'api-key' };

// ── classifyExclusions ────────────────────────────────────────────────────────

test('classifyExclusions: null when no endpoints registered', () => {
  assert.equal(classifyExclusions([], ['t1'], false), null);
  assert.equal(classifyExclusions(null, ['t1'], false), null);
});

test('classifyExclusions: null when only the .env read-only entry exists', () => {
  assert.equal(classifyExclusions([EP_ENV_RO], ['t1'], false), null);
});

test('classifyExclusions: null for sysadmin (can select everything)', () => {
  assert.equal(classifyExclusions([EP_OAUTH, EP_SYSTEM_T2], ['t1'], true), null);
});

test('classifyExclusions: REASON_ALL_OAUTH when every real endpoint is oauth', () => {
  const result = classifyExclusions([EP_OAUTH], ['t1'], false);
  assert.equal(result?.reason, REASON_ALL_OAUTH);
  assert.equal(result?.oauthCount, 1);
  assert.equal(result?.teamScopeCount, 0);
});

test('classifyExclusions: REASON_ALL_OAUTH with multiple oauth endpoints', () => {
  const ep2 = { ...EP_OAUTH, id: 'ep-oauth-2' };
  const result = classifyExclusions([EP_OAUTH, ep2], ['t1'], false);
  assert.equal(result?.reason, REASON_ALL_OAUTH);
  assert.equal(result?.oauthCount, 2);
});

test('classifyExclusions: REASON_TEAM_SCOPE when system provider not assigned to user team', () => {
  const result = classifyExclusions([EP_SYSTEM_T2], ['t1'], false);
  assert.equal(result?.reason, REASON_TEAM_SCOPE);
  assert.equal(result?.teamScopeCount, 1);
  assert.equal(result?.oauthCount, 0);
});

test('classifyExclusions: REASON_TEAM_SCOPE when team-scoped provider belongs to another team', () => {
  const result = classifyExclusions([EP_TEAM_T2], ['t1'], false);
  assert.equal(result?.reason, REASON_TEAM_SCOPE);
});

test('classifyExclusions: REASON_MIXED when both oauth and team-mismatch providers exist', () => {
  const result = classifyExclusions([EP_OAUTH, EP_SYSTEM_T2], ['t1'], false);
  assert.equal(result?.reason, REASON_MIXED);
  assert.equal(result?.oauthCount, 1);
  assert.equal(result?.teamScopeCount, 1);
});

test('classifyExclusions: null when all endpoints are actually selectable', () => {
  const result = classifyExclusions([EP_SYSTEM_T1], ['t1'], false);
  assert.equal(result, null);
});

test('classifyExclusions: ignores read-only .env entry alongside oauth endpoints', () => {
  const result = classifyExclusions([EP_ENV_RO, EP_OAUTH], ['t1'], false);
  assert.equal(result?.reason, REASON_ALL_OAUTH);
  assert.equal(result?.oauthCount, 1);
});

test('classifyExclusions: user with multiple teams can select system provider assigned to one', () => {
  const result = classifyExclusions([EP_SYSTEM_T1], ['t1', 't2'], false);
  assert.equal(result, null);
});

// ── exclusionMessage ──────────────────────────────────────────────────────────

test('exclusionMessage: null for null classification', () => {
  assert.equal(exclusionMessage(null), null);
});

test('exclusionMessage: returns title and detail for all-oauth', () => {
  const msg = exclusionMessage({ reason: REASON_ALL_OAUTH, oauthCount: 1, teamScopeCount: 0 });
  assert.ok(typeof msg?.title === 'string' && msg.title.length > 0);
  assert.ok(typeof msg?.detail === 'string' && msg.detail.length > 0);
  assert.ok(msg.title.toLowerCase().includes('oauth'));
  assert.ok(msg.detail.toLowerCase().includes('api-key'));
});

test('exclusionMessage: returns title and detail for team-scope', () => {
  const msg = exclusionMessage({ reason: REASON_TEAM_SCOPE, oauthCount: 0, teamScopeCount: 1 });
  assert.ok(typeof msg?.title === 'string');
  assert.ok(typeof msg?.detail === 'string');
  assert.ok(msg.detail.toLowerCase().includes('system admin'));
});

test('exclusionMessage: returns title and detail for mixed', () => {
  const msg = exclusionMessage({ reason: REASON_MIXED, oauthCount: 1, teamScopeCount: 1 });
  assert.ok(typeof msg?.title === 'string');
  assert.ok(typeof msg?.detail === 'string');
  assert.ok(msg.detail.toLowerCase().includes('system admin'));
});

// ── endpointAssistExclusion ───────────────────────────────────────────────────

test('endpointAssistExclusion: null for read-only .env entry', () => {
  assert.equal(endpointAssistExclusion(EP_ENV_RO, ['t1'], false), null);
});

test('endpointAssistExclusion: "oauth" for oauth-token endpoint', () => {
  assert.equal(endpointAssistExclusion(EP_OAUTH, ['t1'], false), 'oauth');
});

test('endpointAssistExclusion: "oauth" even for sysadmin (oauth is absolute exclusion)', () => {
  assert.equal(endpointAssistExclusion(EP_OAUTH, ['t1'], true), 'oauth');
});

test('endpointAssistExclusion: null for sysadmin on non-oauth endpoint', () => {
  assert.equal(endpointAssistExclusion(EP_SYSTEM_T2, ['t1'], true), null);
});

test('endpointAssistExclusion: "team-scope" for system provider not in user teams', () => {
  assert.equal(endpointAssistExclusion(EP_SYSTEM_T2, ['t1'], false), 'team-scope');
});

test('endpointAssistExclusion: null when system provider is in user teams', () => {
  assert.equal(endpointAssistExclusion(EP_SYSTEM_T1, ['t1'], false), null);
});

test('endpointAssistExclusion: "team-scope" for team-scoped provider in different team', () => {
  assert.equal(endpointAssistExclusion(EP_TEAM_T2, ['t1'], false), 'team-scope');
});

test('endpointAssistExclusion: null for team-scoped provider in user team', () => {
  assert.equal(endpointAssistExclusion(EP_TEAM_T1, ['t1'], false), null);
});

// ── badge placement on the Model Providers table (#2405) ────────────────────

test('assistExclusionInName: only the team-scope ("Not your teams") badge stays in the Name column', () => {
  assert.equal(assistExclusionInName('team-scope'), true);
  assert.equal(assistExclusionInName('oauth'), false);
  assert.equal(assistExclusionInName(null), false);
});

test('assistExclusionInBaseUrl: the oauth ("Agents only") badge moves to the Base URL cell', () => {
  assert.equal(assistExclusionInBaseUrl('oauth'), true);
  assert.equal(assistExclusionInBaseUrl('team-scope'), false);
  assert.equal(assistExclusionInBaseUrl(null), false);
});

test('badge placement is mutually exclusive — no exclusion reason lands in both columns', () => {
  for (const reason of ['oauth', 'team-scope', null]) {
    assert.equal(assistExclusionInName(reason) && assistExclusionInBaseUrl(reason), false);
  }
});
