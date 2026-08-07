'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadIndex,
  findAffectedBps,
  batchEventsByAffected,
} = require('./bp-event-router');

// ------------------------------------------------------------
// A small hand-built briefings map exercising every edge the router
// classifies: a source that both depends-on wires and produces an output
// consumed downstream, a parent BP, an unrelated leaf, and a consumer that
// is *both* a depends-on successor and an input-artifact consumer.
// ------------------------------------------------------------
function fixture() {
  return {
    // The source of the event.
    source1: {
      'depends-on': [],
      artifacts: [
        { path: 'out/shared.json', direction: 'output' },
        { path: 'out/ignored-input.json', direction: 'input' },
      ],
    },
    // Pure depends-on successor.
    dependsOnly: {
      'depends-on': ['source1'],
      artifacts: [],
    },
    // Pure input-artifact consumer (no depends-on edge).
    inputOnly: {
      'depends-on': [],
      artifacts: [{ path: 'out/shared.json', direction: 'input' }],
    },
    // Consumer wired BOTH ways — must be reported via dependsOn only.
    both: {
      'depends-on': ['source1'],
      artifacts: [{ path: 'out/shared.json', direction: 'input' }],
    },
    // Parent BP that also depends-on the source — must be skipped.
    parentDep: {
      'depends-on': ['source1'],
      is_parent: true,
      artifacts: [],
    },
    // Unrelated leaf — must never appear.
    unrelated: {
      'depends-on': ['someone-else'],
      artifacts: [{ path: 'out/other.json', direction: 'input' }],
    },
  };
}

// ---------------------------- findAffectedBps ----------------------------

test('findAffectedBps: depends-on and input-artifact edges are disjoint', () => {
  const affected = findAffectedBps(fixture(), 'source1');

  assert.deepEqual(affected.dependsOn.sort(), ['both', 'dependsOnly']);
  // `both` depends-on the source, so it is NOT double-reported as input-artifact.
  assert.deepEqual(
    affected.inputArtifact.map((ia) => ia.bp).sort(),
    ['inputOnly']
  );
  assert.deepEqual(
    affected.inputArtifact.find((ia) => ia.bp === 'inputOnly').paths,
    ['out/shared.json']
  );
});

test('findAffectedBps: parent BPs are skipped even when they depend on the source', () => {
  const affected = findAffectedBps(fixture(), 'source1');
  assert.equal(affected.dependsOn.includes('parentDep'), false);
});

test('findAffectedBps: the source BP never reports itself', () => {
  const affected = findAffectedBps(fixture(), 'source1');
  assert.equal(affected.dependsOn.includes('source1'), false);
  assert.equal(affected.inputArtifact.some((ia) => ia.bp === 'source1'), false);
});

test('findAffectedBps: unrelated leaves are never matched', () => {
  const affected = findAffectedBps(fixture(), 'source1');
  assert.equal(affected.dependsOn.includes('unrelated'), false);
  assert.equal(affected.inputArtifact.some((ia) => ia.bp === 'unrelated'), false);
});

test('findAffectedBps: unknown source is flagged, not thrown', () => {
  const affected = findAffectedBps(fixture(), 'does-not-exist');
  assert.equal(affected.unknownSource, true);
  assert.deepEqual(affected.dependsOn, []);
  assert.deepEqual(affected.inputArtifact, []);
});

test('findAffectedBps: a source with no output artifacts yields no input-artifact matches', () => {
  const bri = fixture();
  bri.source1.artifacts = []; // strip outputs — input paths can no longer match
  const affected = findAffectedBps(bri, 'source1');
  assert.deepEqual(affected.dependsOn.sort(), ['both', 'dependsOnly']);
  assert.deepEqual(affected.inputArtifact, []);
});

test('findAffectedBps: non-object briefings degrade to an empty plan', () => {
  assert.deepEqual(findAffectedBps(null, 'source1'), { dependsOn: [], inputArtifact: [] });
  assert.deepEqual(findAffectedBps(undefined, 'x'), { dependsOn: [], inputArtifact: [] });
});

