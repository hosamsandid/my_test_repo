'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUnifiedGraph,
  processTemplateToUnified,
  briefingsToUnified,
  unifiedToProcessTemplate,
  UNIFIED_FLOW_VERSION,
} = require('./unified-graph');

const findEdge = (g, pred) => g.edges.find(pred);
const lintCodes = (g) => g.lints.map(l => l.code);

// ── label / timer / event / gate edges (Process mechanism) ───────────────────

test('label edge: emitter → listener via emits ↔ labelFilter', () => {
  const g = buildUnifiedGraph([
    { id: 'dev', triggers: [{ id: 't1', type: 'github-event', events: ['issues.labeled'], from: 'any-except-self', emits: ['ready-for-review'] }] },
    { id: 'rev', triggers: [{ id: 't2', type: 'github-event', labelFilter: 'ready-for-review', from: 'any-except-self', emits: [] }] },
  ]);
  const e = findEdge(g, x => x.on === 'label' && x.from === 'dev' && x.to === 'rev');
  assert.ok(e, 'expected a label hand-off dev → rev');
  assert.equal(e.label, 'ready-for-review');
  assert.ok(e.id, 'edge carries a stable id');
});

test('timer edge: cron trigger is a self-loop', () => {
  const g = buildUnifiedGraph([
    { id: 'curator', triggers: [{ id: 'c', type: 'cron', cron: '0 9 * * 1', emits: [] }] },
  ]);
  const e = findEdge(g, x => x.on === 'timer');
  assert.ok(e);
  assert.equal(e.from, 'curator');
  assert.equal(e.to, 'curator');
  assert.deepEqual(e.schedule, { cron: '0 9 * * 1' });
});

test('event edge: raw github-event (no labelFilter) is external', () => {
  const g = buildUnifiedGraph([
    { id: 'triage', triggers: [{ id: 't', type: 'github-event', events: ['issues.opened'], from: 'humans', emits: [] }] },
  ]);
  const e = findEdge(g, x => x.on === 'event');
  assert.ok(e);
  assert.equal(e.from, null);
  assert.equal(e.to, 'triage');
  assert.deepEqual(e.events, ['issues.opened']);
});

test('gate flag: human:* listener edge is marked gate, not a separate type', () => {
  const g = buildUnifiedGraph([
    { id: 'deployer', triggers: [{ id: 't', type: 'github-event', labelFilter: 'human:approved', emits: [] }] },
  ]);
  const e = findEdge(g, x => x.label === 'human:approved');
  assert.ok(e);
  assert.equal(e.on, 'label');
  assert.equal(e.gate, 'human');
  assert.equal(e.from, null);
});

test('review edges: pr-review role yields in / approve / changes', () => {
  const g = buildUnifiedGraph([
    { id: 'dev', triggers: [] },
    { id: 'merger', triggers: [] },
    { id: 'reviewer', kind: 'pr-review', triggers: [], review: { reviewsPrFrom: 'dev', onApprove: 'merger', onChangesRequested: 'dev' } },
  ]);
  const reviewEdges = g.edges.filter(e => e.on === 'review');
  assert.equal(reviewEdges.length, 3);
  assert.ok(reviewEdges.find(e => e.reviewFlow === 'in' && e.from === 'dev' && e.to === 'reviewer'));
  assert.ok(reviewEdges.find(e => e.outcome === 'approve' && e.to === 'merger'));
  assert.ok(reviewEdges.find(e => e.outcome === 'changes' && e.to === 'dev'));
});

// ── dependency / artifact edges (BP mechanism) ───────────────────────────────

test('dependency edge: depends_on becomes an on:dependency hand-off', () => {
  const g = buildUnifiedGraph([
    { id: 'aa01', triggers: [] },
    { id: 'bb02', triggers: [], dependsOn: ['aa01'] },
  ]);
  const e = findEdge(g, x => x.on === 'dependency');
  assert.ok(e);
  assert.equal(e.from, 'aa01');
  assert.equal(e.to, 'bb02');
});

test('artifact edge: output path of A consumed as input by B, grouped by pair', () => {
  const g = buildUnifiedGraph([
    { id: 'producer', triggers: [], outputs: [{ path: 'out/spec.md', direction: 'output' }, { path: 'out/api.md', direction: 'output' }] },
    { id: 'consumer', triggers: [], inputs: [{ path: 'out/spec.md', direction: 'input' }, { path: 'out/api.md', direction: 'input' }] },
  ]);
  const arts = g.edges.filter(e => e.on === 'artifact');
  assert.equal(arts.length, 1, 'co-flowing paths share one edge');
  assert.equal(arts[0].from, 'producer');
  assert.equal(arts[0].to, 'consumer');
  assert.deepEqual(arts[0].paths, ['out/api.md', 'out/spec.md']);
});

