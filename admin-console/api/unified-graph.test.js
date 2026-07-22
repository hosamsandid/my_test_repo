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
    { id: 'dev', emits: ['ready-for-review'], triggers: [{ id: 't1', type: 'github-event', events: ['issues.labeled'], from: 'any-except-self' }] },
    { id: 'rev', triggers: [{ id: 't2', type: 'github-event', labelFilter: 'ready-for-review', from: 'any-except-self' }] },
  ]);
  const e = findEdge(g, x => x.on === 'label' && x.from === 'dev' && x.to === 'rev');
  assert.ok(e, 'expected a label hand-off dev → rev');
  assert.equal(e.label, 'ready-for-review');
  assert.ok(e.id, 'edge carries a stable id');
});

test('timer edge (#410): cron trigger runs from the @timer actor', () => {
  const g = buildUnifiedGraph([
    { id: 'curator', triggers: [{ id: 'c', type: 'cron', cron: '0 9 * * 1', emits: [] }] },
  ]);
  const e = findEdge(g, x => x.on === 'timer');
  assert.ok(e);
  assert.equal(e.from, '@timer');
  assert.equal(e.to, 'curator');
  assert.deepEqual(e.schedule, { cron: '0 9 * * 1' });
  const actor = g.nodes.find(n => n.id === '@timer');
  assert.equal(actor.kind, 'actor');
  assert.equal(actor.actor, 'timer');
});

test('event edge (#410): raw github-event runs from the @github actor', () => {
  const g = buildUnifiedGraph([
    { id: 'triage', triggers: [{ id: 't', type: 'github-event', events: ['issues.opened'], from: 'humans', emits: [] }] },
  ]);
  const e = findEdge(g, x => x.on === 'event');
  assert.ok(e);
  assert.equal(e.from, '@github');
  assert.equal(e.to, 'triage');
  assert.deepEqual(e.events, ['issues.opened']);
  assert.ok(g.nodes.some(n => n.id === '@github' && n.kind === 'actor'));
});

test('event edges merge per trigger: one trigger with several raw events is ONE edge carrying all of them', () => {
  const g = buildUnifiedGraph([
    { id: 'ba', triggers: [{ id: 't1', type: 'github-event', events: ['issues.closed', 'issues.labeled'], from: 'any-except-self', emits: [] }] },
  ]);
  const evEdges = g.edges.filter(x => x.on === 'event' && x.to === 'ba');
  assert.equal(evEdges.length, 1);
  assert.deepEqual(evEdges[0].events.sort(), ['issues.closed', 'issues.labeled']);
  assert.equal(evEdges[0].triggerId, 't1');
});

test('event edges of two distinct triggers with identical events stay distinct', () => {
  const g = buildUnifiedGraph([
    { id: 'ba', triggers: [
      { id: 't1', type: 'github-event', events: ['issues.opened'], from: 'any-except-self', emits: [] },
      { id: 't2', type: 'github-event', events: ['issues.opened'], from: 'humans', emits: [] },
    ] },
  ]);
  const evEdges = g.edges.filter(x => x.on === 'event' && x.to === 'ba');
  assert.equal(evEdges.length, 2);
  assert.deepEqual(evEdges.map(e => e.triggerId).sort(), ['t1', 't2']);
});

test('webhook edge (#410): http trigger runs from the @external actor', () => {
  const g = buildUnifiedGraph([
    { id: 'builder', triggers: [{ id: 'hook1', type: 'http', secret: 'x', description: 'CI done', emits: [] }] },
  ]);
  const e = findEdge(g, x => x.on === 'webhook');
  assert.ok(e);
  assert.equal(e.from, '@external');
  assert.equal(e.to, 'builder');
  assert.equal(e.triggerId, 'hook1');
  assert.ok(g.nodes.some(n => n.id === '@external' && n.kind === 'actor'));
});

test('gate flag: human:* listener edge is a gate from the @github actor (a human acts via a GitHub label)', () => {
  const g = buildUnifiedGraph([
    { id: 'deployer', triggers: [{ id: 't', type: 'github-event', labelFilter: 'human:approved', emits: [] }] },
  ]);
  const e = findEdge(g, x => x.label === 'human:approved');
  assert.ok(e);
  assert.equal(e.on, 'label');
  assert.equal(e.gate, 'human');
  assert.equal(e.from, '@github');
  assert.ok(g.nodes.some(n => n.id === '@github' && n.kind === 'actor'));
});

