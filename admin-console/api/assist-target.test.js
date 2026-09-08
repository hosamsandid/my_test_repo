'use strict';

// Tests for the resolveAssistTarget decision logic (#1211). The admin-api suite
// has no HTTP/supertest harness (api.js doesn't export the express app), so — as
// with assist-model-options.test.js / process-template.js — the "route tests"
// the AC calls for are satisfied by driving the pure decision module over scopes
// produced by the real computeScope. The api.js wrapper adds only the impure
// bits (getScope, listLlmEndpoints, token read, .env material).
// Run: node --test admin-console/api/assist-target.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeScope } = require('./scope');
const { parseAssistSelection, resolveAssistSelection } = require('./assist-target');

const users = [
  { id: 'u-sys', subject: 'sys@corp.com', systemAdmin: true },
  { id: 'u-a', subject: 'alice@corp.com' },   // team-member of team A only
  { id: 'u-none', subject: 'nomad@corp.com' }, // no memberships
];
const memberships = [
  { userId: 'u-a', teamId: 'team-a', role: 'team-member' },
];

// Registry: team-a key (default model + a second model), team-b key (alice may
// NOT use it), a system key assigned to team-a, and an oauth-token seat (never
// billable). ep-a carries an explicit defaultModelId that is NOT the sonnet one,
// so we can prove "explicit wins / stale → default (not sonnet)".
const endpoints = [
  { id: 'ep-a', name: 'Team A key', authType: 'api-key', scope: 'team', teamId: 'team-a',
    authTokenId: 'ep-a-tok', baseUrl: 'https://proxy/a', defaultModelId: 'claude-haiku-4-5',
    models: [
      { id: 'claude-sonnet-4-6', kind: 'sonnet' },
      { id: 'claude-haiku-4-5', kind: 'haiku' },
      { id: 'claude-opus-4-8', kind: 'opus' },
    ] },
  { id: 'ep-b', name: 'Team B key', authType: 'api-key', scope: 'team', teamId: 'team-b',
    authTokenId: 'ep-b-tok', baseUrl: 'https://proxy/b',
    models: [{ id: 'claude-sonnet-4-6', kind: 'sonnet' }] },
  { id: 'ep-sys-a', name: 'Shared (A)', authType: 'api-key', scope: 'system', assignedTeamIds: ['team-a'],
    authTokenId: 'ep-sys-a-tok', baseUrl: 'https://proxy/sys',
    models: [{ id: 'm1' }] },
  { id: 'ep-oauth', name: 'Seat token', authType: 'oauth-token', scope: 'system', assignedTeamIds: ['team-a'],
    authTokenId: 'ep-oauth-tok', models: [{ id: 'x' }] },
];

const scopeFor = (subject) => computeScope({ username: subject, users, memberships });
const alice = () => scopeFor('alice@corp.com');
const nomad = () => scopeFor('nomad@corp.com');
const sys = () => scopeFor('sys@corp.com');

// ── parseAssistSelection ───────────────────────────────────────────────────

test('parseAssistSelection: X-Assist-Model header endpointId:modelId', () => {
  assert.deepEqual(
    parseAssistSelection({ headers: { 'x-assist-model': 'ep-a:claude-opus-4-8' } }),
    { endpointId: 'ep-a', modelId: 'claude-opus-4-8' });
});

test('parseAssistSelection: header with no colon = endpoint only', () => {
  assert.deepEqual(parseAssistSelection({ headers: { 'x-assist-model': 'ep-a' } }),
    { endpointId: 'ep-a', modelId: '' });
});

test('parseAssistSelection: legacy body.llmEndpointId fallback (no header)', () => {
  assert.deepEqual(parseAssistSelection({ headers: {}, body: { llmEndpointId: 'ep-a' } }),
    { endpointId: 'ep-a', modelId: '' });
});

test('parseAssistSelection: header wins over legacy body field', () => {
  assert.deepEqual(
    parseAssistSelection({ headers: { 'x-assist-model': 'ep-b:m' }, body: { llmEndpointId: 'ep-a' } }),
    { endpointId: 'ep-b', modelId: 'm' });
});

test('parseAssistSelection: nothing selected', () => {
  assert.deepEqual(parseAssistSelection({ headers: {}, body: {} }), { endpointId: '', modelId: '' });
});

// ── resolveAssistSelection ──────────────────────────────────────────────────

test('403 for a provider outside the caller\'s teams', () => {
  const d = resolveAssistSelection({ scope: alice(), endpoints, selection: { endpointId: 'ep-b' } });
  assert.equal(d.selectionError.status, 403);
  assert.equal(d.selectionError.code, 'assist-endpoint-not-permitted');
});

test('403 for an oauth-token seat even when assigned to the caller\'s team', () => {
  const d = resolveAssistSelection({ scope: alice(), endpoints, selection: { endpointId: 'ep-oauth' } });
  assert.equal(d.selectionError.status, 403);
});

