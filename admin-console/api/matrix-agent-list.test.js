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

test('isStubMember: only team members qualify — a stub bp-instance stays out', () => {
  assert.equal(isStubMember({ role: 'bp-instance', parentOrchestratorId: 'o', enabled: false }), false);
  assert.equal(isStubMember({ role: 'agent', enabled: false }), false);
  assert.equal(isStubMember({ role: 'team', enabled: false }), false);
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

test('admitsToChatList: a stub bp-instance is not admitted by either opt-in', () => {
  const bpStub = { role: 'bp-instance', parentOrchestratorId: 'o', enabled: false };
  assert.equal(admitsToChatList(bpStub, { includeStubs: true }), false);
  // It is a disabled tokenless agent, so includeDisabled does not reach it either.
  assert.equal(admitsToChatList(bpStub, { includeDisabled: true }), false);
});
