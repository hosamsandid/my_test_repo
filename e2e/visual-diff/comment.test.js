// Unit tests for the sticky PR-comment renderer (#709). Pure string assertions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadArtifactsRoot } = require('./loader');
const { compareSets } = require('./compare');
const { renderComment, COMMENT_MARKER } = require('./comment');

const FIX = path.join(__dirname, 'fixtures');
const baseline = loadArtifactsRoot(path.join(FIX, 'baseline')).captures;
const current = loadArtifactsRoot(path.join(FIX, 'current')).captures;
const comparison = compareSets(baseline, current);

test('always leads with the sticky marker for find-and-update', () => {
  const body = renderComment(comparison);
  assert.ok(body.startsWith(COMMENT_MARKER), 'marker is the first thing in the body');
});

test('renders a before/after/diff grid for changed captures', () => {
  const body = renderComment(comparison);
  assert.match(body, /\| Capture \| Before \| After \| Diff \| Δ \|/);
  assert.match(body, /`demo\/form`/);
  // New/removed captures are annotated and appear in the grid.
  assert.match(body, /`demo\/new-step` _\(new\)_/);
  assert.match(body, /`demo\/old-step` _\(removed\)_/);
});

test('collapses unchanged captures into a details block', () => {
  const body = renderComment(comparison);
  assert.match(body, /<details>[\s\S]*1 unchanged capture[\s\S]*`demo\/landing`[\s\S]*<\/details>/);
  // Unchanged capture is NOT in the visible grid.
  assert.doesNotMatch(body.split('<details>')[0], /demo\/landing/);
});

test('embeds images inline when a url resolver is supplied', () => {
  const urlFor = (r, kind) => `https://example.test/${r.id.replace('/', '__')}.${kind}.png`;
  const body = renderComment(comparison, { urlFor });
  assert.match(body, /!\[baseline\]\(https:\/\/example\.test\/demo__form\.baseline\.png\)/);
  assert.match(body, /!\[diff\]\(https:\/\/example\.test\/demo__form\.diff\.png\)/);
});

test('degrades to a dash when no url is available (evidence, not a gate)', () => {
  const body = renderComment(comparison, { urlFor: () => null });
  assert.match(body, /\| `demo\/form` \| — \| — \| — \|/);
});

test('dimension change shows a size delta instead of a diff image', () => {
  const body = renderComment(comparison);
  assert.match(body, /_size changed_/);
  assert.match(body, /200×120 → 200×160/);
});

test('states the evidence-not-a-gate contract', () => {
  assert.match(renderComment(comparison), /Evidence only[\s\S]*never fails a PR/);
});

test('empty comparison explains the missing baseline', () => {
  const body = renderComment(compareSets(new Map(), new Map()));
  assert.match(body, /No baseline screenshots were available/);
});

test('no visual changes renders the green all-clear', () => {
  const body = renderComment(compareSets(baseline, baseline));
  assert.match(body, /No visual changes/);
});

test('includes context: commit, baseline ref and run link', () => {
  const body = renderComment(comparison, { commit: 'abcdef1234567', runUrl: 'https://ci/run/1', baselineRef: 'main' });
  assert.match(body, /commit `abcdef1`/);
  assert.match(body, /baseline: main/);
  assert.match(body, /\[run\]\(https:\/\/ci\/run\/1\)/);
});
