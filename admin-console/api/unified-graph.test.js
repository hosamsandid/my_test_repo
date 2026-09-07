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

test('outcome-keyed label edge carries the outcome id (\#827/\#828)', () => {
  // A reviewer with an authored exactlyOne outcomes port setting `ready-to-merge`
  // → the merger's listener. The unified on:'label' edge must forward the outcome
  // option id so the canvas can title the edge + focus the Routing tab on it.
  const g = buildUnifiedGraph([
    { id: 'rev', outcomes: { mode: 'exactlyOne', options: [
      { id: 'accepted', title: 'Accepted', actions: [{ type: 'setLabel', label: 'ready-to-merge' }] },
      { id: 'revisions-required', title: 'Revisions', actions: [{ type: 'setLabel', label: 'revisions-required' }] },
    ] } },
    { id: 'merger', triggers: [{ id: 'm1', type: 'github-event', labelFilter: 'ready-to-merge', from: 'any-except-self' }] },
    { id: 'reworker', triggers: [{ id: 'r1', type: 'github-event', labelFilter: 'revisions-required', from: 'any-except-self' }] },
  ]);
  const toMerger = findEdge(g, x => x.on === 'label' && x.from === 'rev' && x.to === 'merger');
  assert.ok(toMerger, 'expected rev → merger label edge');
  assert.equal(toMerger.outcome, 'accepted');
  const toReworker = findEdge(g, x => x.on === 'label' && x.from === 'rev' && x.to === 'reworker');
  assert.ok(toReworker, 'expected rev → reworker label edge');
  assert.equal(toReworker.outcome, 'revisions-required');
  // The node carries the authored port through for the Routing tab.
  const rev = g.nodes.find(n => n.id === 'rev');
  assert.equal(rev.outcomes.mode, 'exactlyOne');
});