test('label edges carry the trigger events so the UI can show Issue/PR × added/removed', () => {
  const g = buildUnifiedGraph([
    { id: 'dev', triggers: [], emits: ['ready'] },
    { id: 'rev', triggers: [{ id: 't1', type: 'github-event', events: ['pull_request.unlabeled'], labelFilter: 'ready', from: 'any-except-self', emits: [] }] },
  ]);
  const e = findEdge(g, x => x.on === 'label' && x.from === 'dev' && x.to === 'rev');
  assert.ok(e);
  assert.deepEqual(e.events, ['pull_request.unlabeled']);
});

test('two triggers on the SAME label (added vs removed) stay two independent edges', () => {
  const g = buildUnifiedGraph([
    { id: 'dev', triggers: [], emits: ['ready'] },
    {
      id: 'rev', triggers: [
        { id: 'add', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready', from: 'any-except-self', emits: [] },
        { id: 'rem', type: 'github-event', events: ['issues.unlabeled'], labelFilter: 'ready', from: 'any-except-self', emits: [] },
      ],
    },
  ]);
  const edges = g.edges.filter(x => x.on === 'label' && x.from === 'dev' && x.to === 'rev');
  assert.equal(edges.length, 2, 'one edge per listener trigger');
  assert.deepEqual(edges.map(e => e.triggerId).sort(), ['add', 'rem']);
  assert.notEqual(edges[0].id, edges[1].id, 'edge ids are distinct per trigger');
});

test('plain label listener with no emitter is an orphan (origin filters removed)', () => {
  // Without a `from` origin filter we can no longer infer that a human sets a
  // plain (non-gate) label, so it renders as an orphan — not a @github edge.
  // Genuine human-approval GATES (`human:*` labels) still wire from @github via
  // the label-name convention (see the gate test above); this is only about
  // arbitrary non-gate labels nobody emits.
  const g = buildUnifiedGraph([
    { id: 'dev', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'priorisiert', emits: [] }] },
  ]);
  const e = findEdge(g, x => x.on === 'label' && x.label === 'priorisiert');
  assert.ok(e);
  assert.equal(e.from, null, 'no @github inference for a plain human-set label');
  assert.ok(e.orphan, 'rendered as an orphan listener');
  assert.ok(!e.gate, 'a plain label is not an approval gate');
  assert.ok(!g.nodes.some(n => n.id === '@human'), 'the @human actor is gone');
});

test('actor nodes appear only when referenced (#410): BP graphs get none', () => {
  const g = buildUnifiedGraph(briefingsToUnified([
    { id: 'aaa111', title: 'A', artifacts: [], depends_on: [] },
    { id: 'bbb222', title: 'B', artifacts: [], depends_on: ['aaa111'] },
  ]).nodes);
  assert.ok(!g.nodes.some(n => n.kind === 'actor'));
});

test('github channel edges: producesPr + consumer channel yields an on:github edge', () => {
  const g = buildUnifiedGraph([
    { id: 'dev', triggers: [], github: { producesPr: true } },
    { id: 'reviewer', triggers: [], channels: [{ artifact: 'pr', from: 'dev' }] },
  ]);
  const e = findEdge(g, x => x.on === 'github');
  assert.ok(e);
  assert.equal(e.from, 'dev');
  assert.equal(e.to, 'reviewer');
  assert.equal(e.artifact, 'pr');
  // producer node carries the produce flag for the badge/port renderer
  assert.equal(g.nodes.find(n => n.id === 'dev').github.producesPr, true);
});

test('github channel edges: a labelled human-gated channel carries label + gate', () => {
  const g = buildUnifiedGraph([
    { id: 'dev', triggers: [], github: { producesPr: true } },
    { id: 'deployer', triggers: [], channels: [{ artifact: 'pr', from: 'dev', label: 'approved', gate: 'human' }] },
  ]);
  const e = findEdge(g, x => x.on === 'github' && x.to === 'deployer');
  assert.ok(e);
  assert.equal(e.label, 'approved');
  assert.equal(e.gate, 'human');
});

