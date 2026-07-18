// Unit tests for the pure pixel-comparison core (#709). No stack, no browser —
// everything runs against the committed fixture capture sets.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadArtifactsRoot } = require('./loader');
const { compareSets, comparePng, STATUS } = require('./compare');

const FIX = path.join(__dirname, 'fixtures');
const baseline = loadArtifactsRoot(path.join(FIX, 'baseline')).captures;
const current = loadArtifactsRoot(path.join(FIX, 'current')).captures;

function byId(results) {
  return new Map(results.map((r) => [r.id, r]));
}

test('classifies every capture in the fixture sets', () => {
  const { results, summary } = compareSets(baseline, current);
  const m = byId(results);

  assert.equal(m.get('demo/landing').status, STATUS.UNCHANGED);
  assert.equal(m.get('demo/form').status, STATUS.CHANGED);
  assert.equal(m.get('demo/resized').status, STATUS.CHANGED);
  assert.equal(m.get('demo/old-step').status, STATUS.REMOVED);
  assert.equal(m.get('demo/new-step').status, STATUS.ADDED);

  assert.deepEqual(summary, { total: 5, changed: 2, added: 1, removed: 1, unchanged: 1 });
});

test('unchanged capture reports zero diff pixels and a diff buffer', () => {
  const r = byId(compareSets(baseline, current).results).get('demo/landing');
  assert.equal(r.diffPixels, 0);
  assert.equal(r.ratio, 0);
  assert.ok(Buffer.isBuffer(r.diff));
});

test('changed capture reports non-zero bounded diff', () => {
  const r = byId(compareSets(baseline, current).results).get('demo/form');
  assert.ok(r.diffPixels > 0, 'some pixels differ');
  assert.ok(r.ratio > 0 && r.ratio < 1, 'diff is bounded, not the whole frame');
  assert.ok(Buffer.isBuffer(r.diff), 'a diff image is produced');
  assert.equal(r.dimensionMismatch, false);
});

test('dimension change is reported, never thrown, with no diff image', () => {
  const r = byId(compareSets(baseline, current).results).get('demo/resized');
  assert.equal(r.status, STATUS.CHANGED);
  assert.equal(r.dimensionMismatch, true);
  assert.equal(r.diff, null);
  assert.deepEqual(r.baselineSize, { width: 200, height: 120 });
  assert.deepEqual(r.currentSize, { width: 200, height: 160 });
});

test('added/removed captures carry no ratio', () => {
  const m = byId(compareSets(baseline, current).results);
  assert.equal(m.get('demo/new-step').ratio, null);
  assert.equal(m.get('demo/old-step').ratio, null);
});

test('empty baseline (first run) marks everything added, never errors', () => {
  const { results, summary } = compareSets(new Map(), current);
  assert.equal(summary.added, current.size);
  assert.equal(summary.changed, 0);
  assert.ok(results.every((r) => r.status === STATUS.ADDED));
});

test('changedRatioFloor can suppress trivial sub-threshold diffs', () => {
  // With an impossibly high floor, the bounded form diff no longer counts.
  const { results } = compareSets(baseline, current, { changedRatioFloor: 0.99 });
  const form = byId(results).get('demo/form');
  assert.equal(form.status, STATUS.UNCHANGED);
});

test('comparePng surfaces dimension mismatch on raw buffers', () => {
  const a = baseline.get('demo/resized').buffer;
  const b = current.get('demo/resized').buffer;
  const cmp = comparePng(a, b);
  assert.equal(cmp.dimensionMismatch, true);
  assert.equal(cmp.ratio, 1);
});
