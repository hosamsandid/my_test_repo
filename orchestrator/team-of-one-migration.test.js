'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyCandidate,
  planTeamOfOneMigration,
  formatMigrationLine,
} = require('./team-of-one-migration');

const agent = (id, extra = {}) => ({ id, cfg: { role: 'agent', token: 't', ...extra } });

test('classifyCandidate: only role:agent is classified', () => {
  const cfg = { role: 'agent', token: 't' };
  for (const role of ['team', 'team-member', 'orchestrator', 'bp-instance']) {
    assert.strictEqual(classifyCandidate('x', { ...cfg, role }), null,
      `role ${role} must not be classified`);
  }
  assert.notStrictEqual(classifyCandidate('x', cfg), null);
});

test('classifyCandidate: an id with no config is not classified', () => {
  assert.strictEqual(classifyCandidate('x', null), null);
  assert.strictEqual(classifyCandidate(null, { role: 'agent' }), null);
});

test('classifyCandidate: reuses assessConversionEligibility rather than re-deriving it', () => {
  // A team-member or a team is never even reachable here (filtered on role
  // first), but an agent still mid-provisioning (no token) must come back
  // ineligible via the SAME predicate the retired manual conversion used.
  const stub = classifyCandidate('a', { role: 'agent' });
  assert.strictEqual(stub.eligible, false);
  assert.strictEqual(stub.code, 'stub');

  const ephemeral = classifyCandidate('a', { role: 'agent', token: 't', ephemeral: true });
  assert.strictEqual(ephemeral.eligible, false);
  assert.strictEqual(ephemeral.code, 'ephemeral');

  const ok = classifyCandidate('a', { role: 'agent', token: 't' });
  assert.strictEqual(ok.eligible, true);
  assert.strictEqual(ok.code, 'eligible');
});

test('planTeamOfOneMigration: finds every standalone agent, skips teams and members', () => {
  const { scanned, candidates } = planTeamOfOneMigration([
    agent('solo-a'),
    agent('solo-b'),
    { id: 'alpha', cfg: { role: 'team' } },
    { id: 'alpha-dev', cfg: { role: 'team-member', parentTeamId: 'alpha', token: 't' } },
  ]);
  assert.strictEqual(scanned, 4);
  assert.deepStrictEqual(candidates.map(c => c.id), ['solo-a', 'solo-b']);
});

test('planTeamOfOneMigration: an ineligible standalone agent is reported, not silently dropped', () => {
  const { candidates, ineligible } = planTeamOfOneMigration([
    agent('ready'),
    { id: 'provisioning', cfg: { role: 'agent' } }, // no token yet — a stub
  ]);
  assert.deepStrictEqual(candidates.map(c => c.id), ['ready']);
  assert.strictEqual(ineligible.length, 1);
  assert.strictEqual(ineligible[0].id, 'provisioning');
  assert.strictEqual(ineligible[0].code, 'stub');
});

test('planTeamOfOneMigration: deterministic — sorted by id regardless of scan order', () => {
  const entries = [agent('z'), agent('a'), agent('m')];
  assert.deepStrictEqual(planTeamOfOneMigration(entries).candidates.map(c => c.id), ['a', 'm', 'z']);
  assert.deepStrictEqual(planTeamOfOneMigration([...entries].reverse()).candidates.map(c => c.id), ['a', 'm', 'z']);
});

test('planTeamOfOneMigration: idempotent — a second pass over the survivors finds nothing', () => {
  const entries = [agent('solo-a'), agent('solo-b')];
  const first = planTeamOfOneMigration(entries);
  // Simulate the first pass having converted every candidate into a team of
  // one: they now carry role: 'team-member' and are no longer candidates.
  const survivors = entries.map(e => ({ id: e.id, cfg: { role: 'team-member', parentTeamId: `${e.id}-team`, token: 't' } }));
  assert.strictEqual(first.candidates.length, 2);
  assert.deepStrictEqual(planTeamOfOneMigration(survivors).candidates, []);
});

test('planTeamOfOneMigration: an empty / missing workspace is not an error', () => {
  const empty = { scanned: 0, candidates: [], ineligible: [] };
  assert.deepStrictEqual(planTeamOfOneMigration([]), empty);
  assert.deepStrictEqual(planTeamOfOneMigration(null), empty);
});

test('formatMigrationLine: names the id and the outcome', () => {
  const [candidate] = planTeamOfOneMigration([agent('solo-a')]).candidates;
  assert.match(formatMigrationLine(candidate), /solo-a — eligible for migration/);

  const [skipped] = planTeamOfOneMigration([{ id: 'stub', cfg: { role: 'agent' } }]).ineligible;
  assert.match(formatMigrationLine(skipped), /stub — skipped \(.*provisioning.*\)/);
});