test('a node consuming its own output is not a self hand-off', () => {
  const g = buildUnifiedGraph([
    { id: 'solo', triggers: [], outputs: [{ path: 'x.md', direction: 'output' }], inputs: [{ path: 'x.md', direction: 'input' }] },
  ]);
  assert.equal(g.edges.filter(e => e.on === 'artifact').length, 0);
});

// ── lints ────────────────────────────────────────────────────────────────────

test('dataflow lints: dangling-input and unconsumed-output', () => {
  const g = buildUnifiedGraph([
    { id: 'a', triggers: [], outputs: [{ path: 'produced.md', direction: 'output' }] },
    { id: 'b', triggers: [], inputs: [{ path: 'missing.md', direction: 'input' }] },
  ]);
  const codes = lintCodes(g);
  assert.ok(codes.includes('dangling-input'), 'b consumes a path nobody produces');
  assert.ok(codes.includes('unconsumed-output'), 'a produces a path nobody consumes');
});

test('dependency-cycle lint fires on a cyclic depends_on', () => {
  const g = buildUnifiedGraph([
    { id: 'x', triggers: [], dependsOn: ['y'] },
    { id: 'y', triggers: [], dependsOn: ['x'] },
  ]);
  const cycle = g.lints.find(l => l.code === 'dependency-cycle');
  assert.ok(cycle);
  assert.equal(cycle.severity, 'error');
  assert.ok(cycle.nodes.length >= 2);
});

test('process lints carried through (gate-violation when an agent emits a gate)', () => {
  const g = buildUnifiedGraph([
    { id: 'rogue', triggers: [{ id: 't', type: 'github-event', events: ['x'], from: 'any-except-self', emits: ['human:approved'] }] },
  ]);
  assert.ok(lintCodes(g).includes('gate-violation'));
});

// ── adapters ─────────────────────────────────────────────────────────────────

test('processTemplateToUnified maps roles → nodes and preserves wiring', () => {
  const bundle = {
    processTemplateVersion: 1,
    name: 'demo',
    level: 'template',
    roles: [
      { id: 'dev', displayName: 'Developer', role: 'team-member', sessionPolicy: 'per-invocation', systemPrompt: 'build', triggers: [{ id: 't1', type: 'github-event', labelFilter: 'assigned:dev', emits: ['pr-open'] }] },
      { id: 'rev', displayName: 'Reviewer', role: 'team-member', systemPrompt: 'review', triggers: [{ id: 't2', type: 'github-event', labelFilter: 'pr-open', emits: [] }] },
    ],
    gates: [], labels: [],
  };
  const flow = processTemplateToUnified(bundle);
  assert.equal(flow.unifiedFlowVersion, UNIFIED_FLOW_VERSION);
  assert.equal(flow.nodes.length, 2);
  const g = buildUnifiedGraph(flow.nodes, flow.edges);
  assert.ok(findEdge(g, e => e.on === 'label' && e.from === 'dev' && e.to === 'rev'));
});

test('briefingsToUnified drops status, builds dependency + artifact edges', () => {
  const bps = [
    { id: 'parent01', title: 'Parent', status: 'ready', children: ['aa01', 'bb02'] },
    { id: 'aa01', title: 'Upstream', status: 'completed', parent: 'parent01', artifacts: [{ path: 'spec.md', direction: 'output' }] },
    { id: 'bb02', title: 'Downstream', status: 'dispatched', parent: 'parent01', depends_on: ['aa01'], artifacts: [{ path: 'spec.md', direction: 'input' }] },
  ];
  const flow = briefingsToUnified(bps);
  assert.ok(flow.nodes.every(n => !('status' in n)), 'status not carried onto nodes');

  const g = buildUnifiedGraph(flow.nodes, flow.edges);
  assert.ok(findEdge(g, e => e.on === 'dependency' && e.from === 'aa01' && e.to === 'bb02'));
  assert.ok(findEdge(g, e => e.on === 'artifact' && e.from === 'aa01' && e.to === 'bb02'));
});

test('round-trip: process bundle → unified → process bundle preserves roles/triggers', () => {
  const bundle = {
    processTemplateVersion: 1,
    name: 'rt',
    level: 'template',
    roles: [
      { id: 'dev', displayName: 'Developer', role: 'team-member', sessionPolicy: 'per-invocation', systemPrompt: 'p', triggers: [{ id: 't1', type: 'github-event', labelFilter: 'go', emits: ['done'] }] },
    ],
    gates: [], labels: [{ name: 'go', humanGate: false, brake: false }],
  };
  const back = unifiedToProcessTemplate(processTemplateToUnified(bundle));
  assert.equal(back.processTemplateVersion, 1);
  assert.equal(back.roles.length, 1);
  assert.equal(back.roles[0].id, 'dev');
  assert.equal(back.roles[0].sessionPolicy, 'per-invocation');
  assert.deepEqual(back.roles[0].triggers[0].emits, ['done']);
});

