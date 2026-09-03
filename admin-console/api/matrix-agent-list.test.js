'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isStubMember, admitsToChatList } = require('./matrix-agent-list');

const ACTIVE = { id: 'a', role: 'team-member', parentTeamId: 't', token: 'tok', enabled: true };
const PAUSED = { id: 'b', role: 'team-member', parentTeamId: 't', token: 'tok', enabled: false };
const STUB = { id: 'c', role: 'team-member', parentTeamId: 't', enabled: false };

test('isStubMember: config-only team member with a parent team', () => {
  assert.equal(isStubMember(STUB), true);
});

test('isStubMember: a provisioned-but-paused member is not a stub', () => {
  assert.equal(isStubMember(PAUSED), false);
});

test('isStubMember: only team members qualify', () => {
  assert.equal(isStubMember({ role: 'agent', enabled: false }), false);
  assert.equal(isStubMember({ role: 'team', enabled: false }), false);
});

// #1962 removed the BriefingPack roles, but epic #1961's decision R2 leaves
// existing configs on disk untouched — so a `bp-instance` stub can still be
// present after an upgrade and must stay out of the chat list (it has no team
// group to sit in, which is the invariant the rail's grouping relies on).
test('isStubMember: a leftover bp-instance stub stays out', () => {
  assert.equal(isStubMember({ role: 'bp-instance', parentOrchestratorId: 'o', enabled: false }), false);
});

test('isStubMember: a parentless member has no group to sit in', () => {
  // The rail's grouping relies on this: every stub in the payload carries a
  // parentTeamId, so none can fall through to the "Single agents" bucket.
  assert.equal(isStubMember({ role: 'team-member', enabled: false }), false);
});

test('isStubMember: null-safe', () => {
  assert.equal(isStubMember(null), false);
  assert.equal(isStubMember(undefined), false);
});

test('admitsToChatList: the default response is the pre-#1957 one (AC8)', () => {
  assert.equal(admitsToChatList(ACTIVE), true);
  assert.equal(admitsToChatList(PAUSED), false);
  assert.equal(admitsToChatList(STUB), false);
  // A tokenless non-stub still has no chat identity to list.
  assert.equal(admitsToChatList({ role: 'agent', enabled: true }), false);
  assert.equal(admitsToChatList(null), false);
});

test('admitsToChatList: includeDisabled admits paused agents but never stubs', () => {
  assert.equal(admitsToChatList(PAUSED, { includeDisabled: true }), true);
  assert.equal(admitsToChatList(STUB, { includeDisabled: true }), false);
});

test('admitsToChatList: includeStubs admits stubs but never paused agents', () => {
  assert.equal(admitsToChatList(STUB, { includeStubs: true }), true);
  assert.equal(admitsToChatList(PAUSED, { includeStubs: true }), false);
  assert.equal(admitsToChatList(ACTIVE, { includeStubs: true }), true);
});

test('admitsToChatList: the two opt-ins are independent', () => {
  const both = { includeDisabled: true, includeStubs: true };
  assert.equal(admitsToChatList(ACTIVE, both), true);
  assert.equal(admitsToChatList(PAUSED, both), true);
  assert.equal(admitsToChatList(STUB, both), true);
});

test('admitsToChatList: a leftover bp-instance stub is not admitted by either opt-in', () => {
  // Same #1962 / R2 leftover as above: neither opt-in may surface it.
  const bpStub = { role: 'bp-instance', parentOrchestratorId: 'o', enabled: false };
  assert.equal(admitsToChatList(bpStub, { includeStubs: true }), false);
  // It is a disabled tokenless agent, so includeDisabled does not reach it either.
  assert.equal(admitsToChatList(bpStub, { includeDisabled: true }), false);
});
