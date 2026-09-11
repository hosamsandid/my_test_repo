import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPublishEligible, PUBLISH_PATHS, publishSteps, stepVerb } from './skill-publish-view.js';

test('isPublishEligible: an unchanged seed copy (in-sync) is never a candidate', () => {
  assert.equal(isPublishEligible('in-sync'), false);
});

test('isPublishEligible: an unmodified copy whose source moved on (outdated) is never a candidate', () => {
  assert.equal(isPublishEligible('outdated'), false);
});

test('isPublishEligible: diverged/conflict/orphaned/unknown copies are candidates', () => {
  for (const d of ['diverged', 'conflict', 'orphaned', 'unknown']) {
    assert.equal(isPublishEligible(d), true, d);
  }
});

test('isPublishEligible: a hand-authored skill (no recorded drift) is always a candidate', () => {
  assert.equal(isPublishEligible(undefined), true);
});

test('PUBLISH_PATHS: both the direct and staged paths are offered (design decision 1)', () => {
  const ids = PUBLISH_PATHS.map(p => p.id);
  assert.deepEqual(ids, ['direct', 'staged']);
});

test('publishSteps: direct is one agent→global transfer', () => {
  const steps = publishSteps('direct', { name: 'x', agentId: 'a1', teamId: 't1' });
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0], { name: 'x', from: { tier: 'agent', agentId: 'a1' }, to: { tier: 'global' }, mode: 'copy' });
});

test('publishSteps: staged is agent→team then team→global, in order', () => {
  const steps = publishSteps('staged', { name: 'x', agentId: 'a1', teamId: 't1' });
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], { name: 'x', from: { tier: 'agent', agentId: 'a1' }, to: { tier: 'team', teamId: 't1' }, mode: 'copy' });
  assert.deepEqual(steps[1], { name: 'x', from: { tier: 'team', teamId: 't1' }, to: { tier: 'global' }, mode: 'copy' });
});

test('stepVerb: names the step by its own target tier', () => {
  assert.equal(stepVerb({ to: { tier: 'team' } }), 'Lifting to team');
  assert.equal(stepVerb({ to: { tier: 'global' } }), 'Publishing to global');
  assert.equal(stepVerb(null), 'Publishing');
});