test('duplicate-listener lint surfaces through the unified /flows/graph builder (\#826)', () => {
  const g = buildUnifiedGraph([
    { id: 'rev', triggers: [
      { id: 'rev-on-pr', type: 'github-event', channel: true, events: ['pull_request.opened'] },
      { id: 'rev-manual', type: 'github-event', events: ['pull_request.opened'] },
    ] },
  ]);
  assert.ok(lintCodes(g).includes('duplicate-listener'));
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

test('loop edge (#936): a loop trigger stays a self-edge (on:loop) carrying its stop-contract summary', () => {
  const g = buildUnifiedGraph([
    { id: 'dev', triggers: [{
      id: 'l', type: 'loop', maxIterations: 25, maxTokens: 2000000,
      until: { command: 'npm test' }, verify: { agentId: 'dev-reviewer' }, emits: [],
    }] },
  ]);
  const e = findEdge(g, x => x.on === 'loop');
  assert.ok(e, 'a loop self-edge is emitted');
  // Unlike the cron timer (rerouted from @timer), the loop is the agent
  // re-arming itself — from === to and no @timer/@github actor is introduced.
  assert.equal(e.from, 'dev');
  assert.equal(e.to, 'dev');
  assert.equal(e.triggerId, 'l');
  assert.deepEqual(e.loop, {
    maxIterations: 25, maxTokens: 2000000,
    until: { command: 'npm test' }, verify: { mode: 'agent', agentId: 'dev-reviewer' },
  });
  assert.ok(!g.nodes.some(n => n.id === '@timer'), 'no @timer actor for a loop');
});

test('loop edges (#936): two loops on one agent stay two independently-keyed edges', () => {
  const g = buildUnifiedGraph([
    { id: 'dev', triggers: [
      { id: 'a', type: 'loop', maxIterations: 5, emits: [] },
      { id: 'b', type: 'loop', maxIterations: 9, emits: [] },
    ] },
  ]);
  const loops = (g.edges || []).filter(x => x.on === 'loop');
  assert.equal(loops.length, 2);
  assert.deepEqual(loops.map(l => l.triggerId).sort(), ['a', 'b']);
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

// #928 — the gate comes from the label registry's `humanGate` flag threaded in as
// options.labels; the label itself is named as a plain action. #987 removed the
// generic @human hub: an unbound gate (no named human role emits it) stays
// `from: null` — dropped by the renderer + an `unbound-gate` advisory lint.
test('gate flag: a FLAGGED unbound listener edge is a gate from null (no @human hub, #987)', () => {
  const g = buildUnifiedGraph(
    [{ id: 'deployer', triggers: [{ id: 't', type: 'github-event', labelFilter: 'approved-for-deploy', emits: [] }] }],
    undefined,
    { labels: [{ name: 'approved-for-deploy', humanGate: true, brake: false }] },
  );
  const e = findEdge(g, x => x.label === 'approved-for-deploy');
  assert.ok(e);
  assert.equal(e.on, 'label');
  assert.equal(e.gate, 'human');
  assert.equal(e.from, null);
  assert.ok(!g.nodes.some(n => n.id === '@human'), 'no generic @human actor');
  assert.ok(lintCodes(g).includes('unbound-gate'));
});

test('gate flag: an UNFLAGGED `human:`-named listener is a plain orphan label (#928 AC8)', () => {
  const g = buildUnifiedGraph([
    { id: 'deployer', triggers: [{ id: 't', type: 'github-event', labelFilter: 'human:approved', emits: [] }] },
  ]);
  const e = findEdge(g, x => x.label === 'human:approved');
  assert.ok(e);
  assert.ok(!e.gate, 'the name convention no longer implies a gate');
  assert.equal(e.from, null);
  assert.ok(e.orphan);
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
  // Genuine human-approval GATES (labels flagged `humanGate`, #928) still wire
  // from @github via the config flag (see the gate test above); this is only
  // about arbitrary non-gate labels nobody emits.
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

test('#1194: a labelled internal channel edge surfaces transport; a human/unlabelled one does not', () => {
  const g = buildUnifiedGraph([
    { id: 'rev', triggers: [], github: { producesPr: true } },
    { id: 'mrg', triggers: [], channels: [{ artifact: 'pr', from: 'rev', label: 'approved', transport: 'internal' }] },
    { id: 'dep', triggers: [], channels: [{ artifact: 'pr', from: 'rev', label: 'approved', gate: 'human', transport: 'internal' }] },
    { id: 'cons', triggers: [], channels: [{ artifact: 'pr', from: 'rev', transport: 'internal' }] },
  ]);
  assert.equal(findEdge(g, x => x.on === 'github' && x.to === 'mrg').transport, 'internal');
  assert.ok(!('transport' in findEdge(g, x => x.on === 'github' && x.to === 'dep')), 'human gate stays poller-delivered');
  assert.ok(!('transport' in findEdge(g, x => x.on === 'github' && x.to === 'cons')), 'unlabelled stays poller-delivered');
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

test('process lints carried through (gate-violation when an agent emits a flagged gate)', () => {
  const g = buildUnifiedGraph(
    [{ id: 'rogue', emits: ['approved-for-deploy'], triggers: [{ id: 't', type: 'github-event', events: ['x'] }] }],
    undefined,
    { labels: [{ name: 'approved-for-deploy', humanGate: true, brake: false }] },
  );
  assert.ok(lintCodes(g).includes('gate-violation'));
});

// #928 AC6 — the draft path (POST /api/flows/graph) forwards the bundle's own
// registry, so a gate authored in a draft renders as a gate end-to-end.
test('processTemplateToUnified carries labels[] so a bundle gate renders as a gate', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'd', level: 'template',
    roles: [{ id: 'deployer', triggers: [{ id: 't', type: 'github-event', labelFilter: 'approved-for-deploy' }] }],
    gates: [], labels: [{ name: 'approved-for-deploy', humanGate: true, brake: false }],
  };
  const flow = processTemplateToUnified(bundle);
  const g = buildUnifiedGraph(flow.nodes, flow.edges, { labels: flow.labels });
  const e = findEdge(g, x => x.label === 'approved-for-deploy');
  assert.equal(e.gate, 'human');
  assert.equal(e.from, null); // #987 — unbound gate; no generic @human hub
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

// ── #987: no generic @human hub — unbound touchpoints draw nothing + lint ─────

test('#987: an unbound brake emit terminates on null (no @human actor) + unbound-brake lint', () => {
  const g = buildUnifiedGraph(
    [{ id: 'reworker', emits: ['human-decision-needed'], triggers: [] }],
    undefined,
    { labels: [{ name: 'human-decision-needed', brake: true }] },
  );
  const e = findEdge(g, x => x.label === 'human-decision-needed');
  assert.ok(e);
  assert.equal(e.from, 'reworker');
  assert.equal(e.to, null);
  assert.equal(e.handoff, 'human');
  assert.ok(!e.gate, 'a hand-off is not an approval gate');
  assert.ok(!g.nodes.some(n => n.id === '@human'), 'no generic @human actor');
  assert.ok(lintCodes(g).includes('unbound-brake'));
});

test('#987: an unbound human-audience PR clears producer-unconsumed, draws no @human, lints unbound-delivery', () => {
  const g = buildUnifiedGraph(
    [{ id: 'dev', github: { producesPr: true, prAudience: 'human' }, triggers: [] }],
  );
  assert.ok(!g.nodes.some(n => n.id === '@human'), 'no generic @human actor');
  assert.ok(!lintCodes(g).includes('producer-unconsumed'));
  assert.ok(g.lints.some(l => l.code === 'unbound-delivery' && l.nodeId === 'dev'));
});

test('#981: humanTouchpoints pass through the unified graph', () => {
  const g = buildUnifiedGraph(
    [
      { id: 'dev3', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready-3' }] },
      { id: 'reworker', emits: ['human-decision-needed'], triggers: [] },
    ],
    undefined,
    { labels: [{ name: 'ready-3', humanGate: true }, { name: 'human-decision-needed', brake: true }] },
  );
  assert.deepEqual(g.humanTouchpoints, [
    { type: 'injection', label: 'ready-3', agentId: 'dev3' },
    { type: 'decision', label: 'human-decision-needed', agentId: 'reworker' },
  ]);
});

// ── #987 follow-up: data-flow artifacts for a person (no @human hub) ──────────

test('#987: an unbound human-audience output clears unconsumed-output, draws no @human, lints unbound-delivery', () => {
  const before = buildUnifiedGraph([
    { id: 'analyst', outputs: [{ name: 'analysis-report', hint: 'reports/analysis.md' }], triggers: [] },
  ]);
  assert.ok(lintCodes(before).includes('unconsumed-output'));

  const after = buildUnifiedGraph([
    { id: 'analyst', outputs: [{ name: 'analysis-report', hint: 'reports/analysis.md', audience: 'human' }], triggers: [] },
  ]);
  assert.ok(!lintCodes(after).includes('unconsumed-output'));
  assert.ok(!after.nodes.some(n => n.id === '@human'), 'no generic @human actor');
  assert.ok(after.lints.some(l => l.code === 'unbound-delivery' && l.nodeId === 'analyst'));
  // Still surfaced as a touchpoint (unassigned — no role) for the panel.
  assert.ok(after.humanTouchpoints.some(t => t.type === 'delivery' && t.name === 'analysis-report' && !t.role));
});

test('#987: a human-audience output that an agent ALSO consumes keeps the agent edge; no @human', () => {
  const g = buildUnifiedGraph([
    { id: 'analyst', outputs: [{ name: 'report', audience: 'human' }], triggers: [] },
    { id: 'writer', inputs: [{ name: 'report' }], triggers: [] },
  ]);
  assert.ok(findEdge(g, x => x.on === 'artifact' && x.from === 'analyst' && x.to === 'writer'));
  assert.ok(!g.nodes.some(n => n.id === '@human'), 'no generic @human actor');
  assert.ok(!lintCodes(g).includes('unconsumed-output'));
});

test('#981: artifact deliveries appear as file touchpoints, merged in order', () => {
  const g = buildUnifiedGraph(
    [
      { id: 'analyst', outputs: [{ name: 'analysis-report', audience: 'human' }], triggers: [] },
      { id: 'reworker', emits: ['human-decision-needed'], triggers: [] },
    ],
    undefined,
    { labels: [{ name: 'human-decision-needed', brake: true }] },
  );
  assert.deepEqual(g.humanTouchpoints, [
    { type: 'decision', label: 'human-decision-needed', agentId: 'reworker' },
    { type: 'delivery', artifact: 'file', name: 'analysis-report', agentId: 'analyst' },
  ]);
});

// ── #987: named human roles routed onto first-class nodes ────────────────────

test('#987: a human node joins the unified node set with its stage, not the actor column', () => {
  const g = buildUnifiedGraph(
    [{ id: 'dev', triggers: [] }],
    undefined,
    { humans: [{ id: 'reviewer', name: 'Issue Reviewer', stage: 'triage' }] },
  );
  const hn = g.nodes.find(n => n.id === 'reviewer');
  assert.ok(hn);
  assert.equal(hn.kind, 'human');
  assert.equal(hn.effectiveStage, 'triage');
  // Not an actor node.
  assert.notEqual(hn.role, 'actor');
});

test('#987: a gate emitted by a human routes reviewer → listener, and NO @human actor appears', () => {
  const g = buildUnifiedGraph(
    [{ id: 'dispatcher', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'dispatch' }] }],
    undefined,
    { humans: [{ id: 'reviewer', name: 'Issue Reviewer', emits: ['dispatch'] }] },
  );
  const e = findEdge(g, x => x.on === 'label' && x.label === 'dispatch');
  assert.equal(e.from, 'reviewer');
  assert.equal(e.to, 'dispatcher');
  assert.equal(e.gate, 'human');
  assert.ok(!g.nodes.some(n => n.id === '@human'), 'no generic @human actor when the gate is bound');
});

test('#987: a brake consumed by a human terminates on the named node, not @human', () => {
  const g = buildUnifiedGraph(
    [{ id: 'reworker', emits: ['needs-decision'], triggers: [] }],
    undefined,
    {
      labels: [{ name: 'needs-decision', brake: true }],
      humans: [{ id: 'lead', name: 'Lead', consumes: [{ label: 'needs-decision' }] }],
    },
  );
  const e = findEdge(g, x => x.handoff === 'human' && x.from === 'reworker');
  assert.equal(e.to, 'lead');
  assert.ok(!g.nodes.some(n => n.id === '@human'));
});

test('#987: a PR/issue delivery bound to a human routes to the named node (on:github)', () => {
  const g = buildUnifiedGraph(
    [{ id: 'dev', github: { producesPr: true }, triggers: [] }],
    undefined,
    { humans: [{ id: 'maintainer', name: 'Maintainer', consumes: [{ artifact: 'pr', from: 'dev' }] }] },
  );
  const e = findEdge(g, x => x.on === 'github' && x.audience === 'human' && x.from === 'dev');
  assert.equal(e.to, 'maintainer');
  assert.ok(!lintCodes(g).includes('producer-unconsumed'));
});

test('#987: a file output consumed by a human routes to the named node and clears unconsumed-output', () => {
  const g = buildUnifiedGraph(
    [{ id: 'analyst', outputs: [{ name: 'analysis-report' }], triggers: [] }],
    undefined,
    { humans: [{ id: 'stakeholder', name: 'Stakeholder', consumes: [{ artifact: 'file', name: 'analysis-report' }] }] },
  );
  const e = findEdge(g, x => x.on === 'artifact' && x.audience === 'human' && x.from === 'analyst');
  assert.equal(e.to, 'stakeholder');
  assert.ok(!lintCodes(g).includes('unconsumed-output'));
  const tp = g.humanTouchpoints.find(t => t.type === 'delivery' && t.name === 'analysis-report');
  assert.equal(tp.role, 'stakeholder');
});

test('#987: an unbound touchpoint draws no @human hub, just terminates on null + lints', () => {
  const g = buildUnifiedGraph(
    [{ id: 'reworker', emits: ['needs-decision'], triggers: [] }],
    undefined,
    {
      labels: [{ name: 'needs-decision', brake: true }],
      humans: [{ id: 'reviewer', name: 'R', emits: ['other'] }], // does not consume the brake
    },
  );
  const e = findEdge(g, x => x.handoff === 'human' && x.from === 'reworker');
  assert.equal(e.to, null);
  assert.ok(!g.nodes.some(n => n.id === '@human'), 'no generic @human actor');
  assert.ok(lintCodes(g).includes('unbound-brake'));
  // But the reviewer role itself is still a node on the canvas.
  assert.ok(g.nodes.some(n => n.id === 'reviewer' && n.kind === 'human'));
});

test('#987: no humans[] is byte-identical to omitting the option', () => {
  const nodes = [
    { id: 'analyst', outputs: [{ name: 'r', audience: 'human' }], triggers: [] },
    { id: 'reworker', emits: ['needs-decision'], triggers: [] },
  ];
  const opts = { labels: [{ name: 'needs-decision', brake: true }] };
  const withEmpty = buildUnifiedGraph(nodes, undefined, { ...opts, humans: [] });
  const without = buildUnifiedGraph(nodes, undefined, opts);
  assert.deepEqual(withEmpty, without);
});

test('#1197: a plain label a human consumes maps to an on:label handoff:human delivery edge (no gate/brake)', () => {
  const g = buildUnifiedGraph(
    [{ id: 'reworker', emits: ['ready-for-review'], triggers: [] }],
    undefined,
    {
      labels: [{ name: 'ready-for-review', humanGate: false, brake: false }],
      humans: [{ id: 'lead', name: 'Tech Lead', consumes: [{ label: 'ready-for-review' }] }],
    },
  );
  const e = findEdge(g, x => x.label === 'ready-for-review' && x.to === 'lead');
  assert.ok(e, 'the delivery edge reaches the named person');
  assert.equal(e.on, 'label');
  assert.equal(e.from, 'reworker');
  assert.equal(e.handoff, 'human');
  assert.ok(!e.gate, 'a plain-label delivery is not an approval gate');
  assert.ok(!e.brake, 'a plain-label delivery is not a brake');
  assert.ok(!e.triggerId, 'the emit-side delivery has no listening trigger');
  assert.ok(g.nodes.some(n => n.id === 'lead' && n.kind === 'human'));
  assert.ok(g.humanTouchpoints.some(t => t.type === 'delivery' && t.label === 'ready-for-review' && t.role === 'lead'));
});

test('#1004: a marked output artifact is an endpoint — no unconsumed-output lint', () => {
  const mk = (out) => buildUnifiedGraph([
    { id: 'analyst', outputs: [out], triggers: [] },
  ], undefined, {});
  assert.ok(lintCodes(mk({ name: 'report' })).includes('unconsumed-output'), 'unmarked output still lints');
  assert.ok(!lintCodes(mk({ name: 'report', terminal: true })).includes('unconsumed-output'));
  assert.ok(!lintCodes(mk({ name: 'report', external: { note: 'org dashboard' } })).includes('unconsumed-output'));
});

// ─── #2031: on:'wake' — the direct agent-to-agent hand-off discriminator ─────

const wakeGraph = (options) => buildUnifiedGraph([
  { id: 'dev', displayName: 'Developer', triggers: [], outcomes: { mode: 'anyOf', options } },
  { id: 'rev', displayName: 'Reviewer', triggers: [] },
], undefined, {});

test('#2031: a wakeAgent action becomes an on:\'wake\' edge, not a label edge', () => {
  const g = wakeGraph([{ id: 'handed-off', actions: [{ type: 'wakeAgent', to: 'rev', note: 'mind step 3' }] }]);
  const e = g.edges.find(x => x.on === 'wake');
  assert.ok(e, 'the hand-off is drawn');
  assert.equal(e.from, 'dev');
  assert.equal(e.to, 'rev');
  assert.equal(e.outcome, 'handed-off');
  assert.equal(e.note, 'mind step 3');
  // The three things a direct hand-off deliberately does NOT carry: it is not a
  // label hand-off, it has no listening trigger to edit (the consumer's listener
  // is derived from this action), and it is internal by construction so there is
  // no transport to select.
  assert.equal(e.label, undefined, 'no label token');
  assert.equal(e.triggerId, undefined, 'no listening trigger — the action is the authoring point');
  assert.equal(e.transport, undefined, 'internal by construction — nothing to toggle');
  assert.equal(e.gate, undefined);
  assert.equal(e.handoff, undefined, '`handoff` means human decision / brake — never reused here');
  assert.equal(g.edges.filter(x => x.on === 'label').length, 0);
});

test('#2031: edgeId keys a wake edge on its outcome so two hand-offs cannot collide', () => {
  const g = wakeGraph([
    { id: 'approved', actions: [{ type: 'wakeAgent', to: 'rev' }] },
    { id: 'second-look', actions: [{ type: 'wakeAgent', to: 'rev' }] },
  ]);
  const wake = g.edges.filter(x => x.on === 'wake');
  assert.equal(wake.length, 2, 'both hand-offs survive de-duplication');
  assert.deepEqual(wake.map(e => e.id), ['wake|dev→rev|approved', 'wake|dev→rev|second-look']);

  // Mutation proof that the `on === 'wake'` arm of edgeId is load-bearing, not
  // decoration: a wake edge has no label, no events and no paths, so WITHOUT it
  // the generic tail is '' for every hand-off and both ids are the same string —
  // the second edge would be silently dropped by the `seen` set. Recomputing the
  // pre-change id here would be a lie unless it actually collides, so assert it.
  const legacyId = (e) => {
    const tail = e.label != null ? e.label
      : (Array.isArray(e.events) ? e.events.join(',')
        : (Array.isArray(e.paths) ? e.paths.join(',') : ''));
    return `${e.on}|${e.from}→${e.to}|${tail}`;
  };
  assert.equal(legacyId(wake[0]), legacyId(wake[1]),
    'the un-keyed id collides — which is exactly what the outcome tail prevents');
  assert.notEqual(wake[0].id, wake[1].id);
});

test('#2031: a wake edge to a DIFFERENT target needs no outcome to stay distinct', () => {
  const g = buildUnifiedGraph([
    { id: 'dev', triggers: [], outcomes: { mode: 'anyOf', options: [
      { id: 'h', actions: [{ type: 'wakeAgent', to: 'rev' }, { type: 'wakeAgent', to: 'docs' }] },
    ] } },
    { id: 'rev', triggers: [] },
    { id: 'docs', triggers: [] },
  ], undefined, {});
  assert.deepEqual(g.edges.filter(e => e.on === 'wake').map(e => e.to).sort(), ['docs', 'rev']);
});

test('#2031: a wakeAgent alongside a setLabel in ONE option draws both edges', () => {
  // Concept §11: the two mechanisms coexist and may sit in the same outcome.
  const g = buildUnifiedGraph([
    { id: 'dev', triggers: [], outcomes: { mode: 'anyOf', options: [
      { id: 'h', actions: [{ type: 'setLabel', label: 'ready-for-review' }, { type: 'wakeAgent', to: 'rev' }] },
    ] } },
    { id: 'rev', triggers: [{ id: 't', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review' }] },
  ], undefined, {});
  assert.ok(g.edges.some(e => e.on === 'wake' && e.from === 'dev' && e.to === 'rev'));
  assert.ok(g.edges.some(e => e.on === 'label' && e.from === 'dev' && e.to === 'rev'));
});
