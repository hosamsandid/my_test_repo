'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bpsToBriefingsMap } = require('./briefings-graph');
const { findAffectedBps } = require('./bp-event-router');

// Fixture mirroring the real Evergreen Mainframe-Reverse-Engineering shape:
// one parent + 5 children. Field names match what bp-explorer's
// /api/briefings actually returns (depends_on, children, artifacts, ...).
function mainframeReFixture() {
  return [
    {
      id: '33a3fe8d7930',
      slug: 'mainframe-reverse-engineering',
      status: 'ready',
      children: ['50a6b7f6d2b0', 'cadc54f8f254', 'b51eafb55c26', '738a909ff96a', 'f26e8b7b9560'],
      depends_on: ['ae42a4628f38'],
      artifacts: [],
    },
    {
      id: '50a6b7f6d2b0',
      slug: 'static-analysis',
      status: 'ready',
      children: [],
      depends_on: [],
      artifacts: [
        { path: 'artifacts/briefings/static-analysis/outputs/call-graph', direction: 'output' },
        { path: 'artifacts/briefings/static-analysis/outputs/data-access-matrix', direction: 'output' },
      ],
    },
    {
      id: 'cadc54f8f254',
      slug: 'llm-semantic-analysis',
      status: 'ready',
      children: [],
      depends_on: ['50a6b7f6d2b0'],
      artifacts: [],
    },
    {
      id: 'b51eafb55c26',
      slug: 'knowledge-integration',
      status: 'ready',
      children: [],
      depends_on: ['50a6b7f6d2b0', 'cadc54f8f254'],
      artifacts: [],
    },
    {
      id: '738a909ff96a',
      slug: 'phase-ab-coherence-verification',
      status: 'ready',
      children: [],
      depends_on: ['b51eafb55c26'],
      artifacts: [],
    },
    {
      id: 'f26e8b7b9560',
      slug: 'rsc-controls-analysis-phase',
      status: 'ready',
      children: [],
      depends_on: [],
      artifacts: [],
    },
  ];
}

test('bpsToBriefingsMap renames depends_on to depends-on', () => {
  const map = bpsToBriefingsMap(mainframeReFixture());
  assert.deepEqual(map['cadc54f8f254']['depends-on'], ['50a6b7f6d2b0']);
  assert.deepEqual(map['b51eafb55c26']['depends-on'], ['50a6b7f6d2b0', 'cadc54f8f254']);
  // Underscore form must not leak through.
  assert.equal(map['cadc54f8f254'].depends_on, undefined);
});

test('bpsToBriefingsMap marks BPs with children as is_parent', () => {
  const map = bpsToBriefingsMap(mainframeReFixture());
  assert.equal(map['33a3fe8d7930'].is_parent, true);
  assert.equal(map['50a6b7f6d2b0'].is_parent, false);
  assert.equal(map['cadc54f8f254'].is_parent, false);
});

test('bpsToBriefingsMap preserves artifacts shape unchanged', () => {
  const map = bpsToBriefingsMap(mainframeReFixture());
  assert.equal(map['50a6b7f6d2b0'].artifacts.length, 2);
  assert.equal(map['50a6b7f6d2b0'].artifacts[0].direction, 'output');
  assert.equal(map['50a6b7f6d2b0'].artifacts[0].path,
    'artifacts/briefings/static-analysis/outputs/call-graph');
});

test('bpsToBriefingsMap tolerates malformed entries', () => {
  const map = bpsToBriefingsMap([
    null,
    {},                                  // no id
    { id: '' },                          // empty id
    { id: 'abc123', depends_on: 'oops' }, // wrong type — coerce to []
  ]);
  assert.equal(Object.keys(map).length, 1);
  assert.deepEqual(map['abc123']['depends-on'], []);
  assert.deepEqual(map['abc123'].artifacts, []);
});

test('bpsToBriefingsMap returns empty map for non-array input', () => {
  assert.deepEqual(bpsToBriefingsMap(undefined), {});
  assert.deepEqual(bpsToBriefingsMap(null), {});
  assert.deepEqual(bpsToBriefingsMap('not a list'), {});
});

// The integration test: this is the original bug. Source = static-analysis
// (50a6b7…); the hand-off dialog must show LLM Semantic Analysis (cadc54…)
// AND Knowledge Integration (b51eaf…) as suggested via depends-on. Phase A/B
// Coherence depends transitively but not directly — it must NOT appear.
test('findAffectedBps on the bp-explorer-derived map identifies direct successors', () => {
  const map = bpsToBriefingsMap(mainframeReFixture());
  const affected = findAffectedBps(map, '50a6b7f6d2b0');

  assert.equal(affected.unknownSource, undefined);
  assert.deepEqual(
    affected.dependsOn.sort(),
    ['b51eafb55c26', 'cadc54f8f254'].sort(),
    'cadc54… and b51eaf… are direct depends-on successors',
  );
  assert.equal(
    affected.dependsOn.includes('738a909ff96a'), false,
    'phase-ab-coherence depends on b51eaf…, not directly on 50a6b7… — must not be suggested',
  );
  assert.equal(
    affected.dependsOn.includes('33a3fe8d7930'), false,
    'parent BPs are excluded from the affected set',
  );
});

test('findAffectedBps picks up input-artifact edges from the derived map', () => {
  const bps = mainframeReFixture();
  // Synthesize a downstream consumer that reads one of static-analysis's outputs.
  bps.push({
    id: '999999999999',
    slug: 'downstream-consumer',
    status: 'ready',
    children: [],
    depends_on: [],
    artifacts: [
      { path: 'artifacts/briefings/static-analysis/outputs/call-graph', direction: 'input' },
    ],
  });

  const map = bpsToBriefingsMap(bps);
  const affected = findAffectedBps(map, '50a6b7f6d2b0');

  const inputArtifactMatch = affected.inputArtifact.find((ia) => ia.bp === '999999999999');
  assert.ok(inputArtifactMatch, 'consumer with matching input path appears in inputArtifact');
  assert.deepEqual(
    inputArtifactMatch.paths,
    ['artifacts/briefings/static-analysis/outputs/call-graph'],
  );
});
