'use strict';
// Run: node --test podman-mcp/owner-scope.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { OWNER_LABEL_KEY, ownerLabelArg, isOwned, filterOwned } = require('./owner-scope');

const c = (owner) => ({ Id: 'x', Labels: owner ? { [OWNER_LABEL_KEY]: owner } : {} });

test('ownerLabelArg formats the label selector', () => {
  assert.equal(ownerLabelArg('team-a'), 'aee.mcp-owner=team-a');
});

test('isOwned only for exact scope match', () => {
  assert.equal(isOwned(c('team-a'), 'team-a'), true);
  assert.equal(isOwned(c('team-b'), 'team-a'), false);
  assert.equal(isOwned(c(null), 'team-a'), false);
  assert.equal(isOwned(null, 'team-a'), false);
});

test('isOwned fails closed when scopeId is missing/invalid', () => {
  assert.equal(isOwned(c('team-a'), undefined), false);
  assert.equal(isOwned(c(null), undefined), false);
  assert.equal(isOwned(c('team-a'), null), false);
  assert.equal(isOwned(c('team-a'), ''), false);
});

test('filterOwned keeps only the caller scope', () => {
  const list = [c('team-a'), c('team-b'), c(null), c('team-a')];
  assert.equal(filterOwned(list, 'team-a').length, 2);
  assert.equal(filterOwned(list, 'team-z').length, 0);
});

test('filterOwned fails closed when scopeId is missing/invalid', () => {
  const list = [c('team-a'), c('team-b'), c(null), c('team-a')];
  assert.equal(filterOwned(list, undefined).length, 0);
  assert.equal(filterOwned(list, null).length, 0);
  assert.equal(filterOwned(list, '').length, 0);
});