test('403 for an unknown/stale endpoint id', () => {
  const d = resolveAssistSelection({ scope: alice(), endpoints, selection: { endpointId: 'ep-ghost' } });
  assert.equal(d.selectionError.status, 403);
});

test('400 when unselected while ≥1 selectable provider exists (no silent default)', () => {
  const d = resolveAssistSelection({ scope: alice(), endpoints, selection: {} });
  assert.equal(d.selectionError.status, 400);
  assert.equal(d.selectionError.code, 'assist-model-not-selected');
});

test('403 (fail closed) when providers exist but none are selectable and none chosen', () => {
  const d = resolveAssistSelection({ scope: nomad(), endpoints, selection: {} });
  assert.equal(d.selectionError.status, 403);
  assert.equal(d.selectionError.code, 'assist-endpoint-not-permitted');
});

test('.env fallback ONLY with an empty registry', () => {
  assert.deepEqual(resolveAssistSelection({ scope: sys(), endpoints: [], selection: {} }), { env: true });
  // With providers registered, an unselected System Admin still 400s — never .env.
  assert.equal(resolveAssistSelection({ scope: sys(), endpoints, selection: {} }).selectionError.status, 400);
});

test('explicit modelId is honored (sonnet preference dropped)', () => {
  const d = resolveAssistSelection({ scope: alice(), endpoints, selection: { endpointId: 'ep-a', modelId: 'claude-opus-4-8' } });
  assert.equal(d.model, 'claude-opus-4-8');
  assert.equal(d.endpointId, 'ep-a');
  assert.equal(d.baseUrl, 'https://proxy/a');
});

test('stale/absent modelId falls back to the provider defaultModelId (not sonnet) and reports it', () => {
  const stale = resolveAssistSelection({ scope: alice(), endpoints, selection: { endpointId: 'ep-a', modelId: 'gone-model' } });
  assert.equal(stale.model, 'claude-haiku-4-5'); // ep-a.defaultModelId, NOT the sonnet in its catalog
  const none = resolveAssistSelection({ scope: alice(), endpoints, selection: { endpointId: 'ep-a' } });
  assert.equal(none.model, 'claude-haiku-4-5');
});

test('default-pick falls to sonnet-kind, then first, when no defaultModelId', () => {
  const eps = [{ id: 'ep-x', authType: 'api-key', scope: 'system', assignedTeamIds: ['team-a'],
    baseUrl: 'https://x', authTokenId: 't',
    models: [{ id: 'first' }, { id: 's', kind: 'sonnet' }] }];
  const d = resolveAssistSelection({ scope: alice(), endpoints: eps, selection: { endpointId: 'ep-x' } });
  assert.equal(d.model, 's'); // no defaultModelId → sonnet-kind wins over first
});

test('legacy body.llmEndpointId is validated through the same gate', () => {
  // Permitted legacy id resolves; a non-permitted one 403s exactly like a header.
  const ok = resolveAssistSelection({ scope: alice(), endpoints, selection: parseAssistSelection({ headers: {}, body: { llmEndpointId: 'ep-a' } }) });
  assert.equal(ok.endpointId, 'ep-a');
  const denied = resolveAssistSelection({ scope: alice(), endpoints, selection: parseAssistSelection({ headers: {}, body: { llmEndpointId: 'ep-b' } }) });
  assert.equal(denied.selectionError.status, 403);
});

test('misconfigured permitted provider (no baseUrl / no models) → soft error, not a selection error', () => {
  const noUrl = [{ id: 'ep-a', authType: 'api-key', scope: 'team', teamId: 'team-a', authTokenId: 't',
    models: [{ id: 'm' }] }]; // no baseUrl
  const d1 = resolveAssistSelection({ scope: alice(), endpoints: noUrl, selection: { endpointId: 'ep-a' } });
  assert.match(d1.error, /no base URL/);
  assert.equal(d1.selectionError, undefined);

  const noModels = [{ id: 'ep-a', authType: 'api-key', scope: 'team', teamId: 'team-a', authTokenId: 't',
    baseUrl: 'https://a', models: [] }];
  const d2 = resolveAssistSelection({ scope: alice(), endpoints: noModels, selection: { endpointId: 'ep-a' } });
  assert.match(d2.error, /no models/);
});

test('requireSelection:false skips the 400 nudge and uses the neutral .env default (never a team key)', () => {
  // No header, providers exist but the caller opted out of forcing a pick →
  // no 400, and crucially NOT auto-picking a registered team provider (the bug).
  const d = resolveAssistSelection({ scope: alice(), endpoints, selection: {}, requireSelection: false });
  assert.equal(d.selectionError, undefined);
  assert.equal(d.env, true);
  assert.equal(d.endpoint, undefined); // never resolved to a specific team's key
});

test('System Admin may select any non-oauth provider', () => {
  const d = resolveAssistSelection({ scope: sys(), endpoints, selection: { endpointId: 'ep-b', modelId: 'claude-sonnet-4-6' } });
  assert.equal(d.endpointId, 'ep-b');
  assert.equal(d.model, 'claude-sonnet-4-6');
});
