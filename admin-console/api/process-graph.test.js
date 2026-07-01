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

test('github channel: derived channel triggers do not produce label/event edges', () => {
  // A consumer's derived channel trigger (channel:true) is represented by the
  // on:'github' edge built from the port (unified-graph) — never as an external
  // event edge or orphan listener here.
  const g = buildProcessGraph([
    { id: 'dev', triggers: [], github: { producesPr: true } },
    { id: 'rev', channels: [{ artifact: 'pr', from: 'dev' }], triggers: [
      { id: 'rev-on-pr-dev', type: 'github-event', channel: true,
        events: ['pull_request.opened', 'pull_request.reopened'], from: ['dev'] },
    ] },
  ]);
  assert.equal(g.edges.filter(e => e.external).length, 0);
  assert.ok(!g.lints.some(l => l.code === 'orphan-listener'));
});

test('lint: a producer whose artifact nobody consumes is flagged (info)', () => {
  const g = buildProcessGraph([{ id: 'dev', triggers: [], github: { producesPr: true } }]);
  assert.ok(g.lints.some(l => l.code === 'producer-unconsumed' && l.nodeId === 'dev'));
});

test('lint: a channel from a non-producer is flagged (warning)', () => {
  const g = buildProcessGraph([
    { id: 'dev', triggers: [] }, // does NOT declare producesPr
    { id: 'rev', triggers: [], channels: [{ artifact: 'pr', from: 'dev' }] },
  ]);
  assert.ok(g.lints.some(l => l.code === 'channel-from-non-producer' && l.nodeId === 'rev'));
});

test('channel-label listener: extra emitters wire feedback edges, pinned producer stays the github edge, no dead-end lint (#401)', () => {
  // author listens on `go` via a channel pinned to `intake`; router + broker also
  // emit `go` (rework loops). The pinned producer edge is drawn as on:'github'
  // (from the port, in unified-graph), so buildProcessGraph must NOT redraw it as
  // a label edge — but it MUST wire the two non-pinned emitters, and must not
  // report `go` as a dead-end.
  const g = buildProcessGraph([
    { id: 'intake', triggers: [], github: { producesIssue: true }, emits: ['go'] },
    { id: 'author', triggers: [], channels: [{ artifact: 'issue', from: 'intake', label: 'go' }] },
    { id: 'router', triggers: [], emits: ['go'] },
    { id: 'broker', triggers: [], emits: ['go'] },
  ]);
  const labelEdges = g.edges.filter(e => e.label === 'go' && e.kind === 'agent');
  const pairs = labelEdges.map(e => `${e.from}->${e.to}`).sort();
  assert.deepEqual(pairs, ['broker->author', 'router->author']);
  // The pinned producer is not redrawn as a label edge here (it is the github edge).
  assert.ok(!pairs.includes('intake->author'));
  // `go` is listened on (via the channel) so it is not a dead-end.
  assert.ok(!g.lints.some(l => l.code === 'dead-end-emitter' && l.label === 'go'));
});

test('channel without a routing label contributes no label-listen key', () => {
  // A bare PR channel (open, not labelled) must not turn arbitrary emits into edges.
  const g = buildProcessGraph([
    { id: 'author', triggers: [], github: { producesPr: true }, emits: ['whatever'] },
    { id: 'router', triggers: [], channels: [{ artifact: 'pr', from: 'author' }] },
  ]);
  assert.ok(!g.edges.some(e => e.label === 'whatever' && e.kind === 'agent' && e.to));
  assert.ok(g.lints.some(l => l.code === 'dead-end-emitter' && l.label === 'whatever'));
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
