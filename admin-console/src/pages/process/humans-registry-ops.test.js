import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHumanRole, humansAfterUpsert, humansAfterRemove, slugifyHumanId,
} from './humans-registry-ops.js';

// #987 — the human-role registry update helpers both adapters share.

test('normalizeHumanRole trims, drops empties, defaults name to id', () => {
  assert.equal(normalizeHumanRole({ name: 'no id' }), null);
  assert.deepEqual(normalizeHumanRole({ id: '  reviewer  ' }), { id: 'reviewer', name: 'reviewer' });
  assert.deepEqual(
    normalizeHumanRole({
      id: 'r', name: '  Issue Reviewer  ', description: ' rev ', stage: 'triage',
      emits: ['dispatch', 'dispatch', ''],
      consumes: [{ label: ' x ' }, { artifact: 'issue', from: ' ba ' }, { artifact: 'file', name: ' f ' }, { artifact: 'bad' }],
    }),
    {
      id: 'r', name: 'Issue Reviewer', description: 'rev', stage: 'triage',
      emits: ['dispatch'],
      consumes: [{ label: 'x' }, { artifact: 'issue', from: 'ba' }, { artifact: 'file', name: 'f' }],
    },
  );
});

test('humansAfterUpsert adds then replaces by id, preserving order', () => {
  let list = humansAfterUpsert([], { id: 'a', name: 'A' });
  list = humansAfterUpsert(list, { id: 'b', name: 'B' });
  assert.deepEqual(list.map(h => h.id), ['a', 'b']);
  list = humansAfterUpsert(list, { id: 'a', name: 'A2' });
  assert.deepEqual(list.map(h => h.id), ['a', 'b']);
  assert.equal(list.find(h => h.id === 'a').name, 'A2');
});

test('humansAfterUpsert is a no-op for an invalid role', () => {
  assert.deepEqual(humansAfterUpsert([{ id: 'a', name: 'A' }], { name: 'no id' }), [{ id: 'a', name: 'A' }]);
});

test('humansAfterRemove drops by id', () => {
  assert.deepEqual(
    humansAfterRemove([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'a'),
    [{ id: 'b', name: 'B' }]);
});

test('slugifyHumanId lowercases and collapses non-alnum', () => {
  assert.equal(slugifyHumanId('Issue Reviewer'), 'issue-reviewer');
  assert.equal(slugifyHumanId('  Tech/Lead!! '), 'tech-lead');
  assert.equal(slugifyHumanId('***'), '');
});
