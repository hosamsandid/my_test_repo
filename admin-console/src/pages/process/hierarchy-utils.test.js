import test from 'node:test';
import assert from 'node:assert/strict';

import { wouldCreateCycle, resolveInheritedStage } from './hierarchy-utils.js';

const roles = [
  { id: 'root' },
  { id: 'mid', parent: 'root', stage: 'Build' },
  { id: 'leaf', parent: 'mid' },
  { id: 'leaf2', parent: 'mid', stage: 'Review' },
];

test('wouldCreateCycle: self-parenting is a cycle', () => {
  assert.equal(wouldCreateCycle(roles, 'mid', 'mid'), true);
});

test('wouldCreateCycle: parenting a node under its own descendant is a cycle', () => {
  // making `leaf` the parent of `root` would loop (leaf → mid → root → leaf)
  assert.equal(wouldCreateCycle(roles, 'root', 'leaf'), true);
});

test('wouldCreateCycle: an unrelated parent is fine', () => {
  assert.equal(wouldCreateCycle(roles, 'leaf', 'root'), false);
  assert.equal(wouldCreateCycle(roles, 'leaf2', 'leaf'), false);
});

test('wouldCreateCycle: clearing the parent (falsy) is never a cycle', () => {
  assert.equal(wouldCreateCycle(roles, 'leaf', null), false);
  assert.equal(wouldCreateCycle(roles, 'leaf', ''), false);
});

test('resolveInheritedStage: own stage wins', () => {
  assert.equal(resolveInheritedStage(roles, roles.find(r => r.id === 'mid')), 'Build');
  assert.equal(resolveInheritedStage(roles, roles.find(r => r.id === 'leaf2')), 'Review');
});

test('resolveInheritedStage: inherits the nearest ancestor stage', () => {
  // leaf has no own stage → inherits mid's Build
  assert.equal(resolveInheritedStage(roles, roles.find(r => r.id === 'leaf')), 'Build');
});

test('resolveInheritedStage: no stage anywhere → empty', () => {
  assert.equal(resolveInheritedStage([{ id: 'a' }, { id: 'b', parent: 'a' }], { id: 'b', parent: 'a' }), '');
});

test('resolveInheritedStage: cycle-safe', () => {
  const cyclic = [{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }];
  assert.equal(resolveInheritedStage(cyclic, cyclic[0]), '');
});
