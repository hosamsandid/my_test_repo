'use strict';

// Golden-fixture tests for the orchestrator copy of skill-manifest.js.
// The SAME fixture is asserted by admin-console/api/skill-manifest.test.js, and
// the guard test below asserts the two module files are byte-identical, so the
// two-sided contract can never drift (mirrors the knowledge-digest.js discipline).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const m = require('./skill-manifest');
const FIXTURE = require('./skill-manifest.fixture.json');

function filesToBytes(files) {
  return (files || []).map(f => ({ path: f.path, bytes: Buffer.from(f.text, 'utf8') }));
}

for (const c of FIXTURE.hashCases) {
  test(`golden hash: ${c.name}`, () => {
    assert.equal(m.computeContentHash(filesToBytes(c.files)), c.expectedHash);
  });
}

for (const c of FIXTURE.stampCases) {
  test(`golden stamp: ${c.name}`, () => {
    assert.deepEqual(m.stampManifest(c.existing, c.opts), c.expected);
  });
}

for (const c of FIXTURE.driftCases) {
  test(`golden drift: ${c.name}`, () => {
    assert.equal(m.classifyDrift(c.input), c.expected);
  });
}

for (const c of FIXTURE.copyDriftCases) {
  test(`golden copy-drift: ${c.name}`, () => {
    assert.equal(m.classifyCopyDrift(c.input), c.expected);
  });
}

for (const c of FIXTURE.resyncableCases) {
  test(`golden resyncable: ${c.state} → ${c.expected}`, () => {
    assert.equal(m.isResyncable(c.state), c.expected);
  });
}

test('two-sided guard: orchestrator copy is byte-identical to admin-console canonical', () => {
  const here = fs.readFileSync(path.join(__dirname, 'skill-manifest.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', 'admin-console', 'api', 'skill-manifest.js'));
  assert.ok(here.equals(there), 'orchestrator/skill-manifest.js and admin-console/api/skill-manifest.js must be identical');
});

test('hash is order-independent and excludes sidecars/_archive', () => {
  const a = m.computeContentHash([
    { path: 'SKILL.md', bytes: Buffer.from('body') },
    { path: 'scripts/run.sh', bytes: Buffer.from('echo') },
  ]);
  const b = m.computeContentHash([
    { path: 'scripts/run.sh', bytes: Buffer.from('echo') },
    { path: 'skill.json', bytes: Buffer.from('{"version":9}') },
    { path: 'provenance.json', bytes: Buffer.from('{}') },
    { path: '_archive/old.md', bytes: Buffer.from('stale') },
    { path: 'SKILL.md', bytes: Buffer.from('body') },
  ]);
  assert.equal(a, b);
});

test('IO wrappers round-trip through a real directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-manifest-'));
  try {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\n---\nbody\n');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo hi\n');

    const h1 = m.hashSkillDir(dir);
    assert.match(h1, /^[0-9a-f]{12}$/);
    assert.equal(m.readManifest(dir), null);

    const first = m.stampSkillDir(dir, { by: 'operator:t', action: 'created', now: '2026-07-16T09:00:00Z' });
    assert.equal(first.version, 1);
    assert.equal(first.name, path.basename(dir));
    assert.equal(first.contentHash, h1);
    assert.equal(first.history.length, 1);
    assert.equal(first.history[0].action, 'created');

    // Writing the manifest must NOT change the content hash (it is excluded).
    assert.equal(m.hashSkillDir(dir), h1);

    // A no-op re-stamp is idempotent.
    const again = m.stampSkillDir(dir, { by: 'someone', action: 'edited', now: '2026-07-16T10:00:00Z' });
    assert.equal(again.version, 1);
    assert.equal(again.updatedBy, 'operator:t');
    assert.equal(again.history.length, 1);

    // A content change bumps the version.
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\n---\nbody EDITED\n');
    const edited = m.stampSkillDir(dir, { by: 'operator:t', action: 'edited', now: '2026-07-16T11:00:00Z' });
    assert.equal(edited.version, 2);
    assert.equal(edited.history.length, 2);
    assert.equal(edited.history[0].version, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ACTIONS is the closed set from the concept', () => {
  assert.deepEqual(m.ACTIONS, [
    'created', 'edited', 'imported', 'adopted', 'promoted',
    'lifted', 'shared', 'moved', 'merged', 'extended', 'resynced', 'restored',
  ]);
});

/* ─── Version snapshots (#2839) ──────────────────────────────────────────── */

for (const c of FIXTURE.snapshotPruneCases) {
  test(`golden snapshot prune: ${c.name}`, () => {
    assert.deepEqual(m.planSnapshotPrune(c.existing, c.manifest), c.expected);
  });
}

