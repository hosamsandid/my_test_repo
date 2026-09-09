'use strict';

// Unit tests for the pure scoping + query builder behind the agent-facing
// read-only usage surface (#679). Covers the fail-closed scoping (AC2/AC3 and
// the edge cases: unknown/teamless agent → never all-teams; no records →
// zeroed, not an error), the four-class output (AC4), and the no-dollar-figure
// guarantee (AC4, asserted by grepping the serialised output).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUsageQuery, scopeRecords, normalizeScope } = require('./usage-query');

// A tiny hand-rolled record set spanning two agents across two teams.
function rec(agentId, teamId, tokens, ts, modelUsage) {
  const r = { agentId, teamId, ts, tokens };
  if (modelUsage) r.modelUsage = modelUsage;
  return r;
}
const RECORDS = [
  rec('dev-1', 'team-a', { input: 10, output: 5, cacheCreationInput: 1, cacheReadInput: 2 }, '2026-07-16T09:00:00Z'),
  rec('dev-1', 'team-a', { input: 20, output: 4, cacheCreationInput: 0, cacheReadInput: 0 }, '2026-07-16T10:00:00Z'),
  rec('rev-1', 'team-a', { input: 3, output: 3, cacheCreationInput: 0, cacheReadInput: 0 }, '2026-07-16T11:00:00Z'),
  rec('spy-1', 'team-b', { input: 999, output: 999, cacheCreationInput: 9, cacheReadInput: 9 }, '2026-07-16T12:00:00Z'),
];

test('normalizeScope: only self|team, defaults to self', () => {
  assert.equal(normalizeScope('self'), 'self');
  assert.equal(normalizeScope('team'), 'team');
  assert.equal(normalizeScope('all'), 'self');
  assert.equal(normalizeScope(undefined), 'self');
  assert.equal(normalizeScope('other-team'), 'self');
});

test('scope self returns only the agent\'s own records', () => {
  const out = scopeRecords(RECORDS, { scope: 'self', agentId: 'dev-1', teamId: 'team-a' });
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.agentId === 'dev-1'));
});

test('scope team returns the whole team, never another team (AC2/AC3)', () => {
  const out = scopeRecords(RECORDS, { scope: 'team', agentId: 'dev-1', teamId: 'team-a' });
  assert.equal(out.length, 3);
  assert.ok(out.every((r) => r.teamId === 'team-a'));
  // team-b's record is never present when querying as a team-a agent.
  assert.ok(!out.some((r) => r.teamId === 'team-b'));
});

test('fail-closed: team scope with unresolved teamId → empty, never all-teams', () => {
  for (const teamId of [null, undefined, '']) {
    const out = scopeRecords(RECORDS, { scope: 'team', agentId: 'ghost', teamId });
    assert.deepEqual(out, [], `teamId=${JSON.stringify(teamId)}`);
  }
});

test('fail-closed: self scope with no agentId → empty', () => {
  assert.deepEqual(scopeRecords(RECORDS, { scope: 'self', agentId: '', teamId: 'team-a' }), []);
});

test('buildUsageQuery self: four classes + total + invocations, scoped to the agent', () => {
  const q = buildUsageQuery(RECORDS, { scope: 'self', agentId: 'dev-1', teamId: 'team-a', groupBy: 'agent' });
  assert.equal(q.scope, 'self');
  assert.equal(q.agentId, 'dev-1');
  assert.equal(q.teamId, null); // self scope does not expose a team id
  assert.equal(q.tokensOnly, true);
  assert.deepEqual(q.tokenClasses, ['input', 'output', 'cacheCreationInput', 'cacheReadInput']);
  assert.deepEqual(q.totals, {
    input: 30, output: 9, cacheCreationInput: 1, cacheReadInput: 2, total: 42, invocations: 2,
  });
  for (const k of ['input', 'output', 'cacheCreationInput', 'cacheReadInput', 'total']) {
    assert.ok(k in q.totals, `totals missing ${k}`);
  }
});

test('buildUsageQuery team: aggregate over the team only, carries teamId', () => {
  const q = buildUsageQuery(RECORDS, { scope: 'team', agentId: 'dev-1', teamId: 'team-a', groupBy: 'agent' });
  assert.equal(q.scope, 'team');
  assert.equal(q.teamId, 'team-a');
  assert.equal(q.totals.invocations, 3);
  assert.equal(q.totals.total, 42 + 6); // dev-1's 42 + rev-1's 6
  // grouped per member, and team-b never leaks in
  assert.ok(!q.groups.some((g) => g.key === 'spy-1'));
});

test('edge: no records for the agent/team → zeroed result, not an error', () => {
  const q = buildUsageQuery([], { scope: 'self', agentId: 'dev-1', teamId: 'team-a' });
  assert.deepEqual(q.totals, {
    input: 0, output: 0, cacheCreationInput: 0, cacheReadInput: 0, total: 0, invocations: 0,
  });
  assert.deepEqual(q.groups, []);
});

