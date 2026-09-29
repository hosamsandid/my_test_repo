'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPushedBy } = require('./push-producer-filter');

const AGENTS = {
  't1-dev': { parentTeamId: 't1' },
  't1-spec': { parentTeamId: 't1' },
  't1-spec-i4': { parentTeamId: 't1', poolInstance: true, poolOf: 't1-spec' },
  't2-spec': { parentTeamId: 't2' },
  solo: { teamId: 'default' },
};
const opts = { ownerId: 't1-dev', lookupAgent: (id) => AGENTS[id] || null };
const push = (pushedBy) => ({ id: 'x', type: 'github-event', events: ['push'], repo: 'o/r', pushedBy });

test('absent field is untouched; null clears it', () => {
  const t = { id: 'x', type: 'github-event', events: ['push'] };
  assert.equal(applyPushedBy(t, opts).trigger, t);
  assert.equal('pushedBy' in applyPushedBy(push(null), opts).trigger, false);
});

test('[] is kept as explicit "any push"', () => {
  assert.deepEqual(applyPushedBy(push([]), opts).trigger.pushedBy, []);
  assert.deepEqual(applyPushedBy({ id: 'c', type: 'cron', pushedBy: [] }, opts).trigger.pushedBy, []);
});

test('same-team ids are accepted, trimmed and de-duplicated (the owner itself is allowed)', () => {
  assert.deepEqual(applyPushedBy(push([' t1-spec', 't1-spec', 't1-dev']), opts).trigger.pushedBy, ['t1-spec', 't1-dev']);
});

test('rejects other-team, unknown and pool-instance ids', () => {
  assert.match(applyPushedBy(push(['t2-spec']), opts).error, /not an agent of this Agent Team/);
  assert.match(applyPushedBy(push(['ghost']), opts).error, /not an agent of this Agent Team/);
  assert.match(applyPushedBy(push(['t1-spec-i4']), opts).error, /pool instance.*'t1-spec'/);
});

test('rejects a filter on a non-push trigger, a malformed value, or a teamless owner', () => {
  assert.match(applyPushedBy({ ...push(['t1-spec']), events: ['issues.labeled'] }, opts).error, /push triggers only/);
  assert.match(applyPushedBy({ id: 'c', type: 'cron', pushedBy: ['t1-spec'] }, opts).error, /push triggers only/);
  assert.match(applyPushedBy(push('t1-spec'), opts).error, /array/);
  assert.match(applyPushedBy(push([3]), opts).error, /array/);
  assert.match(applyPushedBy(push(['t1-spec']), { ...opts, ownerId: 'solo' }).error, /Agent Team/);
});
