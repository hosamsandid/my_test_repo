'use strict';

// Golden-fixture tests for the admin-console (canonical) copy of skill-manifest.js.
// The SAME fixture (orchestrator/skill-manifest.fixture.json) is asserted by the
// orchestrator mirror suite; the guard test below asserts the two module files
// are byte-identical, so the two-sided contract can never drift.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const m = require('./skill-manifest');
const FIXTURE = require('../../orchestrator/skill-manifest.fixture.json');

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

test('two-sided guard: admin-console canonical is byte-identical to orchestrator copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'skill-manifest.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'skill-manifest.js'));
  assert.ok(here.equals(there), 'admin-console/api/skill-manifest.js and orchestrator/skill-manifest.js must be identical');
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
    'lifted', 'shared', 'moved', 'merged', 'extended', 'resynced',
  ]);
});