for (const c of FIXTURE.snapshotCases) {
  test(`golden snapshot: ${c.name}`, () => {
    const snap = m.buildSnapshot(filesToBytes(c.files));
    assert.equal(snap.hash, c.expectedHash);
    assert.equal(snap.hash, m.computeContentHash(filesToBytes(c.files)));
    assert.deepEqual(snap.files.map(f => f.path), c.expectedPaths);
    const back = m.parseSnapshot(snap, c.expectedHash);
    assert.equal(m.computeContentHash(back), c.expectedHash);
  });
}

test('snapshot: parseSnapshot refuses a hash mismatch, traversal and excluded paths', () => {
  const snap = m.buildSnapshot([{ path: 'SKILL.md', bytes: Buffer.from('a') }]);
  assert.equal(m.parseSnapshot(snap, 'ffffffffffff'), null);
  assert.equal(m.parseSnapshot({ files: [{ path: '../x', b64: '' }] }), null);
  assert.equal(m.parseSnapshot({ files: [{ path: '_versions/x.json', b64: '' }] }), null);
  assert.equal(m.parseSnapshot(null), null);
});

test('snapshot: every stamp keeps a full snapshot; unchanged content dedups; _versions is not content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-snap-'));
  try {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'v1\n');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo 1\n');
    const v1 = m.stampSkillDir(dir, { by: 't', action: 'created' });
    assert.deepEqual(m.listSnapshotHashes(dir), [v1.contentHash]);
    assert.equal(m.hashSkillDir(dir), v1.contentHash, 'the _versions dir does not change the content hash');

    const files = m.readSnapshot(dir, v1.contentHash);
    assert.deepEqual(files.map(f => [f.path, f.bytes.toString()]), [['SKILL.md', 'v1\n'], ['scripts/run.sh', 'echo 1\n']]);

    // forceHistory on unchanged content → a new entry, the SAME snapshot.
    const again = m.stampSkillDir(dir, { by: 'u', action: 'imported', forceHistory: true });
    assert.equal(again.history.length, 2);
    assert.deepEqual(m.listSnapshotHashes(dir), [v1.contentHash]);

    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'v2\n');
    const v2 = m.stampSkillDir(dir, { by: 't', action: 'edited' });
    assert.deepEqual(m.listSnapshotHashes(dir), [v1.contentHash, v2.contentHash].sort());

    // A restore stamp records restoredFrom.
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'v1\n');
    const r = m.stampSkillDir(dir, { by: 't', action: 'restored', restoredFrom: 1, note: 'restored from v1' });
    assert.equal(r.version, 3);
    assert.equal(r.history[0].action, 'restored');
    assert.equal(r.history[0].restoredFrom, 1);
    assert.equal(r.history[0].hash, v1.contentHash);
    assert.deepEqual(m.listSnapshotHashes(dir), [v1.contentHash, v2.contentHash].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot: at most HISTORY_LIMIT versions are kept, pruned together with their history entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-snap-prune-'));
  try {
    for (let i = 1; i <= m.HISTORY_LIMIT + 5; i++) {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `body ${i}\n`);
      m.stampSkillDir(dir, { by: 't', action: i === 1 ? 'created' : 'edited' });
    }
    const man = m.readManifest(dir);
    assert.equal(man.history.length, m.HISTORY_LIMIT);
    const snaps = m.listSnapshotHashes(dir);
    assert.equal(snaps.length, m.HISTORY_LIMIT);
    assert.deepEqual(snaps, man.history.map(h => h.hash).sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot: snapshotCopyFilter keeps _versions out of a copy; snapshotSkillDir backfills the copy', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-snap-src-'));
  const dst = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-snap-dst-')), 'copy');
  try {
    fs.writeFileSync(path.join(src, 'SKILL.md'), 'a\n');
    m.stampSkillDir(src, { by: 't', action: 'created' });
    fs.writeFileSync(path.join(src, 'SKILL.md'), 'b\n');
    const man = m.stampSkillDir(src, { by: 't', action: 'edited' });
    assert.equal(m.listSnapshotHashes(src).length, 2);

    fs.cpSync(src, dst, { recursive: true, filter: m.snapshotCopyFilter });
    assert.equal(fs.existsSync(path.join(dst, m.SNAPSHOT_DIR)), false, 'snapshots never travel with a copy');
    m.snapshotSkillDir(dst);
    assert.deepEqual(m.listSnapshotHashes(dst), [man.contentHash], 'the copy keeps only its own current content');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(path.dirname(dst), { recursive: true, force: true });
  }
});
