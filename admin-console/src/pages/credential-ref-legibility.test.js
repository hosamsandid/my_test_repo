import test from 'node:test';
import assert from 'node:assert/strict';

import { describeCredentialRef, isProtectedCredentialRef } from './credential-ref-legibility.js';

const opts = [{ id: 'team-token', name: 'Team' }, { id: 'sys-token', name: 'System' }];

test('nothing bound → normal picker', () => {
  const r = describeCredentialRef({ boundId: null, visibleOptions: opts });
  assert.equal(r.mode, 'picker');
  assert.equal(r.boundId, null);
  assert.equal(isProtectedCredentialRef(r), false);
});

test('bound to a VISIBLE option → normal picker, option resolved', () => {
  const r = describeCredentialRef({ boundId: 'team-token', visibleOptions: opts });
  assert.equal(r.mode, 'picker');
  assert.equal(r.boundId, 'team-token');
  assert.equal(r.option.name, 'Team');
  assert.equal(isProtectedCredentialRef(r), false);
});

test('bound but NOT visible → read-only invisible (the data-loss surface)', () => {
  const r = describeCredentialRef({ boundId: 'personal-thorsten', visibleOptions: opts });
  assert.equal(r.mode, 'readonly-invisible');
  assert.equal(r.boundId, 'personal-thorsten');
  assert.equal(r.visible, false);
  assert.equal(r.option, null);
  assert.equal(isProtectedCredentialRef(r), true);
});

test('bound with NO visible options at all → still read-only invisible, not empty picker', () => {
  const r = describeCredentialRef({ boundId: 'personal-thorsten', visibleOptions: [] });
  assert.equal(r.mode, 'readonly-invisible');
  assert.equal(isProtectedCredentialRef(r), true);
});

test('empty-string boundId is treated as unset', () => {
  assert.equal(describeCredentialRef({ boundId: '', visibleOptions: opts }).mode, 'picker');
  assert.equal(describeCredentialRef({ boundId: '', visibleOptions: opts }).boundId, null);
});
