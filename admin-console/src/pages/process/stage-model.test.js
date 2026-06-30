import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { buildStageBundle, slugify } from './stage-model.js';

// Reuse the backend graph builder to assert the generated wiring is lint-clean.
const require = createRequire(import.meta.url);
const { buildProcessGraph } = require('../../../api/process-graph.js');

function toAgents(bundle) {
  return bundle.roles.map(r => ({
    id: r.id, role: 'template', displayName: r.displayName, sessionPolicy: r.sessionPolicy,
    kind: r.kind, review: r.review,
    triggers: (r.triggers || []).map(t => ({ ...t, emits: t.emits || [] })),
  }));
}

const fiveStages = [
  { name: 'Requirements' },
  { name: 'Functional Design', hasReview: true },
  { name: 'Technical Design' },
  { name: 'Build', requiresApproval: true },
  { name: 'Release' },
];

test('slugify', () => {
  assert.equal(slugify('Functional Design'), 'functional-design');
  assert.equal(slugify('  Go-Live!! '), 'go-live');
});

test('linear chain: stage i emits the next stage label, stage i+1 listens on it', () => {
  const b = buildStageBundle([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  const a = b.roles.find(r => r.id === 'a');
  const bb = b.roles.find(r => r.id === 'b');
  assert.deepEqual(a.triggers[0].emits, ['stage:b']);
  assert.equal(a.triggers[0].events[0], 'issues.opened'); // first stage kicked off by issue
  assert.equal(bb.triggers[0].labelFilter, 'stage:b');
  assert.deepEqual(bb.triggers[0].emits, ['stage:c']);
  // last stage emits nothing
  assert.deepEqual(b.roles.find(r => r.id === 'c').triggers[0].emits, []);
});

test('human approval gates the transition: producer emits nothing, next waits on the gate', () => {
  const b = buildStageBundle([{ name: 'Build', requiresApproval: true }, { name: 'Release' }]);
  const build = b.roles.find(r => r.id === 'build');
  const release = b.roles.find(r => r.id === 'release');
  assert.deepEqual(build.triggers[0].emits, []); // human sets the advance
  assert.equal(release.triggers[0].labelFilter, 'human:build-approved');
});

test('review stage adds a pr-review role pointed at the producer', () => {
  const b = buildStageBundle([{ name: 'FDD', hasReview: true }, { name: 'TD' }]);
  const rev = b.roles.find(r => r.id === 'fdd-review');
  assert.equal(rev.kind, 'pr-review');
  assert.equal(rev.review.reviewsPrFrom, 'fdd');
  assert.equal(rev.review.onApprove, 'td');
  assert.equal(rev.review.onChangesRequested, 'fdd');
});

test('regeneration preserves prompts and manual triggers, replaces _stageGen', () => {
  const first = buildStageBundle([{ name: 'A' }, { name: 'B' }]);
  // operator edits a prompt and adds a manual trigger
  const a = first.roles.find(r => r.id === 'a');
  a.systemPrompt = 'custom prompt';
  a.triggers.push({ id: 'manual-1', type: 'cron', cron: '0 3 * * 1', _stageGen: false });
  const second = buildStageBundle(first.stages, first);
  const a2 = second.roles.find(r => r.id === 'a');
  assert.equal(a2.systemPrompt, 'custom prompt');
  assert.ok(a2.triggers.some(t => t.id === 'manual-1'));
  assert.equal(a2.triggers.filter(t => t._stageGen).length, 1); // single regenerated stage trigger
});

test('a 5-stage lifecycle with one gate and one review produces a lint-clean graph', () => {
  const bundle = buildStageBundle(fiveStages);
  const g = buildProcessGraph(toAgents(bundle));
  assert.deepEqual(g.lints, [], `expected no lints, got: ${JSON.stringify(g.lints)}`);
  // the gate renders and the review wires
  assert.ok(g.gates.some(gate => gate.label === 'human:build-approved'));
  assert.ok(g.edges.some(e => e.kind === 'review' && e.reviewFlow === 'in'));
});

test('stages array round-trips for the view', () => {
  const b = buildStageBundle(fiveStages);
  assert.equal(b.stages.length, 5);
  assert.equal(b.stages[3].requiresApproval, true);
  assert.equal(b.stages[1].hasReview, true);
  // rebuilding from the stored stages is stable
  const b2 = buildStageBundle(b.stages, b);
  assert.deepEqual(b2.stages, b.stages);
});
