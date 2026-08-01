'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_COSINE_THRESHOLD,
  contentHash,
  cosine,
  cosineUnit,
  parseVectorCache,
  serializeVectorCache,
  planEmbeddingPass,
  buildVectorLookup,
  createEmbeddingBackend,
} = require('./knowledge-embeddings');

test('cosine/cosineUnit: standard geometry, negatives clamp to 0, junk is 0', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [-1, 0]), -1);
  assert.equal(cosineUnit([1, 0], [-1, 0]), 0); // clamp — never (c+1)/2 inflation
  assert.equal(cosine([1, 0], [1]), 0); // length mismatch
  assert.equal(cosine('x', [1]), 0);
  assert.equal(cosine([0, 0], [1, 0]), 0); // zero vector
});

test('contentHash: 12-hex, text-sensitive, stable', () => {
  assert.match(contentHash('a lesson'), /^[0-9a-f]{12}$/);
  assert.equal(contentHash('a lesson'), contentHash('a lesson'));
  assert.notEqual(contentHash('a lesson'), contentHash('a lesson edited'));
});

test('vector cache: serialize/parse round-trip, mangled lines skipped', () => {
  const rows = [
    { id: 'a'.repeat(12), contentHash: contentHash('x'), vector: [0.1, 0.2] },
    { id: 'b'.repeat(12), contentHash: contentHash('y'), vector: [0.3, 0.4] },
  ];
  const text = serializeVectorCache(rows);
  assert.deepEqual(parseVectorCache(text), rows);
  assert.deepEqual(parseVectorCache(`junk\n${text}{broken`), rows);
  assert.deepEqual(parseVectorCache(''), []);
  assert.equal(serializeVectorCache([]), '');
});

test('planEmbeddingPass: embeds missing + stale, keeps fresh, counts pruned (AC4 self-heal)', () => {
  const entries = [
    { id: 'a'.repeat(12), text: 'unchanged' },
    { id: 'b'.repeat(12), text: 'edited text' },
    { id: 'c'.repeat(12), text: 'brand new' },
  ];
  const cache = [
    { id: 'a'.repeat(12), contentHash: contentHash('unchanged'), vector: [1] },
    { id: 'b'.repeat(12), contentHash: contentHash('old text'), vector: [2] }, // stale
    { id: 'z'.repeat(12), contentHash: contentHash('gone'), vector: [3] },     // vanished entry
  ];
  const plan = planEmbeddingPass({ entries, cache });
  assert.deepEqual(plan.keep.map((r) => r.id), ['a'.repeat(12)]);
  assert.deepEqual(plan.toEmbed.map((r) => r.id), ['b'.repeat(12), 'c'.repeat(12)]);
  assert.equal(plan.pruned, 1);
  // idempotent: applying keep+fresh yields a no-op second plan
  const nextCache = [...plan.keep, ...plan.toEmbed.map((e) => ({ id: e.id, contentHash: e.contentHash, vector: [9] }))];
  const plan2 = planEmbeddingPass({ entries, cache: nextCache });
  assert.equal(plan2.toEmbed.length, 0);
  assert.equal(plan2.pruned, 0);
});

test('buildVectorLookup: only hash-current vectors count; null when nothing usable', () => {
  const entries = [{ id: 'a'.repeat(12), text: 'now' }, { id: 'b'.repeat(12), text: 'other' }];
  const cache = [
    { id: 'a'.repeat(12), contentHash: contentHash('now'), vector: [1, 0] },
    { id: 'b'.repeat(12), contentHash: contentHash('stale'), vector: [0, 1] }, // stale — must not link
  ];
  const lookup = buildVectorLookup(cache, entries);
  assert.ok(lookup.has('a'.repeat(12)));
  assert.ok(!lookup.has('b'.repeat(12)));
  assert.equal(buildVectorLookup([], entries), null);
  assert.equal(buildVectorLookup(cache, []), null);
});

test('createEmbeddingBackend: unavailable without a model path; lazy loader injected for tests', async () => {
  const off = createEmbeddingBackend({ modelPath: '' });
  assert.equal(off.available, false);
  assert.match(off.reason, /AEE_EMBEDDING_MODEL_PATH/);
  await assert.rejects(() => off.embed(['x']));
  const fake = createEmbeddingBackend({
    modelPath: '/models/fake',
    loadPipeline: async () => async (texts) => texts.map(() => [1, 0]),
  });
  assert.equal(fake.available, true);
  assert.deepEqual(await fake.embed(['a', 'b']), [[1, 0], [1, 0]]);
  assert.equal(DEFAULT_COSINE_THRESHOLD, 0.8);
});

// ── end-to-end eval fixture (AC1) — runs ONLY with a real model present ──────
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'knowledge-embeddings.fixture.json'), 'utf8'));

test('eval fixture: converge pairs link at the default threshold, distinct pairs do not', { skip: !process.env.AEE_EMBEDDING_MODEL_PATH && 'no embedding model configured (AEE_EMBEDDING_MODEL_PATH unset)' }, async () => {
  const backend = createEmbeddingBackend({});
  assert.equal(backend.available, true);
  for (const pair of FIXTURE.pairs) {
    const [va, vb] = await backend.embed([pair.a, pair.b]);
    const score = cosineUnit(va, vb);
    if (pair.label === 'converge') {
      assert.ok(score >= DEFAULT_COSINE_THRESHOLD, `should converge (${pair.note}): ${score.toFixed(3)}`);
    } else {
      assert.ok(score < DEFAULT_COSINE_THRESHOLD, `should stay distinct (${pair.note}): ${score.toFixed(3)}`);
    }
  }
});
