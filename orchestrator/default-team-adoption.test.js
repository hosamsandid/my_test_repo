'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  needsAdoption,
  planAdoption,
  adoptionCount,
  planBootstrapMembership,
  DEFAULT_TEAM_ID,
  BOOTSTRAP_TEAM_ROLE,
} = require('./default-team-adoption');

// ── needsAdoption / planAdoption ────────────────────────────────────────────

test('needsAdoption is true only for a record with no teamId key at all', () => {
  assert.equal(needsAdoption({ id: 'a' }), true);
  assert.equal(needsAdoption({ id: 'a', teamId: undefined }), true);
  assert.equal(needsAdoption({ id: 'a', teamId: 'default' }), false);
  assert.equal(needsAdoption({ id: 'a', teamId: 'other' }), false);
  assert.equal(needsAdoption({ id: 'a', teamId: '' }), false);
});

// The whole reason the predicate is `=== undefined` and not a falsy check.
test('a personal credential (teamId: null + userId) is never adopted', () => {
  const personal = { id: 'k1', teamId: null, userId: 'u1', scope: 'personal' };
  assert.equal(needsAdoption(personal), false);
  assert.deepEqual(planAdoption([{ key: 0, record: personal }]), []);
});

test('needsAdoption tolerates non-records', () => {
  for (const bad of [null, undefined, 'x', 7, []]) {
    assert.equal(needsAdoption(bad), false, `expected false for ${JSON.stringify(bad)}`);
  }
});

test('planAdoption returns only the unowned entries, in input order', () => {
  const entries = [
    { key: 0, record: { id: 'owned', teamId: 'team-a' } },
    { key: 1, record: { id: 'unowned-1' } },
    { key: 2, record: { id: 'personal', teamId: null, userId: 'u1' } },
    { key: 3, record: { id: 'unowned-2' } },
  ];
  assert.deepEqual(planAdoption(entries).map(e => e.key), [1, 3]);
});

test('planAdoption skips malformed entries instead of throwing', () => {
  const entries = [null, { key: 0 }, { key: 1, record: null }, { key: 2, record: { id: 'x' } }];
  assert.deepEqual(planAdoption(entries).map(e => e.key), [2]);
  assert.deepEqual(planAdoption(), []);
  assert.deepEqual(planAdoption('not-an-array'), []);
});

test('planAdoption is idempotent — a stamped set has nothing left to adopt', () => {
  const list = [{ id: 'a' }, { id: 'b', teamId: 'team-a' }];
  const entries = () => list.map((record, key) => ({ key, record }));
  for (const { record } of planAdoption(entries())) record.teamId = DEFAULT_TEAM_ID;
  assert.deepEqual(planAdoption(entries()), []);
});

// The counting bug this replaces: the old pass added `list.length` whenever any
// entry in an index changed, so one unowned entry among fifty reported fifty.
test('adoptionCount counts changed records, not the size of the index', () => {
  const list = [{ id: 'a' }, ...Array.from({ length: 49 }, (_, i) => ({ id: `b${i}`, teamId: 'team-a' }))];
  assert.equal(adoptionCount(list.map((record, key) => ({ key, record }))), 1);
  assert.equal(adoptionCount([]), 0);
});

// ── planBootstrapMembership ─────────────────────────────────────────────────

test('the bootstrap admin gets a team-admin membership on the Default Team', () => {
  assert.deepEqual(
    planBootstrapMembership({ userId: 'u1', memberships: [] }),
    { userId: 'u1', teamId: DEFAULT_TEAM_ID, role: BOOTSTRAP_TEAM_ROLE },
  );
  assert.equal(BOOTSTRAP_TEAM_ROLE, 'team-admin');
});

test('no bootstrap admin (nothing seeded) plans no membership', () => {
  assert.equal(planBootstrapMembership({ userId: undefined, memberships: [] }), null);
  assert.equal(planBootstrapMembership({ userId: '', memberships: [] }), null);
  assert.equal(planBootstrapMembership(), null);
});

test('an existing team-admin membership is not re-asserted', () => {
  const memberships = [{ userId: 'u1', teamId: 'default', role: 'team-admin' }];
  assert.equal(planBootstrapMembership({ userId: 'u1', memberships }), null);
});

// setMembership is an upsert, so re-asserting would silently re-promote.
test('a deliberately demoted admin is left demoted, not re-promoted every boot', () => {
  const memberships = [{ userId: 'u1', teamId: 'default', role: 'team-member' }];
  assert.equal(planBootstrapMembership({ userId: 'u1', memberships }), null);
});

test('a membership in another team does not satisfy the Default Team one', () => {
  const memberships = [{ userId: 'u1', teamId: 'team-a', role: 'team-admin' }];
  assert.deepEqual(
    planBootstrapMembership({ userId: 'u1', memberships }),
    { userId: 'u1', teamId: DEFAULT_TEAM_ID, role: BOOTSTRAP_TEAM_ROLE },
  );
});

test('another user holding the role does not satisfy this admin', () => {
  const memberships = [{ userId: 'u2', teamId: 'default', role: 'team-admin' }];
  assert.deepEqual(planBootstrapMembership({ userId: 'u1', memberships }).userId, 'u1');
});

test('planBootstrapMembership tolerates a malformed membership list', () => {
  assert.equal(planBootstrapMembership({ userId: 'u1', memberships: 'nope' }), null);
  assert.deepEqual(
    planBootstrapMembership({ userId: 'u1', memberships: [null, {}, { userId: 'u1' }] }),
    { userId: 'u1', teamId: DEFAULT_TEAM_ID, role: BOOTSTRAP_TEAM_ROLE },
  );
});

// ── wiring guards over orchestrator.js ──────────────────────────────────────
//
// bootstrapTeams / backfillResourceOwnership are not exported from the 14k-line
// module, so the only way to assert they USE the decisions above is to read the
// source. Comments are stripped first: this ticket adds comments naming the very
// things the assertions look for.

// ORDER MATTERS: line comments are stripped FIRST. A `//` comment mentioning a
// glob such as `/api/*` or `**/*.js` contains a `/*` that pairs with the next
// real `*/` far below, so stripping block comments first silently swallows the
// code being asserted on (this bit the sibling guard in api.js).
function orchestratorSource() {
  const raw = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');
  return raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

test('backfillResourceOwnership adopts MCP servers', () => {
  const src = orchestratorSource();
  const at = src.indexOf('function backfillResourceOwnership');
  assert.ok(at > 0, 'backfillResourceOwnership not found');
  const body = src.slice(at, src.indexOf('\nfunction ', at + 10));
  assert.match(body, /MCP_SERVERS_DIR/, 'the MCP server registry is not walked');
  assert.match(body, /needsAdoption\(server\)/, 'the MCP stamp does not use the shared predicate');
  assert.match(body, /planAdoption\(/, 'the credential indexes do not use the shared plan');
  assert.doesNotMatch(body, /stamped \+= list\.length/, 'the over-reporting count is back');
});

test('bootstrapTeams creates the Default-Team membership through the plan', () => {
  const src = orchestratorSource();
  const at = src.indexOf('function bootstrapTeams');
  assert.ok(at > 0, 'bootstrapTeams not found');
  const body = src.slice(at, src.indexOf('\nfunction ', at + 10));
  assert.match(body, /planBootstrapMembership\(/, 'the membership is not planned');
  assert.match(body, /teamsStore\.setMembership\(membership\)/, 'the planned membership is not written');
  // The guard that matters: the write must be conditional on the plan, or a
  // human's demotion is undone on the next boot.
  assert.match(body, /if \(membership\)\s*\{/, 'setMembership is not gated on the plan');
});