test('edge: unknown/teamless agent on team scope → zeroed, never another team', () => {
  const q = buildUsageQuery(RECORDS, { scope: 'team', agentId: 'ghost', teamId: null });
  assert.equal(q.teamId, null);
  assert.equal(q.totals.total, 0);
  assert.equal(q.totals.invocations, 0);
  assert.deepEqual(q.groups, []);
});

test('AC4: serialised output carries no dollar/cost figures', () => {
  // Even if a raw record smuggled a costUsd, summarize only surfaces the four
  // token classes, so the query output can never leak a money figure.
  const dirty = RECORDS.map((r) => ({ ...r, costUsd: 1.23, totalCostUsd: 4.56 }));
  for (const scope of ['self', 'team']) {
    for (const groupBy of ['agent', 'model', 'team', 'provider', 'day']) {
      const q = buildUsageQuery(dirty, { scope, agentId: 'dev-1', teamId: 'team-a', groupBy });
      const json = JSON.stringify(q).toLowerCase();
      assert.ok(!/cost|usd|dollar|price/.test(json), `money leaked for scope=${scope} groupBy=${groupBy}`);
    }
  }
});

// ── #2137: the agent-facing grouping allowlist ──────────────────────────────
//
// The console's per-user breakdown is System-Admin-only (#801). The agent CLI's
// own whitelist is an affordance, not a boundary — an agent can call the
// internal endpoint directly — so the refusal has to live here.

const { AGENT_GROUP_BY, normalizeAgentGroupBy } = require('./usage-query');

test('#2137: an agent may not group its team\'s usage per human', () => {
  const attributed = [
    { agentId: 'dev-1', teamId: 'team-a', ts: '2026-09-01T09:00:00Z',
      tokens: { input: 1, output: 0, cacheCreationInput: 0, cacheReadInput: 0 },
      attribution: { userId: 'u-ada', kind: 'requesting-user' } },
    { agentId: 'rev-1', teamId: 'team-a', ts: '2026-09-01T10:00:00Z',
      tokens: { input: 2, output: 0, cacheCreationInput: 0, cacheReadInput: 0 },
      attribution: { userId: 'u-bob', kind: 'agent-owner' } },
  ];
  for (const scope of ['self', 'team']) {
    const q = buildUsageQuery(attributed, { scope, agentId: 'dev-1', teamId: 'team-a', groupBy: 'user' });
    // Coerced to the default and ECHOED, so the caller sees what it got rather
    // than reading agent keys as if they were people.
    assert.equal(q.groupBy, 'agent', scope);
    assert.ok(!q.groups.some((g) => g.key === 'u-ada' || g.key === 'u-bob'),
      `a user key reached an agent under scope=${scope}`);
    // No account id anywhere in the serialised answer.
    assert.ok(!JSON.stringify(q).includes('u-ada'), scope);
  }
});

test('#2137: an agent MAY group by provider tier — no personal data, and it aids budget awareness', () => {
  const tiered = [
    { agentId: 'dev-1', teamId: 'team-a', ts: '2026-09-01T09:00:00Z', providerTier: 'global',
      tokens: { input: 5, output: 0, cacheCreationInput: 0, cacheReadInput: 0 } },
    { agentId: 'dev-1', teamId: 'team-a', ts: '2026-09-01T10:00:00Z', providerTier: 'team',
      tokens: { input: 7, output: 0, cacheCreationInput: 0, cacheReadInput: 0 } },
  ];
  const q = buildUsageQuery(tiered, { scope: 'self', agentId: 'dev-1', groupBy: 'providerTier' });
  assert.equal(q.groupBy, 'providerTier');
  assert.deepEqual(q.groups.map((g) => g.key).sort(), ['global', 'team']);
});

test('#2137: the allowlist is a strict subset of the aggregator groupings', () => {
  const { GROUP_BY } = require('./usage-summary');
  for (const g of AGENT_GROUP_BY) {
    assert.ok(GROUP_BY.has(g), `${g} is offered to agents but unknown to the aggregator`);
  }
  assert.ok(AGENT_GROUP_BY.size < GROUP_BY.size, 'the allowlist must withhold something');
  assert.ok(!AGENT_GROUP_BY.has('user'));
  // Every pre-#2137 grouping is still reachable — no regression for the CLI.
  for (const g of ['agent', 'team', 'model', 'provider', 'day']) assert.ok(AGENT_GROUP_BY.has(g), g);
});

test('#2137: normalizeAgentGroupBy returns undefined for anything withheld or unknown', () => {
  assert.equal(normalizeAgentGroupBy('day'), 'day');
  for (const bad of ['user', 'nonsense', '', null, undefined, 'USER']) {
    assert.equal(normalizeAgentGroupBy(bad), undefined, String(bad));
  }
});