// ------------------------- batchEventsByAffected -------------------------

test('batchEventsByAffected: consolidates multiple events onto one affected BP', () => {
  const events = [
    { type: 'bp:revised', bp: 'source1' },
    { type: 'bp:completed', bp: 'source2' },
  ];
  const resolve = (bp) => {
    if (bp === 'source1') {
      return { dependsOn: ['consumer'], inputArtifact: [] };
    }
    if (bp === 'source2') {
      return { dependsOn: ['consumer'], inputArtifact: [{ bp: 'consumer', paths: ['out/a'] }] };
    }
    return { dependsOn: [], inputArtifact: [] };
  };

  const { perAffectedBp, unknownSources } = batchEventsByAffected(events, resolve);

  assert.deepEqual(unknownSources, []);
  // Single consumer downstream of both events → one consolidated entry list.
  const notes = perAffectedBp.get('consumer');
  assert.equal(notes.length, 3); // 2 depends-on + 1 input-artifact
  const reasons = notes.map((n) => n.reason).sort();
  assert.deepEqual(reasons, ['depends-on', 'depends-on', 'input-artifact']);
  const ia = notes.find((n) => n.reason === 'input-artifact');
  assert.deepEqual(ia.paths, ['out/a']);
  assert.equal(ia.source, 'source2');
});

test('batchEventsByAffected: unknown sources are collected and skipped', () => {
  const events = [
    { type: 'bp:revised', bp: 'ghost' },
    { type: 'bp:revised', bp: 'real' },
  ];
  const resolve = (bp) =>
    bp === 'ghost'
      ? { unknownSource: true }
      : { dependsOn: ['downstream'], inputArtifact: [] };

  const { perAffectedBp, unknownSources } = batchEventsByAffected(events, resolve);

  assert.deepEqual(unknownSources, ['ghost']);
  assert.ok(perAffectedBp.has('downstream'));
  assert.equal(perAffectedBp.size, 1);
});

test('batchEventsByAffected: events without a string bp are ignored', () => {
  const events = [null, {}, { bp: 42 }, { bp: 'ok' }];
  let resolveCalls = 0;
  const resolve = (bp) => {
    resolveCalls += 1;
    assert.equal(bp, 'ok');
    return { dependsOn: ['d'], inputArtifact: [] };
  };

  const { perAffectedBp, unknownSources } = batchEventsByAffected(events, resolve);

  assert.equal(resolveCalls, 1); // only the well-formed event resolved
  assert.deepEqual(unknownSources, []);
  assert.deepEqual([...perAffectedBp.keys()], ['d']);
});

// -------------------------------- loadIndex ------------------------------

test('loadIndex: reads a valid .index.json and returns its briefings map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-router-'));
  const p = path.join(dir, '.index.json');
  fs.writeFileSync(p, JSON.stringify({ briefings: { abc: { 'depends-on': [] } } }));
  try {
    const briefings = loadIndex(p);
    assert.deepEqual(briefings, { abc: { 'depends-on': [] } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: a missing file throws a descriptive error', () => {
  const missing = path.join(os.tmpdir(), 'bp-router-nope', '.index.json');
  assert.throws(() => loadIndex(missing), /Cannot read \.index\.json/);
});

test('loadIndex: malformed JSON throws a descriptive error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-router-'));
  const p = path.join(dir, '.index.json');
  fs.writeFileSync(p, '{ not valid json ');
  try {
    assert.throws(() => loadIndex(p), /Malformed \.index\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex: valid JSON but no `briefings` key throws a shape error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-router-'));
  const p = path.join(dir, '.index.json');
  fs.writeFileSync(p, JSON.stringify({ something: 'else' }));
  try {
    assert.throws(() => loadIndex(p), /Unexpected \.index\.json shape/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
