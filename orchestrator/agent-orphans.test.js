'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ORPHAN_REASONS,
  classifyOrphan,
  planOrphanCleanup,
  formatOrphanLine,
} = require('./agent-orphans');

const team = (id, extra = {}) => ({ id, cfg: { role: 'team', ...extra } });
const member = (id, parentTeamId, extra = {}) => ({
  id,
  cfg: { role: 'team-member', ...(parentTeamId === undefined ? {} : { parentTeamId }), ...extra },
});

test('classifyOrphan: a member under a live team is not an orphan', () => {
  const byId = { alpha: { role: 'team' } };
  assert.strictEqual(
    classifyOrphan('alpha-dev', { role: 'team-member', parentTeamId: 'alpha' }, byId),
    null,
  );
});

test('classifyOrphan: only team-members are classified', () => {
  const byId = {};
  for (const role of ['agent', 'team', 'orchestrator', 'bp-instance', undefined]) {
    assert.strictEqual(classifyOrphan('x', { role, parentTeamId: 'gone' }, byId), null,
      `role ${JSON.stringify(role)} must not be classified as an orphan`);
  }
});

test('classifyOrphan: the three reasons are kept apart', () => {
  const byId = { standalone: { role: 'agent' } };
  assert.strictEqual(
    classifyOrphan('m1', { role: 'team-member' }, byId).reason,
    ORPHAN_REASONS.NO_PARENT_ID,
  );
  assert.strictEqual(
    classifyOrphan('m2', { role: 'team-member', parentTeamId: 'never-existed' }, byId).reason,
    ORPHAN_REASONS.PARENT_MISSING,
  );
  assert.strictEqual(
    classifyOrphan('m3', { role: 'team-member', parentTeamId: 'standalone' }, byId).reason,
    ORPHAN_REASONS.PARENT_NOT_A_TEAM,
  );
});

test('classifyOrphan: a blank parentTeamId reads as no parent id, not as a missing one', () => {
  const orphan = classifyOrphan('m', { role: 'team-member', parentTeamId: '   ' }, {});
  assert.strictEqual(orphan.reason, ORPHAN_REASONS.NO_PARENT_ID);
  assert.strictEqual(orphan.parentTeamId, null);
});

test('classifyOrphan: a config-less residue dir is not a resolvable parent', () => {
  // The id is present on disk but carries no config (#1525 B2) — a member
  // naming it has no team to inherit from, so it must still read as an orphan.
  const orphan = classifyOrphan('m', { role: 'team-member', parentTeamId: 'residue' }, { residue: null });
  assert.strictEqual(orphan.reason, ORPHAN_REASONS.PARENT_MISSING);
});

test('classifyOrphan: reports materialized vs stub without ever echoing the token', () => {
  const byId = {};
  const mat = classifyOrphan('m1', { role: 'team-member', parentTeamId: 'gone', token: 'syt_secret' }, byId);
  const stub = classifyOrphan('m2', { role: 'team-member', parentTeamId: 'gone' }, byId);
  assert.strictEqual(mat.materialized, true);
  assert.strictEqual(stub.materialized, false);
  assert.ok(!JSON.stringify(mat).includes('syt_secret'), 'the record must not carry the Matrix token');
});

test('planOrphanCleanup: finds materialized members and stubs, skips healthy ones', () => {
  const { scanned, orphans } = planOrphanCleanup([
    team('alpha'),
    member('alpha-dev', 'alpha', { token: 't' }),   // healthy, materialized
    member('alpha-qs', 'alpha'),                     // healthy, stub
    member('beta-dev', 'beta', { token: 't' }),      // orphan, materialized
    member('beta-qs', 'beta'),                       // orphan, stub
    { id: 'solo', cfg: { role: 'agent' } },
  ]);
  assert.strictEqual(scanned, 6);
  assert.deepStrictEqual(orphans.map(o => o.id), ['beta-dev', 'beta-qs']);
  assert.deepStrictEqual(orphans.map(o => o.materialized), [true, false]);
});

