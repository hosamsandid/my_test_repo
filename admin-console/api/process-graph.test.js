'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');

const { buildProcessGraph, computeLints, listenKeys, classifyKind } = require('./process-graph');

function lintCodes(g) { return g.lints.map(l => l.code); }
const { deriveEmitsForTrigger } = require('./emits-derivation');

const TEMPLATES_DIR = path.join(
  __dirname, '..', '..', 'orchestrator', 'skill-pool', 'agent-templates',
);

// Mirror of api.js#effectiveTriggers for the template level (derive on).
function templateNode(tpl) {
  const triggers = (tpl.triggers || []).map(tr => {
    const t = { ...tr, prompt: tr.promptTemplate };
    if (Array.isArray(tr.emits)) return t;
    const sug = deriveEmitsForTrigger(t, tpl.promptTemplate || '');
    return { ...t, emits: sug.map(s => s.label), emitsDerived: sug.length > 0 };
  });
  return { id: tpl.id, role: 'template', displayName: tpl.displayName, triggers };
}
function loadTpl(id) {
  return JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, `${id}.json`), 'utf8'));
}

function edgesBetween(g, from, to) {
  return g.edges.filter(e => e.from === from && e.to === to);
}

test('listenKeys: labelFilter wins over the carrying event', () => {
  assert.deepEqual(
    listenKeys({ type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' }),
    ['ready'],
  );
  assert.deepEqual(
    listenKeys({ type: 'github-event', events: ['pull_request.opened', 'pull_request.reopened'] }),
    ['pull_request.opened', 'pull_request.reopened'],
  );
  assert.deepEqual(listenKeys({ type: 'cron', cron: '* * * * *' }), []);
});

test('classifyKind', () => {
  assert.equal(classifyKind('human:fdd-approved'), 'gate');
  assert.equal(classifyKind('hold'), 'brake');
  assert.equal(classifyKind('needs:human'), 'brake');
  assert.equal(classifyKind('pull_request_review.submitted'), 'review');
  assert.equal(classifyKind('stage:td'), 'agent');
});

test('emitter→listener edge forms on a matching label', () => {
  const g = buildProcessGraph([
    { id: 'a', triggers: [{ id: 't1', type: 'github-event', events: ['issues.opened'], emits: ['dispatch'] }] },
    { id: 'b', triggers: [{ id: 't2', type: 'github-event', events: ['issues.labeled'], labelFilter: 'dispatch' }] },
  ]);
  const e = edgesBetween(g, 'a', 'b');
  assert.equal(e.length, 1);
  assert.equal(e[0].label, 'dispatch');
  assert.equal(e[0].kind, 'agent');
  assert.ok(!e[0].orphan);
});

test('orphan listener: nothing emits the label', () => {
  const g = buildProcessGraph([
    { id: 'b', triggers: [{ id: 't', type: 'github-event', labelFilter: 'dispatch' }] },
  ]);
  const e = g.edges.find(x => x.to === 'b' && x.label === 'dispatch');
  assert.equal(e.from, null);
  assert.equal(e.orphan, true);
});

test('dead-end emitter: nothing listens on the emitted label', () => {
  const g = buildProcessGraph([
    { id: 'a', triggers: [{ id: 't', type: 'github-event', events: ['x'], emits: ['stage:done'] }] },
  ]);
  const e = g.edges.find(x => x.from === 'a' && x.deadEnd);
  assert.ok(e);
  assert.equal(e.to, null);
  assert.equal(e.label, 'stage:done');
});

test('human gate and brake edges originate from null and are tagged', () => {
  const g = buildProcessGraph([
    { id: 'rel', triggers: [
      { id: 't1', type: 'github-event', labelFilter: 'human:go-live-approved' },
      { id: 't2', type: 'github-event', labelFilter: 'hold' },
    ] },
  ]);
  const gate = g.edges.find(e => e.label === 'human:go-live-approved');
  assert.equal(gate.from, null);
  assert.equal(gate.kind, 'gate');
  const brake = g.edges.find(e => e.label === 'hold');
  assert.equal(brake.kind, 'brake');
  assert.deepEqual(g.gates, [{ label: 'human:go-live-approved', humanOnly: true }]);
});

test('cron/once become self-loop timer edges; node is not an entry point if it has a github trigger', () => {
  const g = buildProcessGraph([
    { id: 'a', triggers: [
      { id: 'c', type: 'cron', cron: '*/15 * * * *' },
      { id: 'e', type: 'github-event', labelFilter: 'ready' },
    ] },
  ]);
  const timer = g.edges.find(e => e.kind === 'timer');
  assert.equal(timer.from, 'a');
  assert.equal(timer.to, 'a');
  assert.equal(timer.label, '*/15 * * * *');
  assert.equal(g.nodes[0].isEntryPoint, false);
});

test('DM-only agent (no triggers) is an entry point', () => {
  const g = buildProcessGraph([{ id: 'ba', role: 'team-member', triggers: [] }]);
  assert.equal(g.nodes[0].isEntryPoint, true);
});

test('one emitter feeding two listeners yields two edges', () => {
  const g = buildProcessGraph([
    { id: 'src', triggers: [{ id: 't', type: 'github-event', events: ['x'], emits: ['go'] }] },
    { id: 'l1', triggers: [{ id: 't', type: 'github-event', labelFilter: 'go' }] },
    { id: 'l2', triggers: [{ id: 't', type: 'github-event', labelFilter: 'go' }] },
  ]);
  assert.equal(edgesBetween(g, 'src', 'l1').length, 1);
  assert.equal(edgesBetween(g, 'src', 'l2').length, 1);
});

test('label registry tags gates and brakes', () => {
  const g = buildProcessGraph([
    { id: 'a', triggers: [
      { id: 't', type: 'github-event', labelFilter: 'human:td-approved', emits: ['stage:build'] },
      { id: 'h', type: 'github-event', labelFilter: 'hold' },
    ] },
  ]);
  const byName = Object.fromEntries(g.labels.map(l => [l.name, l]));
  assert.equal(byName['human:td-approved'].humanGate, true);
  assert.equal(byName['hold'].brake, true);
  assert.equal(byName['stage:build'].humanGate, false);
});

test('template level: shipped dispatcher + developer derive emits onto nodes', () => {
  const g = buildProcessGraph([templateNode(loadTpl('dispatcher')), templateNode(loadTpl('developer'))]);
  const dispatcher = g.nodes.find(n => n.id === 'dispatcher');
  const dispatcherEmits = dispatcher.triggers.flatMap(t => t.emits);
  assert.ok(dispatcherEmits.includes('{{dispatchLabel}}'),
    'dispatcher should derive {{dispatchLabel}} as an emitted label');

  const developer = g.nodes.find(n => n.id === 'developer');
  const assigned = developer.triggers.find(t => t.id === 'developer-assigned');
  assert.ok(assigned.emits.includes('started:{{agentId}}'));
  assert.equal(assigned.emitsDerived, true);
});

test('template level: a synthetic listener wires to a shipped emitter', () => {
  // Prove the mechanism end-to-end: someone listening on {{dispatchLabel}} gets
  // an edge from the dispatcher (which emits it).
  const listener = {
    id: 'consumer', role: 'template',
    triggers: [{ id: 'l', type: 'github-event', labelFilter: '{{dispatchLabel}}' }],
  };
  const g = buildProcessGraph([templateNode(loadTpl('dispatcher')), listener]);
  const e = g.edges.find(x => x.from === 'dispatcher' && x.to === 'consumer');
  assert.ok(e, 'expected dispatcher → consumer edge on {{dispatchLabel}}');
  assert.equal(e.label, '{{dispatchLabel}}');
});

test('all shipped templates build a graph without throwing', () => {
  const nodes = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => templateNode(JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8'))));
  assert.doesNotThrow(() => buildProcessGraph(nodes));
});

test('lint: orphan listener fires and is keyed to the target node', () => {
  const g = buildProcessGraph([
    { id: 'b', triggers: [{ id: 't', type: 'github-event', from: 'any-except-self', labelFilter: 'dispatch' }] },
  ]);
  const orphan = g.lints.find(l => l.code === 'orphan-listener');
  assert.ok(orphan);
  assert.equal(orphan.nodeId, 'b');
  assert.equal(orphan.label, 'dispatch');
});

test('lint: dead-end emitter fires', () => {
  const g = buildProcessGraph([
    { id: 'a', triggers: [{ id: 't', type: 'github-event', from: 'any-except-self', events: ['x'], emits: ['stage:done'] }] },
  ]);
  assert.ok(g.lints.some(l => l.code === 'dead-end-emitter' && l.nodeId === 'a'));
});

test('lint: unguarded self-trigger when from is absent', () => {
  const g = buildProcessGraph([
    { id: 'a', triggers: [{ id: 't', type: 'github-event', events: ['issues.opened'] }] },
  ]);
  assert.ok(g.lints.some(l => l.code === 'unguarded-self-trigger' && l.triggerId === 't'));
  // ...and does NOT fire when a from filter is present
  const g2 = buildProcessGraph([
    { id: 'a', triggers: [{ id: 't', type: 'github-event', from: 'humans', events: ['issues.opened'] }] },
  ]);
  assert.ok(!g2.lints.some(l => l.code === 'unguarded-self-trigger'));
});

test('lint: competing stage labels', () => {
  const g = buildProcessGraph([
    { id: 'a', triggers: [{ id: 't', type: 'github-event', from: 'humans', events: ['x'], emits: ['stage:td', 'stage:build'] }] },
  ]);
  assert.ok(g.lints.some(l => l.code === 'competing-stage' && l.nodeId === 'a'));
});

test('lint: gate-violation when an agent emits a human:* label (error severity)', () => {
  const g = buildProcessGraph([
    { id: 'a', triggers: [{ id: 't', type: 'github-event', from: 'humans', events: ['x'], emits: ['human:fdd-approved'] }] },
  ]);
  const v = g.lints.find(l => l.code === 'gate-violation');
  assert.ok(v);
  assert.equal(v.severity, 'error');
  assert.equal(v.nodeId, 'a');
});

test('lint: a clean wired pair produces no lints', () => {
  const g = buildProcessGraph([
    { id: 'a', triggers: [{ id: 't', type: 'github-event', from: 'humans', events: ['x'], emits: ['dispatch'] }] },
    { id: 'b', triggers: [{ id: 't', type: 'github-event', from: 'any-except-self', labelFilter: 'dispatch' }] },
  ]);
  assert.deepEqual(g.lints, []);
});

test('pr-review node yields outcome edges (in / approve / changes)', () => {
  const g = buildProcessGraph([
    { id: 'dev', triggers: [] },
    { id: 'rel', triggers: [] },
    { id: 'rev', kind: 'pr-review', triggers: [],
      review: { reviewsPrFrom: 'dev', onApprove: 'rel', onChangesRequested: 'dev' } },
  ]);
  const inEdge = g.edges.find(e => e.kind === 'review' && e.reviewFlow === 'in');
  assert.equal(inEdge.from, 'dev'); assert.equal(inEdge.to, 'rev');
  const approve = g.edges.find(e => e.outcome === 'approve');
  assert.equal(approve.from, 'rev'); assert.equal(approve.to, 'rel');
  const changes = g.edges.find(e => e.outcome === 'changes');
  assert.equal(changes.from, 'rev'); assert.equal(changes.to, 'dev'); // rework back-edge
  assert.equal(g.nodes.find(n => n.id === 'rev').kind, 'pr-review');
});

test('pr-review review edges skip targets that are not in the graph', () => {
  const g = buildProcessGraph([
    { id: 'rev', kind: 'pr-review', triggers: [], review: { reviewsPrFrom: 'ghost', onApprove: 'nope' } },
  ]);
  assert.equal(g.edges.filter(e => e.kind === 'review').length, 0);
});

test('a human-approval gate (downstream waits on human:*) renders as a gate and never trips gate-violation', () => {
  // The #346 shape: downstream listens on the gate label; nobody emits it.
  const g = buildProcessGraph([
    { id: 'release', triggers: [
      { id: 'gate', type: 'github-event', from: 'humans', events: ['issues.labeled'], labelFilter: 'human:go-live-approved' },
    ] },
  ]);
  const gateEdge = g.edges.find(e => e.label === 'human:go-live-approved');
  assert.equal(gateEdge.kind, 'gate');
  assert.equal(gateEdge.from, null);
  assert.deepEqual(g.gates, [{ label: 'human:go-live-approved', humanOnly: true }]);
  assert.ok(!g.lints.some(l => l.code === 'gate-violation'));
  // and it is NOT an orphan-listener (gates are external, not orphans)
  assert.ok(!g.lints.some(l => l.code === 'orphan-listener'));
});

test('lint: an unwired pr-review step is flagged', () => {
  const g = buildProcessGraph([{ id: 'rev', kind: 'pr-review', triggers: [], review: {} }]);
  assert.ok(g.lints.some(l => l.code === 'review-unwired' && l.nodeId === 'rev'));
});

test('node view exposes the expected fields', () => {
  const g = buildProcessGraph([{
    id: 'dev', role: 'team-member', displayName: 'Developer', sessionPolicy: 'per-invocation',
    environmentId: 'team-x',
    triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], from: 'any-except-self',
      labelFilter: 'assigned:dev', emits: ['started:dev'], emitsDerived: true }],
  }]);
  const n = g.nodes[0];
  assert.equal(n.role, 'team-member');
  assert.equal(n.displayName, 'Developer');
  assert.equal(n.sessionPolicy, 'per-invocation');
  assert.equal(n.environmentId, 'team-x');
  const t = n.triggers[0];
  assert.deepEqual(t.events, ['issues.labeled']);
  assert.equal(t.from, 'any-except-self');
  assert.equal(t.labelFilter, 'assigned:dev');
  assert.deepEqual(t.emits, ['started:dev']);
  assert.equal(t.emitsDerived, true);
});

test('agent-level emits wire a label hand-off without a pre-existing trigger', () => {
  // A declares an agent-level emit (no trigger needed); B listens via labelFilter.
  const g = buildProcessGraph([
    { id: 'a', emits: ['dispatch'], triggers: [] },
    { id: 'b', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'dispatch', from: 'any-except-self' }] },
  ]);
  const e = g.edges.find(x => x.from === 'a' && x.to === 'b' && x.label === 'dispatch');
  assert.ok(e, 'A→B label edge exists from the agent-level emit');
  // Not flagged as an orphan listener.
  assert.ok(!g.lints.some(l => l.code === 'orphan-listener'));
});
