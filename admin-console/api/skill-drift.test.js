'use strict';

// Unit tests for the drift-resolution glue (#629). The pure state classifier is
// tested by skill-manifest.test.js; here we assert the on-disk resolution
// (hash copy + source, detect a deleted source) and the node-level rollup.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const drift = require('./skill-drift');
const skillManifest = require('./skill-manifest');

function makeSkillDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-drift-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  return dir;
}

test('copyDriftState: in-sync when copy + source both match the anchor', () => {
  const src = makeSkillDir('---\nname: a\n---\nbody\n');
  const copy = makeSkillDir('---\nname: a\n---\nbody\n');
  try {
    const anchor = skillManifest.hashSkillDir(src);
    const r = drift.copyDriftState({ copyDir: copy, sourceHash: anchor, sourceDir: src });
    assert.equal(r.state, 'in-sync');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('copyDriftState: outdated when the source moved on but the copy is untouched', () => {
  const src = makeSkillDir('---\nname: a\n---\nbody\n');
  const copy = makeSkillDir('---\nname: a\n---\nbody\n');
  try {
    const anchor = skillManifest.hashSkillDir(src);
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: a\n---\nbody EDITED\n');
    const r = drift.copyDriftState({ copyDir: copy, sourceHash: anchor, sourceDir: src });
    assert.equal(r.state, 'outdated');
    assert.ok(skillManifest.isResyncable(r.state));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('copyDriftState: diverged when the copy was edited but the source is untouched', () => {
  const src = makeSkillDir('---\nname: a\n---\nbody\n');
  const copy = makeSkillDir('---\nname: a\n---\nbody LOCAL\n');
  try {
    const anchor = skillManifest.hashSkillDir(src);
    const r = drift.copyDriftState({ copyDir: copy, sourceHash: anchor, sourceDir: src });
    assert.equal(r.state, 'diverged');
    assert.equal(skillManifest.isResyncable(r.state), false);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('copyDriftState: conflict when both the copy and the source changed', () => {
  const src = makeSkillDir('---\nname: a\n---\nbody\n');
  const copy = makeSkillDir('---\nname: a\n---\nbody LOCAL\n');
  try {
    const anchor = skillManifest.hashSkillDir(src);
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: a\n---\nbody SOURCE\n');
    const r = drift.copyDriftState({ copyDir: copy, sourceHash: anchor, sourceDir: src });
    assert.equal(r.state, 'conflict');
    assert.equal(skillManifest.isResyncable(r.state), false);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('copyDriftState: orphaned when the source SKILL.md is gone (not hashed as empty)', () => {
  const copy = makeSkillDir('---\nname: a\n---\nbody\n');
  const src = makeSkillDir('---\nname: a\n---\nbody\n');
  try {
    const anchor = skillManifest.hashSkillDir(src);
    fs.rmSync(src, { recursive: true, force: true }); // delete the source entirely
    const r = drift.copyDriftState({ copyDir: copy, sourceHash: anchor, sourceDir: src });
    assert.equal(r.state, 'orphaned');
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('copyDriftState: unknown when there is no recorded anchor (pre-manifest copy)', () => {
  const src = makeSkillDir('---\nname: a\n---\nbody\n');
  const copy = makeSkillDir('---\nname: a\n---\nbody\n');
  try {
    const r = drift.copyDriftState({ copyDir: copy, sourceHash: null, sourceDir: src });
    assert.equal(r.state, 'unknown');
    assert.equal(skillManifest.isResyncable(r.state), false);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('worstDrift: severity order (conflict outranks outdated; in-sync is weakest)', () => {
  assert.equal(drift.worstDrift([]), null);
  assert.equal(drift.worstDrift(['in-sync', 'outdated']), 'outdated');
  assert.equal(drift.worstDrift(['outdated', 'conflict', 'in-sync']), 'conflict');
  assert.equal(drift.worstDrift(['outdated', 'diverged']), 'diverged');
  assert.equal(drift.worstDrift(['in-sync', 'in-sync']), 'in-sync');
});

test('rollupDrift: counts, worst, and the resyncable (outdated-only) tally', () => {
  const r = drift.rollupDrift(['outdated', 'outdated', 'in-sync', 'conflict', 'diverged']);
  assert.equal(r.total, 5);
  assert.equal(r.outdated, 2);
  assert.equal(r.resyncable, 2); // only outdated is resyncable
  assert.equal(r.worst, 'conflict');
  assert.deepEqual(r.counts, { outdated: 2, 'in-sync': 1, conflict: 1, diverged: 1 });

  const empty = drift.rollupDrift([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.worst, null);
  assert.equal(empty.resyncable, 0);
});
