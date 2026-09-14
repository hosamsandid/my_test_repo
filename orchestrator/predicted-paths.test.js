'use strict';

// Unit tests for the pure predicted-paths core (#2249, epic #2251 Phase 4).

const { test } = require('node:test');
const assert = require('node:assert');

const pp = require('./predicted-paths');

// ─── sanitizePathList / normalizePathToken ──────────────────────────────────

test('sanitizePathList: trims, normalizes slashes/case, dedupes, drops junk', () => {
  const out = pp.sanitizePathList([
    'Orchestrator/Foo.js', './orchestrator/foo.js', '  docs/bar.md/  ',
    '', null, 42, '.', '..', 'orchestrator\\win\\path.js',
  ]);
  assert.deepEqual(out, ['orchestrator/foo.js', 'docs/bar.md', 'orchestrator/win/path.js']);
});

test('sanitizePathList: caps at MAX_PREDICTED_PATHS entries', () => {
  const many = Array.from({ length: pp.MAX_PREDICTED_PATHS + 10 }, (_, i) => `dir/file${i}.js`);
  assert.equal(pp.sanitizePathList(many).length, pp.MAX_PREDICTED_PATHS);
});

test('sanitizePathList: caps an individual path at MAX_PATH_LENGTH', () => {
  const long = `dir/${'x'.repeat(500)}.js`;
  const out = pp.sanitizePathList([long]);
  assert.equal(out.length, 1);
  assert.ok(out[0].length <= pp.MAX_PATH_LENGTH);
});

test('sanitizePathList: a non-array input never throws', () => {
  assert.deepEqual(pp.sanitizePathList(null), []);
  assert.deepEqual(pp.sanitizePathList('orchestrator/x.js'), []);
  assert.deepEqual(pp.sanitizePathList(undefined), []);
});

// ─── pathsOverlap ────────────────────────────────────────────────────────────

test('pathsOverlap: exact match', () => {
  assert.equal(pp.pathsOverlap(['orchestrator/x.js'], ['orchestrator/x.js']), true);
});

test('pathsOverlap: a directory prefix on either side counts as overlap', () => {
  assert.equal(pp.pathsOverlap(['orchestrator/'], ['orchestrator/x.js']), true);
  assert.equal(pp.pathsOverlap(['orchestrator/x.js'], ['orchestrator/']), true);
});

test('pathsOverlap: sibling files in the same directory do NOT overlap', () => {
  assert.equal(pp.pathsOverlap(['orchestrator/x.js'], ['orchestrator/y.js']), false);
});

test('pathsOverlap: disjoint directories never overlap', () => {
  assert.equal(pp.pathsOverlap(['orchestrator/x.js'], ['docs/x.js']), false);
});

test('pathsOverlap: an empty set on either side never overlaps (advisory miss fails open)', () => {
  assert.equal(pp.pathsOverlap([], ['orchestrator/x.js']), false);
  assert.equal(pp.pathsOverlap(['orchestrator/x.js'], []), false);
  assert.equal(pp.pathsOverlap(null, ['orchestrator/x.js']), false);
});

test('pathsOverlap: case-insensitive (a coarse advisory guess, not an exact-match tool)', () => {
  assert.equal(pp.pathsOverlap(['Orchestrator/X.js'], ['orchestrator/x.js']), true);
});

// ─── extractHeuristicPaths ──────────────────────────────────────────────────

test('extractHeuristicPaths: pulls backtick-quoted repo paths out of issue prose', () => {
  const text = 'Depends on `orchestrator/flow-supervisor.js` and updates `docs/parallel-workers-concept.md` §4.';
  const out = pp.extractHeuristicPaths(text);
  assert.ok(out.includes('orchestrator/flow-supervisor.js'));
  assert.ok(out.includes('docs/parallel-workers-concept.md'));
});

test('extractHeuristicPaths: also catches bare (non-backticked) path tokens', () => {
  const out = pp.extractHeuristicPaths('See admin-console/api/process-template.js for the validator.');
  assert.ok(out.includes('admin-console/api/process-template.js'));
});

test('extractHeuristicPaths: prose words with no slash or extension are never swept in', () => {
  const out = pp.extractHeuristicPaths('Reduce concurrent merge conflicts beyond epic-serialization.');
  assert.deepEqual(out, []);
});

test('extractHeuristicPaths: empty/non-string input never throws', () => {
  assert.deepEqual(pp.extractHeuristicPaths(''), []);
  assert.deepEqual(pp.extractHeuristicPaths(null), []);
  assert.deepEqual(pp.extractHeuristicPaths(undefined), []);
});

// ─── buildPredictionPrompt ───────────────────────────────────────────────────

test('buildPredictionPrompt: includes the title, body and a repo-tree sample when given one', () => {
  const prompt = pp.buildPredictionPrompt({
    title: 'Fix the thing', body: 'It is broken in orchestrator.js', repoTree: ['a.js', 'b/c.js'],
  });
  assert.match(prompt, /Fix the thing/);
  assert.match(prompt, /It is broken in orchestrator\.js/);
  assert.match(prompt, /a\.js/);
  assert.match(prompt, /JSON array/);
});

test('buildPredictionPrompt: omits the repo-tree section entirely when none is given', () => {
  const prompt = pp.buildPredictionPrompt({ title: 't', body: 'b', repoTree: [] });
  assert.doesNotMatch(prompt, /repository's file paths/);
});

test('buildPredictionPrompt: never throws on missing fields', () => {
  assert.doesNotThrow(() => pp.buildPredictionPrompt());
  assert.doesNotThrow(() => pp.buildPredictionPrompt({}));
});

// ─── parsePredictedPathsResponse ────────────────────────────────────────────

test('parsePredictedPathsResponse: a strict JSON array of strings', () => {
  assert.deepEqual(
    pp.parsePredictedPathsResponse('["orchestrator/x.js", "docs/y.md"]'),
    ['orchestrator/x.js', 'docs/y.md'],
  );
});

test('parsePredictedPathsResponse: tolerates a ```json fenced block with surrounding prose', () => {
  const text = 'Here you go:\n```json\n["orchestrator/x.js"]\n```\nHope that helps!';
  assert.deepEqual(pp.parsePredictedPathsResponse(text), ['orchestrator/x.js']);
});

test('parsePredictedPathsResponse: tolerates a bare array embedded in prose (no fence)', () => {
  const text = 'My guess: ["orchestrator/x.js", "docs/y.md"] — based on the title.';
  assert.deepEqual(pp.parsePredictedPathsResponse(text), ['orchestrator/x.js', 'docs/y.md']);
});

test('parsePredictedPathsResponse: an explicit empty array is a USABLE answer ([], not null)', () => {
  assert.deepEqual(pp.parsePredictedPathsResponse('[]'), []);
});

test('parsePredictedPathsResponse: unparsable text returns null (the caller\'s cue to fall back to heuristic)', () => {
  assert.equal(pp.parsePredictedPathsResponse('I am not sure, sorry.'), null);
  assert.equal(pp.parsePredictedPathsResponse(''), null);
  assert.equal(pp.parsePredictedPathsResponse(null), null);
});

test('parsePredictedPathsResponse: non-string array entries are dropped, not thrown on', () => {
  assert.deepEqual(pp.parsePredictedPathsResponse('["a/b.js", 42, null, {"x":1}]'), ['a/b.js']);
});