test('github channel edges: PR and issue channels between the same pair are distinct', () => {
  const g = buildUnifiedGraph([
    { id: 'ba', triggers: [], github: { producesPr: true, producesIssue: true } },
    { id: 'dev', triggers: [], channels: [{ artifact: 'pr', from: 'ba' }, { artifact: 'issue', from: 'ba' }] },
  ]);
  assert.equal(g.edges.filter(e => e.on === 'github' && e.to === 'dev').length, 2);
});

test('label hand-off + same-label PR channel: exactly one label edge, github edge intact (#537)', () => {
  // Core-SDLC repro: reworker emits `ready-for-review`; code-reviewer both
  // consumes developer's PR on that label AND has an explicit labelFilter
  // trigger. Previously this drew TWO reworker→code-reviewer label edges (the
  // trigger-backed one + a trigger-less channel duplicate) that survived dedup
  // because only the former carries a #<triggerId> in its edge id.
  const g = buildUnifiedGraph([
    { id: 'developer', triggers: [], github: { producesPr: true } },
    { id: 'reworker', triggers: [], emits: ['ready-for-review'] },
    { id: 'code-reviewer', channels: [{ artifact: 'pr', from: 'developer', label: 'ready-for-review' }], triggers: [
      { id: 't1783952055673966', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review', emits: [] },
    ] },
  ]);
  const labelEdges = g.edges.filter(e => e.on === 'label' && e.from === 'reworker' && e.to === 'code-reviewer');
  assert.equal(labelEdges.length, 1, 'exactly one reworker → code-reviewer label edge');
  assert.equal(labelEdges[0].triggerId, 't1783952055673966');
  // The developer → code-reviewer PR-channel edge is untouched.
  const ghEdges = g.edges.filter(e => e.on === 'github' && e.from === 'developer' && e.to === 'code-reviewer');
  assert.equal(ghEdges.length, 1);
  assert.equal(ghEdges[0].artifact, 'pr');
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

test('artifact edge: named artifacts match by name even when path hints differ (#382)', () => {
  const g = buildUnifiedGraph([
    { id: 'producer', triggers: [], outputs: [{ name: 'Functional Design', hint: 'designs/a.md' }] },
    { id: 'consumer', triggers: [], inputs: [{ name: 'Functional Design', hint: 'designs/**' }] },
  ]);
  const arts = g.edges.filter(e => e.on === 'artifact');
  assert.equal(arts.length, 1);
  assert.equal(arts[0].from, 'producer');
  assert.equal(arts[0].to, 'consumer');
  assert.deepEqual(arts[0].paths, ['Functional Design'], 'edge keyed by logical name');
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
    { id: 'rogue', emits: ['human:approved'], triggers: [{ id: 't', type: 'github-event', events: ['x'], from: 'any-except-self' }] },
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
      { id: 'dev', displayName: 'Developer', role: 'team-member', sessionPolicy: 'per-invocation', systemPrompt: 'build', emits: ['pr-open'], triggers: [{ id: 't1', type: 'github-event', labelFilter: 'assigned:dev' }] },
      { id: 'rev', displayName: 'Reviewer', role: 'team-member', systemPrompt: 'review', triggers: [{ id: 't2', type: 'github-event', labelFilter: 'pr-open' }] },
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
      { id: 'dev', displayName: 'Developer', role: 'team-member', sessionPolicy: 'per-invocation', systemPrompt: 'p', emits: ['done'], triggers: [{ id: 't1', type: 'github-event', labelFilter: 'go' }] },
    ],
    gates: [], labels: [{ name: 'go', humanGate: false, brake: false }],
  };
  const back = unifiedToProcessTemplate(processTemplateToUnified(bundle));
  assert.equal(back.processTemplateVersion, 1);
  assert.equal(back.roles.length, 1);
  assert.equal(back.roles[0].id, 'dev');
  assert.equal(back.roles[0].sessionPolicy, 'per-invocation');
  // Label hand-off round-trips at the role level (#783).
  assert.deepEqual(back.roles[0].emits, ['done']);
  assert.ok(!('emits' in back.roles[0].triggers[0]));
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

test('stage is carried from briefings and round-trips through the bundle (#362 E)', () => {
  const flow = briefingsToUnified([{ id: 'aa01', title: 'A', stage: 'Build', body: 'x' }]);
  assert.equal(flow.nodes[0].stage, 'Build');
  const g = buildUnifiedGraph(flow.nodes, flow.edges);
  assert.equal(g.nodes.find(n => n.id === 'aa01').stage, 'Build');

  const bundle = { processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [{ id: 'dev', displayName: 'Dev', role: 'team-member', sessionPolicy: 'persistent', systemPrompt: '', triggers: [], stage: 'Design' }], gates: [], labels: [] };
  const u = processTemplateToUnified(bundle);
  assert.equal(u.nodes[0].stage, 'Design');
  const back = unifiedToProcessTemplate(u);
  assert.equal(back.roles[0].stage, 'Design');
});

test('stage inherits from parent by default and is overridable (#362)', () => {
  const flow = briefingsToUnified([
    { id: 'p', title: 'Parent', stage: 'Build', children: ['c1', 'c2'] },
    { id: 'c1', title: 'Child 1', parent: 'p' },                  // inherits Build
    { id: 'c2', title: 'Child 2', parent: 'p', stage: 'Review' }, // overrides
  ]);
  const g = buildUnifiedGraph(flow.nodes, flow.edges);
  const byId = Object.fromEntries(g.nodes.map(n => [n.id, n]));
  assert.equal(byId.c1.stage, '');               // own stage unchanged
  assert.equal(byId.c1.effectiveStage, 'Build'); // inherited
  assert.equal(byId.c2.effectiveStage, 'Review'); // override wins
  assert.equal(byId.p.effectiveStage, 'Build');
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

test('import: BP hierarchy → process bundle preserves prompt/hierarchy/deps/artifacts/stage (#377)', () => {
  // The import composes briefingsToUnified → unifiedToProcessTemplate.
  const bps = [
    { id: 'parent01', title: 'Parent', status: 'ready', children: ['aa01', 'bb02'], body: '# Parent brief', stage: 'Design' },
    { id: 'aa01', title: 'Upstream', parent: 'parent01', body: '# Do the upstream work',
      artifacts: [{ path: 'spec.md', direction: 'output' }] },
    { id: 'bb02', title: 'Downstream', parent: 'parent01', depends_on: ['aa01'], stage: 'Build',
      artifacts: [{ path: 'spec.md', direction: 'input' }] },
  ];
  const bundle = unifiedToProcessTemplate(briefingsToUnified(bps, { name: 'imported' }));
  assert.equal(bundle.processTemplateVersion, 1);

  const byId = Object.fromEntries(bundle.roles.map(r => [r.id, r]));
  // Content (brief.md body) became the role prompt.
  assert.equal(byId.parent01.systemPrompt, '# Parent brief');
  assert.equal(byId.aa01.systemPrompt, '# Do the upstream work');
  // Hierarchy round-trips via `parent`.
  assert.equal(byId.aa01.parent, 'parent01');
  assert.equal(byId.bb02.parent, 'parent01');
  // depends_on + artifact ports + stage survive.
  assert.deepEqual(byId.bb02.dependsOn, ['aa01']);
  assert.deepEqual(byId.aa01.outputs, [{ path: 'spec.md', direction: 'output' }]);
  assert.deepEqual(byId.bb02.inputs, [{ path: 'spec.md', direction: 'input' }]);
  assert.equal(byId.bb02.stage, 'Build');

  // Re-importing the bundle into the graph rebuilds the same edges + hierarchy.
  const flow = processTemplateToUnified(bundle);
  const g = buildUnifiedGraph(flow.nodes, flow.edges);
  assert.ok(findEdge(g, e => e.on === 'parent' && e.from === 'parent01' && e.to === 'aa01'));
  assert.ok(findEdge(g, e => e.on === 'dependency' && e.from === 'aa01' && e.to === 'bb02'));
  assert.ok(findEdge(g, e => e.on === 'artifact' && e.from === 'aa01' && e.to === 'bb02'));
  // Parent grouping is reconstructed from `parent` pointers alone.
  const parent = g.nodes.find(n => n.id === 'parent01');
  assert.equal(parent.isParent, true);
  assert.deepEqual(parent.children.sort(), ['aa01', 'bb02']);
  // Child inherits the parent's stage; own override wins.
  assert.equal(g.nodes.find(n => n.id === 'aa01').effectiveStage, 'Design');
  assert.equal(g.nodes.find(n => n.id === 'bb02').effectiveStage, 'Build');
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
