import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHumanRole, humansAfterUpsert, humansAfterRemove, slugifyHumanId,
  consumeKey, humanAfterConsumeAdd, humanAfterConsumeRemove, humanAfterEmitAdd, humanAfterEmitRemove,
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

test('consumeKey distinguishes label / pr / issue / file entries', () => {
  assert.equal(consumeKey({ label: 'x' }), 'label:x');
  assert.equal(consumeKey({ artifact: 'pr', from: 'dev' }), 'pr:dev');
  assert.equal(consumeKey({ artifact: 'issue', from: 'ba' }), 'issue:ba');
  assert.equal(consumeKey({ artifact: 'file', name: 'r' }), 'file:r');
  assert.equal(consumeKey({ artifact: 'pr' }), '');
});

test('humanAfterConsumeAdd adds + dedupes; creates the role from a bare id', () => {
  let h = humanAfterConsumeAdd({ id: 'ba', name: 'BA' }, { artifact: 'issue', from: 'analyst' });
  assert.deepEqual(h.consumes, [{ artifact: 'issue', from: 'analyst' }]);
  h = humanAfterConsumeAdd(h, { artifact: 'issue', from: 'analyst' }); // dup
  assert.equal(h.consumes.length, 1);
  h = humanAfterConsumeAdd(h, { label: 'brake-x' });
  assert.equal(h.consumes.length, 2);
});

test('humanAfterConsumeRemove drops the matching entry', () => {
  const h0 = { id: 'ba', name: 'BA', consumes: [{ artifact: 'issue', from: 'analyst' }, { label: 'x' }] };
  const h = humanAfterConsumeRemove(h0, { artifact: 'issue', from: 'analyst' });
  assert.deepEqual(h.consumes, [{ label: 'x' }]);
});

test('humanAfterEmitAdd / Remove manage the emits list', () => {
  let h = humanAfterEmitAdd({ id: 'r', name: 'R' }, 'dispatch');
  assert.deepEqual(h.emits, ['dispatch']);
  h = humanAfterEmitAdd(h, 'dispatch'); // dup
  assert.deepEqual(h.emits, ['dispatch']);
  h = humanAfterEmitAdd(h, 'approved');
  assert.deepEqual(h.emits, ['dispatch', 'approved']);
  h = humanAfterEmitRemove(h, 'dispatch');
  assert.deepEqual(h.emits, ['approved']);
});
