'use strict';

// #2920: non-blocking KB store reads + the fingerprint cache behind
// gatherTeamEntries (wiring: knowledge-graph-wiring.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  kbKindDirsFromManifest, listStoreFiles, fileSignature, readStoreFiles, createFingerprintCache,
} = require('./knowledge-entries-cache');

const fsp = fs.promises;
const parseLine = (line) => { try { return JSON.parse(line); } catch { return null; } };

function tmpStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

test('kind dirs: defaults, or the manifest when it names any kind', () => {
  assert.deepEqual(kbKindDirsFromManifest(null), [
    { dir: 'facts', file: 'facts.jsonl' },
    { dir: 'entities', file: 'entities.jsonl' },
    { dir: 'conventions', file: 'conventions.jsonl' },
  ]);
  assert.deepEqual(kbKindDirsFromManifest({ kinds: { fact: { dir: 'f/', file: 'all.jsonl' } } }), [{ dir: 'f', file: 'all.jsonl' }]);
  assert.equal(kbKindDirsFromManifest({ kinds: { fact: { dir: 1 } } }).length, 3);
});

test('listStoreFiles: per kind its .jsonl shards, then the canonical file; missing parts are skipped', async (t) => {
  const root = tmpStore(t);
  const shard = write(root, 'facts/shards/a.jsonl', '');
  write(root, 'facts/shards/notes.txt', '');
  const canonical = write(root, 'facts/facts.jsonl', '');
  const conv = write(root, 'conventions/conventions.jsonl', '');
  const { manifest, files } = await listStoreFiles(root, { fsp });
  assert.equal(manifest, path.join(root, 'knowledge.manifest.json'));
  assert.deepEqual(files, [shard, canonical, conv]);
  assert.deepEqual((await listStoreFiles(path.join(root, 'nope'), { fsp })).files, []);
});

test('listStoreFiles honours the manifest', async (t) => {
  const root = tmpStore(t);
  write(root, 'knowledge.manifest.json', JSON.stringify({ kinds: { fact: { dir: 'kb', file: 'kb.jsonl' } } }));
  const f = write(root, 'kb/kb.jsonl', '');
  write(root, 'facts/facts.jsonl', '');
  assert.deepEqual((await listStoreFiles(root, { fsp })).files, [f]);
});

test('readStoreFiles parses every line in file order, skipping blanks, bad lines and unreadable files', async (t) => {
  const root = tmpStore(t);
  const a = write(root, 'a.jsonl', '{"id":"1"}\n\nnot json\n{"id":"2"}\n');
  const b = write(root, 'b.jsonl', '{"id":"3"}');
  const entries = await readStoreFiles([a, path.join(root, 'missing.jsonl'), b], { fsp, parseLine, concurrency: 2 });
  assert.deepEqual(entries.map((e) => e.id), ['1', '2', '3']);
});

test('fileSignature changes on an append, a new file and a removed file — and only then', async (t) => {
  const root = tmpStore(t);
  const a = write(root, 'a.jsonl', '{"id":"1"}\n');
  const b = path.join(root, 'b.jsonl');
  const s0 = await fileSignature([a, b], { fsp });
  assert.equal(await fileSignature([a, b], { fsp }), s0, 'stable while nothing changes');
  fs.appendFileSync(a, '{"id":"2"}\n');
  const s1 = await fileSignature([a, b], { fsp });
  assert.notEqual(s1, s0);
  fs.writeFileSync(b, '');
  const s2 = await fileSignature([a, b], { fsp });
  assert.notEqual(s2, s1);
  fs.rmSync(b);
  assert.notEqual(await fileSignature([a, b], { fsp }), s2);
});

test('the reads go through fs.promises, so other work keeps running meanwhile', async () => {
  let ticks = 0;
  const slow = {
    readFile: (f) => new Promise((resolve) => setTimeout(() => resolve(`{"f":"${f}"}`), 2)),
    stat: () => new Promise((resolve) => setTimeout(() => resolve({ size: 1, mtimeMs: 1 }), 2)),
  };
  const timer = setInterval(() => { ticks++; }, 1);
  try {
    const files = Array.from({ length: 40 }, (_, i) => `f${i}`);
    const entries = await readStoreFiles(files, { fsp: slow, parseLine, concurrency: 4 });
    await fileSignature(files, { fsp: slow, concurrency: 4 });
    assert.equal(entries.length, 40);
    assert.deepEqual(entries.map((e) => e.f), files, 'order kept despite concurrency');
  } finally { clearInterval(timer); }
  assert.ok(ticks > 5, `timers ran during the reads (${ticks})`);
});

test('cache: same fingerprint → cached value, new fingerprint → rebuild', async () => {
  const cache = createFingerprintCache();
  let builds = 0;
  const build = () => { builds++; return { n: builds }; };
  const v1 = await cache.get('team', 'fp1', build);
  assert.equal(await cache.get('team', 'fp1', build), v1);
  assert.equal(builds, 1);
  const v2 = await cache.get('team', 'fp2', build);
  assert.equal(builds, 2);
  assert.notEqual(v2, v1);
  await cache.get('other', 'fp2', build);
  assert.equal(builds, 3, 'keys are separate');
});

test('cache: concurrent callers with one fingerprint share one build', async () => {
  const cache = createFingerprintCache();
  let builds = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const build = async () => { builds++; await gate; return 'v'; };
  const p = [cache.get('k', 'fp', build), cache.get('k', 'fp', build), cache.get('k', 'fp', build)];
  release();
  assert.deepEqual(await Promise.all(p), ['v', 'v', 'v']);
  assert.equal(builds, 1);
});

test('cache: a failed build is not cached', async () => {
  const cache = createFingerprintCache();
  await assert.rejects(cache.get('k', 'fp', () => { throw new Error('boom'); }), /boom/);
  assert.equal(await cache.get('k', 'fp', () => 'ok'), 'ok');
});

test('cache: a build overtaken by a newer fingerprint does not overwrite it', async () => {
  const cache = createFingerprintCache();
  let releaseOld;
  const old = cache.get('k', 'old', () => new Promise((r) => { releaseOld = () => r('old'); }));
  assert.equal(await cache.get('k', 'new', () => 'new'), 'new');
  releaseOld();
  assert.equal(await old, 'old', 'its own caller still gets its value');
  let rebuilt = false;
  assert.equal(await cache.get('k', 'new', () => { rebuilt = true; return 'x'; }), 'new');
  assert.equal(rebuilt, false);
});

test('cache: evicts the oldest key past maxEntries', async () => {
  const cache = createFingerprintCache({ maxEntries: 2 });
  await cache.get('a', 'fp', () => 1);
  await cache.get('b', 'fp', () => 2);
  await cache.get('c', 'fp', () => 3);
  assert.equal(cache.size, 2);
  let rebuilt = false;
  await cache.get('a', 'fp', () => { rebuilt = true; return 1; });
  assert.equal(rebuilt, true);
});
