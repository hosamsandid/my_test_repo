'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OWNER_LABEL_KEY, ownerLabelArg, isOwned, filterOwned, scopeFilter } = require('./scope-filter');

const c = (scopeId, extra = {}) => ({ Labels: scopeId ? { [OWNER_LABEL_KEY]: scopeId, ...extra } : { ...extra } });

test('uses the platform plugin owner label', () => {
  assert.equal(OWNER_LABEL_KEY, 'aee.plugin.owner');
  assert.equal(ownerLabelArg('team-abc'), 'aee.plugin.owner=team-abc');
});

test('isOwned matches exactly, never loosely', () => {
  assert.equal(isOwned(c('team-abc'), 'team-abc'), true);
  assert.equal(isOwned(c('team-abc'), 'team-ab'), false); // no prefix match
  assert.equal(isOwned(c('team-abcd'), 'team-abc'), false);
  assert.equal(isOwned(c(null), 'team-abc'), false); // unlabelled never owned
  assert.equal(isOwned(c('team-abc'), ''), false); // empty scope owns nothing
  assert.equal(isOwned(null, 'team-abc'), false);
});

// The core acceptance: isolation is identical at both granularities because the
// scopeId is opaque — the same code path serves team-vs-team and member-vs-member.
test('cross-scope isolation — team vs team', () => {
  const list = [c('team-abc'), c('team-xyz'), c('team-abc')];
  const abc = scopeFilter('team-abc');
  assert.equal(abc.filter(list).length, 2);
  assert.equal(abc.owns(c('team-xyz')), false); // team-abc cannot operate on team-xyz's resource
});

test('cross-scope isolation — member vs member (agent granularity), same code path', () => {
  const list = [c('agent-aaaa'), c('agent-bbbb'), c('agent-aaaa')];
  const aaaa = scopeFilter('agent-aaaa');
  assert.equal(aaaa.filter(list).length, 2);
  assert.equal(aaaa.owns(c('agent-bbbb')), false); // member aaaa cannot operate on member bbbb's resource
  // No branch on the scopeId shape: an agent scope filters exactly like a team scope.
  assert.deepEqual(
    filterOwned(list, 'agent-aaaa').map((x) => x.Labels[OWNER_LABEL_KEY]),
    ['agent-aaaa', 'agent-aaaa'],
  );
});

test('scopeFilter binds labelArg/owns/filter to one scope', () => {
  const sf = scopeFilter('team-abc');
  assert.equal(sf.labelArg, 'aee.plugin.owner=team-abc');
  assert.equal(sf.owns(c('team-abc')), true);
  assert.equal(sf.owns(c('team-other')), false);
  assert.deepEqual(sf.filter([c('team-abc'), c('team-other')]).length, 1);
});

test('a custom label key is honoured (broker keeping its own convention)', () => {
  const sf = scopeFilter('team-abc', 'aee.mcp-owner');
  assert.equal(sf.labelArg, 'aee.mcp-owner=team-abc');
  assert.equal(sf.owns({ Labels: { 'aee.mcp-owner': 'team-abc' } }), true);
  assert.equal(sf.owns({ Labels: { 'aee.plugin.owner': 'team-abc' } }), false);
});