test('planOrphanCleanup: is deterministic — sorted by id regardless of scan order', () => {
  const entries = [member('z', 'gone'), member('a', 'gone'), member('m', 'gone')];
  assert.deepStrictEqual(planOrphanCleanup(entries).orphans.map(o => o.id), ['a', 'm', 'z']);
  assert.deepStrictEqual(planOrphanCleanup([...entries].reverse()).orphans.map(o => o.id), ['a', 'm', 'z']);
});

test('planOrphanCleanup: idempotent — a second pass over the survivors finds nothing', () => {
  const entries = [team('alpha'), member('alpha-dev', 'alpha'), member('beta-dev', 'beta')];
  const first = planOrphanCleanup(entries);
  const removed = new Set(first.orphans.map(o => o.id));
  const survivors = entries.filter(e => !removed.has(e.id));
  assert.deepStrictEqual(planOrphanCleanup(survivors).orphans, []);
});

test('planOrphanCleanup: an empty / missing workspace is not an error', () => {
  const empty = { scanned: 0, orphans: [], removable: [], reportOnly: [] };
  assert.deepStrictEqual(planOrphanCleanup([]), empty);
  assert.deepStrictEqual(planOrphanCleanup(null), empty);
});

test('planOrphanCleanup: a member naming a LIVE non-team parent is reported, never removed', () => {
  // The parent still exists, so the config is a typo to correct rather than an
  // agent to reap — deleting it would be over-reach.
  const plan = planOrphanCleanup([
    { id: 'solo', cfg: { role: 'agent' } },
    member('typo-member', 'solo'),
    member('real-orphan', 'gone'),
  ]);
  assert.deepStrictEqual(plan.orphans.map(o => o.id), ['real-orphan', 'typo-member']);
  assert.deepStrictEqual(plan.removable.map(o => o.id), ['real-orphan']);
  assert.deepStrictEqual(plan.reportOnly.map(o => o.id), ['typo-member']);
});

test('planOrphanCleanup: removable + reportOnly partition the findings exactly', () => {
  const plan = planOrphanCleanup([
    { id: 'solo', cfg: { role: 'agent' } },
    member('a', 'solo'), member('b', 'gone'), member('c', undefined), team('t'), member('d', 't'),
  ]);
  assert.strictEqual(plan.removable.length + plan.reportOnly.length, plan.orphans.length);
  assert.ok(plan.removable.every(o => o.removable));
  assert.ok(plan.reportOnly.every(o => !o.removable));
});

test('planOrphanCleanup: a whole deleted team yields every one of its members', () => {
  // The state an interrupted cascade leaves behind: the team is gone, its
  // members are not.
  const { orphans } = planOrphanCleanup([
    member('gamma-ba', 'gamma'),
    member('gamma-dev', 'gamma', { token: 't' }),
    member('gamma-qs', 'gamma'),
  ]);
  assert.strictEqual(orphans.length, 3);
  for (const o of orphans) assert.strictEqual(o.reason, ORPHAN_REASONS.PARENT_MISSING);
});

test('formatOrphanLine: names the id, the kind and the reason', () => {
  const [orphan] = planOrphanCleanup([member('beta-dev', 'beta', { token: 't' })]).orphans;
  const line = formatOrphanLine(orphan);
  assert.match(line, /beta-dev/);
  assert.match(line, /materialized/);
  assert.match(line, /parent team 'beta' does not exist/);
  const [stub] = planOrphanCleanup([member('beta-qs', 'beta')]).orphans;
  assert.match(formatOrphanLine(stub), /\(stub\)/);
});

test('formatOrphanLine: a report-only finding says so, so the log cannot be misread', () => {
  const { reportOnly } = planOrphanCleanup([
    { id: 'solo', cfg: { role: 'agent' } },
    member('typo-member', 'solo'),
  ]);
  assert.match(formatOrphanLine(reportOnly[0]), /reported only/);
});
