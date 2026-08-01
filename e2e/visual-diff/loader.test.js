// Unit tests for the artifacts-tree loader (#709).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadArtifactsRoot } = require('./loader');

const FIX = path.join(__dirname, 'fixtures');

test('flattens a journey tree into a "<journeyId>/<stepId>" map', () => {
  const { captures, journeys } = loadArtifactsRoot(path.join(FIX, 'baseline'));
  assert.deepEqual(journeys.map((j) => j.journeyId), ['demo']);
  assert.ok(captures.has('demo/landing'));
  assert.ok(captures.has('demo/form'));
  const c = captures.get('demo/form');
  assert.equal(c.journeyId, 'demo');
  assert.equal(c.stepId, 'form');
  assert.ok(Buffer.isBuffer(c.buffer));
  assert.deepEqual(c.viewport, { width: 200, height: 120 });
});

test('missing root yields an empty set, not an error (first-ever run)', () => {
  const { captures, journeys } = loadArtifactsRoot(path.join(FIX, 'does-not-exist'));
  assert.equal(captures.size, 0);
  assert.deepEqual(journeys, []);
});

test('null root is tolerated', () => {
  const { captures } = loadArtifactsRoot(null);
  assert.equal(captures.size, 0);
});