test('processTemplateToUnified reads inputs/outputs/dependsOn from roles (#367)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [
      { id: 'a', triggers: [], outputs: [{ path: 'spec.md' }] },
      { id: 'b', triggers: [], inputs: [{ path: 'spec.md' }], dependsOn: ['a'] },
    ],
    gates: [], labels: [],
  };
  const flow = processTemplateToUnified(bundle);
  const b = flow.nodes.find(n => n.id === 'b');
  assert.deepEqual(b.dependsOn, ['a']);
  assert.deepEqual(b.inputs, [{ path: 'spec.md' }]);
  const g = buildUnifiedGraph(flow.nodes, flow.edges);
  assert.ok(findEdge(g, e => e.on === 'dependency' && e.from === 'a' && e.to === 'b'));
  assert.ok(findEdge(g, e => e.on === 'artifact' && e.from === 'a' && e.to === 'b'));
});

test('round-trip preserves inputs/outputs/dependsOn through unified ↔ bundle (#367)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [
      { id: 'a', displayName: 'A', role: 'team-member', sessionPolicy: 'persistent', systemPrompt: '', triggers: [], outputs: [{ path: 'spec.md', description: 'the spec' }] },
      { id: 'b', displayName: 'B', role: 'team-member', sessionPolicy: 'persistent', systemPrompt: '', triggers: [], inputs: [{ path: 'spec.md' }], dependsOn: ['a'] },
    ],
    gates: [], labels: [],
  };
  const back = unifiedToProcessTemplate(processTemplateToUnified(bundle));
  const a = back.roles.find(r => r.id === 'a');
  const b = back.roles.find(r => r.id === 'b');
  assert.deepEqual(a.outputs, [{ path: 'spec.md', description: 'the spec' }]);
  assert.deepEqual(b.inputs, [{ path: 'spec.md' }]);
  assert.deepEqual(b.dependsOn, ['a']);
  // Roles without ports stay clean (no empty arrays injected).
  assert.ok(!('inputs' in a));
});

test('briefingsToUnified keeps parents, carries body as content, builds hierarchy edges (#362 UI)', () => {
  const bps = [
    { id: 'parent01', title: 'Parent', status: 'ready', children: ['aa01', 'bb02'], body: '# Parent brief' },
    { id: 'aa01', title: 'Upstream', parent: 'parent01', body: '# Do the upstream work', artifacts: [{ path: 'spec.md', direction: 'output' }] },
    { id: 'bb02', title: 'Downstream', parent: 'parent01', depends_on: ['aa01'], artifacts: [{ path: 'spec.md', direction: 'input' }] },
  ];
  const flow = briefingsToUnified(bps);
  assert.equal(flow.nodes.length, 3, 'parent BP is kept as a grouping node');
  const parent = flow.nodes.find(n => n.id === 'parent01');
  assert.equal(parent.isParent, true);
  assert.equal(parent.content, '# Parent brief');
  assert.equal(flow.nodes.find(n => n.id === 'aa01').content, '# Do the upstream work');

  const g = buildUnifiedGraph(flow.nodes, flow.edges);
  assert.ok(findEdge(g, e => e.on === 'parent' && e.from === 'parent01' && e.to === 'aa01'));
  assert.ok(findEdge(g, e => e.on === 'parent' && e.from === 'parent01' && e.to === 'bb02'));
  assert.ok(findEdge(g, e => e.on === 'dependency' && e.from === 'aa01' && e.to === 'bb02'));
  assert.ok(findEdge(g, e => e.on === 'artifact' && e.from === 'aa01' && e.to === 'bb02'));
  // content survives onto the built nodes
  assert.equal(g.nodes.find(n => n.id === 'aa01').content, '# Do the upstream work');
});

test('process node content mirrors systemPrompt', () => {
  const flow = processTemplateToUnified({
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [{ id: 'dev', systemPrompt: 'build the thing', triggers: [] }], gates: [], labels: [],
  });
  assert.equal(flow.nodes[0].content, 'build the thing');
});

test('hierarchy (on:parent) edges are view-only — resolveHandoffs ignores them', () => {
  // resolve-handoffs lives in its own module/test; here we just assert the edge
  // exists and carries no routing semantics beyond grouping.
  const flow = briefingsToUnified([
    { id: 'p', children: ['c'] },
    { id: 'c', parent: 'p' },
  ]);
  const g = buildUnifiedGraph(flow.nodes, flow.edges);
  const parentEdges = g.edges.filter(e => e.on === 'parent');
  assert.equal(parentEdges.length, 1);
  assert.equal(parentEdges[0].from, 'p');
});

test('explicit manual hand-off edge passes through', () => {
  const g = buildUnifiedGraph(
    [{ id: 'a', triggers: [] }, { id: 'b', triggers: [] }],
    [{ from: 'a', to: 'b', on: 'manual', label: 'hand-off' }],
  );
  const e = findEdge(g, x => x.on === 'manual');
  assert.ok(e);
  assert.equal(e.from, 'a');
  assert.equal(e.to, 'b');
});
