'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');

const { buildProcessGraph, computeLints, listenKeys, classifyKind } = require('./process-graph');

function lintCodes(g) { return g.lints.map(l => l.code); }

const TEMPLATES_DIR = path.join(
  __dirname, '..', '..', 'orchestrator', 'skill-pool', 'agent-templates',
);

// Mirror of api.js's template-level graph gathering (#783): a template's label
// hand-offs come from its role-level `emits`; triggers contribute listen side
// only.
function templateNode(tpl) {
  const triggers = (tpl.triggers || []).map(tr => ({ ...tr, prompt: tr.promptTemplate }));
  return {
    id: tpl.id, role: 'template', displayName: tpl.displayName,
    emits: Array.isArray(tpl.emits) ? tpl.emits : [],
    ...(tpl.outcomes ? { outcomes: tpl.outcomes } : {}),
    triggers,
  };
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

// #928 AC1 — classification reads the CONFIG FLAGS, never the label's name.
test('classifyKind reads the label-registry flags', () => {
  const reg = { labels: [
    { name: 'approved-for-dispatch', humanGate: true, brake: false },
    { name: 'human-decision-required', humanGate: false, brake: true },
    { name: 'ready-for-review', humanGate: false, brake: false },
  ] };
  assert.equal(classifyKind('approved-for-dispatch', reg), 'gate');
  assert.equal(classifyKind('human-decision-required', reg), 'brake');
  assert.equal(classifyKind('ready-for-review', reg), 'agent');
  assert.equal(classifyKind('pull_request_review.submitted', reg), 'review');
  // #2536: the poller-sourced (Events API) form classifies identically.
  assert.equal(classifyKind('pull_request_review.created', reg), 'review');
});

test("classifyKind reads a channel's gate: 'human' flag", () => {
  const src = { agents: [{ id: 'dev', channels: [{ artifact: 'issue', from: 'ba', label: 'design-approved', gate: 'human' }] }] };
  assert.equal(classifyKind('design-approved', src), 'gate');
  // An ungated channel label stays a plain agent label.
  const plain = { agents: [{ id: 'dev', channels: [{ artifact: 'pr', from: 'ba', label: 'ready-for-review' }] }] };
  assert.equal(classifyKind('ready-for-review', plain), 'agent');
});

// #928 AC8 — the retired name convention carries no meaning of its own any more.
test('classifyKind: the retired human:* / hold / needs:human names are plain agent labels', () => {
  assert.equal(classifyKind('human:fdd-approved'), 'agent');
  assert.equal(classifyKind('hold'), 'agent');
  assert.equal(classifyKind('needs:human'), 'agent');
});

test('classifyKind: a gate flag wins over a brake flag on the same label', () => {
  const reg = { labels: [{ name: 'both', humanGate: true, brake: true }] };
  assert.equal(classifyKind('both', reg), 'gate');
});

test('emitter→listener edge forms on a matching label', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['dispatch'], triggers: [{ id: 't1', type: 'github-event', events: ['issues.opened'] }] },
    { id: 'b', triggers: [{ id: 't2', type: 'github-event', events: ['issues.labeled'], labelFilter: 'dispatch' }] },
  ]);
  const e = edgesBetween(g, 'a', 'b');
  assert.equal(e.length, 1);
  assert.equal(e[0].label, 'dispatch');
  assert.equal(e[0].kind, 'agent');
  assert.ok(!e[0].orphan);
});

test('orphan listener: nothing can set the label (agents-only origin)', () => {
  const g = buildProcessGraph([
    { id: 'b', triggers: [{ id: 't', type: 'github-event', labelFilter: 'dispatch', from: 'agents' }] },
  ]);
  const e = g.edges.find(x => x.to === 'b' && x.label === 'dispatch');
  assert.equal(e.from, null);
  assert.equal(e.orphan, true);
  assert.ok(g.lints.some(l => l.code === 'orphan-listener' && l.severity === 'warning'));
});

test('label listener with no agent emitter is a plain orphan (origin filters removed)', () => {
  // With source/origin filters gone there is no `from` to infer human-settability
  // from, so a label nobody emits is always a plain orphan (warning). A human
  // applying the label still fires the trigger at runtime — this is only about
  // what the static graph can prove.
  const g = buildProcessGraph([
    { id: 'b', triggers: [{ id: 't', type: 'github-event', labelFilter: 'priorisiert' }] },
  ]);
  const e = g.edges.find(x => x.to === 'b' && x.label === 'priorisiert');
  assert.equal(e.from, null);
  assert.equal(e.orphan, true);
  assert.ok(!e.humanSet && !e.humanAssumed, 'no human-origin inference any more');
  const lint = g.lints.find(l => l.code === 'orphan-listener');
  assert.equal(lint.severity, 'warning');
});

test('http trigger (#410): becomes a webhook edge from outside', () => {
  const g = buildProcessGraph([
    { id: 'b', triggers: [{ id: 'hook1', type: 'http', secret: 's3cret', description: 'CI done' }] },
  ]);
  const e = g.edges.find(x => x.kind === 'webhook');
  assert.ok(e);
  assert.equal(e.from, null);
  assert.equal(e.to, 'b');
  assert.equal(e.label, 'CI done');
  assert.equal(e.triggerId, 'hook1');
});

test('dead-end emitter: nothing listens on the emitted label', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['stage:done'], triggers: [{ id: 't', type: 'github-event', events: ['x'] }] },
  ]);
  const e = g.edges.find(x => x.from === 'a' && x.deadEnd);
  assert.ok(e);
  assert.equal(e.to, null);
  assert.equal(e.label, 'stage:done');
});

// #928 AC1/AC2 — edge origination is flag-driven; both labels carry ordinary,
// action-style names with no `human:` prefix anywhere.
test('human gate and brake edges originate from null and are tagged', () => {
  const g = buildProcessGraph([
    { id: 'rel', triggers: [
      { id: 't1', type: 'github-event', labelFilter: 'approved-for-go-live' },
      { id: 't2', type: 'github-event', labelFilter: 'human-decision-required' },
    ] },
  ], { labels: [
    { name: 'approved-for-go-live', humanGate: true, brake: false },
    { name: 'human-decision-required', humanGate: false, brake: true },
  ] });
  const gate = g.edges.find(e => e.label === 'approved-for-go-live');
  assert.equal(gate.from, null);
  assert.equal(gate.kind, 'gate');
  const brake = g.edges.find(e => e.label === 'human-decision-required');
  assert.equal(brake.kind, 'brake');
  assert.deepEqual(g.gates, [{ label: 'approved-for-go-live', humanOnly: true }]);
});

// #928 AC8 — without the flags the very same wiring is plain agent routing:
// two orphan listeners, no gate, no brake.
test('the same listeners WITHOUT flags are plain agent labels (name convention retired)', () => {
  const g = buildProcessGraph([
    { id: 'rel', triggers: [
      { id: 't1', type: 'github-event', labelFilter: 'human:go-live-approved' },
      { id: 't2', type: 'github-event', labelFilter: 'hold' },
    ] },
  ]);
  assert.deepEqual(g.gates, []);
  for (const label of ['human:go-live-approved', 'hold']) {
    const e = g.edges.find(x => x.label === label);
    assert.equal(e.kind, 'agent');
    assert.equal(e.orphan, true);
  }
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
    { id: 'src', emits: ['go'], triggers: [{ id: 't', type: 'github-event', events: ['x'] }] },
    { id: 'l1', triggers: [{ id: 't', type: 'github-event', labelFilter: 'go' }] },
    { id: 'l2', triggers: [{ id: 't', type: 'github-event', labelFilter: 'go' }] },
  ]);
  assert.equal(edgesBetween(g, 'src', 'l1').length, 1);
  assert.equal(edgesBetween(g, 'src', 'l2').length, 1);
});

test('label registry tags gates and brakes from the config flags', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['stage:build'], triggers: [
      { id: 't', type: 'github-event', labelFilter: 'td-approved' },
      { id: 'h', type: 'github-event', labelFilter: 'human-decision-required' },
    ] },
  ], { labels: [
    { name: 'td-approved', humanGate: true, brake: false },
    { name: 'human-decision-required', humanGate: false, brake: true },
  ] });
  const byName = Object.fromEntries(g.labels.map(l => [l.name, l]));
  assert.equal(byName['td-approved'].humanGate, true);
  assert.equal(byName['human-decision-required'].brake, true);
  assert.equal(byName['stage:build'].humanGate, false);
});

// #928 AC6 — a flagged label survives the export round-trip even when no port
// references it yet, so re-importing the bundle does not silently lose the gate.
test('label registry echoes back unreferenced registry entries with their flags', () => {
  const g = buildProcessGraph([{ id: 'a', triggers: [] }], {
    labels: [{ name: 'approved-for-dispatch', humanGate: true, brake: false }],
  });
  const byName = Object.fromEntries(g.labels.map(l => [l.name, l]));
  assert.deepEqual(byName['approved-for-dispatch'], { name: 'approved-for-dispatch', humanGate: true, brake: false });
});

test('template level: shipped dispatcher carries its role-level emits onto its node', () => {
  const g = buildProcessGraph([templateNode(loadTpl('dispatcher'))]);
  const dispatcher = g.nodes.find(n => n.id === 'dispatcher');
  assert.ok(dispatcher.emits.includes('dispatched-for-implementation'),
    'dispatcher should carry `dispatched-for-implementation` as a role-level emitted label');
});

test('template level: a synthetic listener wires to a shipped emitter', () => {
  // Prove the mechanism end-to-end: someone listening on
  // `dispatched-for-implementation` gets an edge from the dispatcher (which
  // emits it).
  const listener = {
    id: 'consumer', role: 'template',
    triggers: [{ id: 'l', type: 'github-event', labelFilter: 'dispatched-for-implementation' }],
  };
  const g = buildProcessGraph([templateNode(loadTpl('dispatcher')), listener]);
  const e = g.edges.find(x => x.from === 'dispatcher' && x.to === 'consumer');
  assert.ok(e, 'expected dispatcher → consumer edge on `dispatched-for-implementation`');
  assert.equal(e.label, 'dispatched-for-implementation');
});

test('template level: {{var}} label tokens still wire emitter to listener', () => {
  // Placeholders are matched verbatim at template level — resolved only at
  // materialisation. The shipped catalog no longer uses them, but imported /
  // hand-authored templates may.
  const emitter = {
    id: 'producer', role: 'template', emits: ['{{dispatchLabel}}'],
    triggers: [{ id: 'e', type: 'github-event', events: ['issues.opened'] }],
  };
  const listener = {
    id: 'consumer', role: 'template',
    triggers: [{ id: 'l', type: 'github-event', labelFilter: '{{dispatchLabel}}' }],
  };
  const g = buildProcessGraph([emitter, listener]);
  const e = g.edges.find(x => x.from === 'producer' && x.to === 'consumer');
  assert.ok(e, 'expected producer → consumer edge on {{dispatchLabel}}');
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
    { id: 'a', emits: ['stage:done'], triggers: [{ id: 't', type: 'github-event', from: 'any-except-self', events: ['x'] }] },
  ]);
  assert.ok(g.lints.some(l => l.code === 'dead-end-emitter' && l.nodeId === 'a'));
});

test('lint: no unguarded-self-trigger lint (origin filters removed)', () => {
  // The lint keyed off the absence of a `from` origin filter; with source
  // filtering gone, self-triggering is allowed by design (the Layer-3 throttle
  // is the backstop), so the lint must no longer fire.
  const g = buildProcessGraph([
    { id: 'a', triggers: [{ id: 't', type: 'github-event', events: ['issues.opened'] }] },
  ]);
  assert.ok(!g.lints.some(l => l.code === 'unguarded-self-trigger'));
});

test('lint: competing stage labels', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['stage:td', 'stage:build'], triggers: [{ id: 't', type: 'github-event', from: 'humans', events: ['x'] }] },
  ]);
  assert.ok(g.lints.some(l => l.code === 'competing-stage' && l.nodeId === 'a'));
});

// #928 AC2 — gate-violation fires on the FLAG, independent of the label's name.
test('lint: gate-violation when an agent emits a flagged gate label (error severity)', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['fdd-approved'], triggers: [{ id: 't', type: 'github-event', events: ['x'] }] },
  ], { labels: [{ name: 'fdd-approved', humanGate: true, brake: false }] });
  const v = g.lints.find(l => l.code === 'gate-violation');
  assert.ok(v);
  assert.equal(v.severity, 'error');
  assert.equal(v.nodeId, 'a');
});

test("lint: gate-violation also fires for a gate declared only by a channel's gate: 'human'", () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['design-approved'], triggers: [] },
    { id: 'b', triggers: [], channels: [{ artifact: 'issue', from: 'a', label: 'design-approved', gate: 'human' }] },
  ]);
  assert.ok(g.lints.some(l => l.code === 'gate-violation' && l.nodeId === 'a' && l.label === 'design-approved'));
});

// #928 AC3 — a brake is AGENT-applied (the reworker pausing the loop for a human
// decision), so emitting it must stay clean: no gate-violation, no dead-end.
test('lint: a brake label emitted by an agent trips NOTHING', () => {
  const g = buildProcessGraph([
    { id: 'reworker', emits: ['human-decision-required'], triggers: [] },
  ], { labels: [{ name: 'human-decision-required', humanGate: false, brake: true }] });
  assert.ok(!g.lints.some(l => l.code === 'gate-violation'));
  assert.ok(!g.lints.some(l => l.code === 'dead-end-emitter'));
});

test('lint: a clean wired pair produces no lints at all', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['dispatch'], triggers: [{ id: 't', type: 'github-event', from: 'humans', events: ['x'] }] },
    // The listener carries its derived claim (#958): since `unclaimed-listener`
    // is advisory, a pair is only fully clean once the label listener also
    // declares what it takes over when it wakes.
    { id: 'b', triggers: [{ id: 't', type: 'github-event', from: 'any-except-self', labelFilter: 'dispatch',
      claim: { remove: 'dispatch', add: 'dispatch:wip' } }] },
  ]);
  // A poller-delivered agent→agent label is the normal hand-off (#2578): neither
  // the retired `internal-channel-candidate` nor `direct-handoff-candidate` hint
  // fires on it any more.
  assert.deepEqual(g.lints, []);
});

test('#2578: a legacy transport field is inert — no internal hint, no edge/triggerView field', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['dispatch'], triggers: [] },
    { id: 'b', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'dispatch', transport: 'internal',
      claim: { remove: 'dispatch', add: 'dispatch:wip' } }] },
  ]);
  assert.ok(!g.lints.some((l) => l.code === 'internal-channel-candidate'));
  const e = g.edges.find(x => x.to === 'b' && x.label === 'dispatch');
  assert.equal(e.transport, undefined, 'the edge carries no transport');
  const nb = g.nodes.find(n => n.id === 'b');
  assert.equal(nb.triggers.find(t => t.id === 't').transport, undefined, 'triggerView drops it');
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

// #1524 — a `channel: true` listener whose labelFilter matches NO channels port
// on its node (installed post-hoc via POST /api/agents/:id/triggers copying the
// derived shape, or an orphan a reconcile hasn't stripped) must wire as an
// ordinary label listener, not skip and leave the producer's emit a false
// dead-end. Mirrors the florian-03/florian-04 repro in the issue.
test('#1524: a channel:true label listener with no backing port wires (not a dead-end)', () => {
  const g = buildProcessGraph([
    { id: 'reviewer', emits: ['revisions-required', 'ready-to-merge'], triggers: [
      { id: 't-rev', type: 'github-event', events: ['pull_request.opened'], labelFilter: 'ready-for-review' },
    ] },
    { id: 'dev', emits: ['ready-for-review'], triggers: [
      // Post-hoc trigger: carries channel:true + sources but the node has NO
      // channels port for this label.
      { id: 't-dev', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'revisions-required', channel: true, sources: ['reviewer'] },
    ] },
    { id: 'verifier', emits: [], triggers: [
      { id: 't-ver', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-to-merge', channel: true, sources: ['reviewer'] },
    ] },
  ]);
  const revToDev = g.edges.find(e => e.from === 'reviewer' && e.to === 'dev' && e.label === 'revisions-required');
  assert.ok(revToDev && !revToDev.deadEnd, 'reviewer→dev over revisions-required is wired');
  const revToVer = g.edges.find(e => e.from === 'reviewer' && e.to === 'verifier' && e.label === 'ready-to-merge');
  assert.ok(revToVer && !revToVer.deadEnd, 'reviewer→verifier over ready-to-merge is wired');
  assert.equal(g.edges.filter(e => e.deadEnd).length, 0, 'no false dead-ends');
});

// #1524 non-regression: a GENUINE derived channel trigger (labelFilter matches a
// channels port) stays excluded from label wiring — its edge is the on:'github'
// port edge drawn in unified-graph, so re-drawing it here would double the edge.
test('#1524: a channel:true listener WITH a backing port stays excluded from label edges', () => {
  const g = buildProcessGraph([
    { id: 'producer', github: { producesPr: true }, emits: [], triggers: [] },
    { id: 'consumer', emits: [],
      channels: [{ artifact: 'pr', from: 'producer', label: 'ready-for-review' }],
      triggers: [
        { id: 'consumer-on-pr-ready-for-review', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review', channel: true, sources: ['producer'] },
      ] },
  ]);
  assert.equal(
    g.edges.filter(e => e.label === 'ready-for-review').length, 0,
    'the derived channel listener draws no label edge here (unified-graph draws the port edge)',
  );
  assert.ok(!g.edges.some(e => e.external), 'no external event edges for the derived listener');
});

test('lint: duplicate-listener flags a manual trigger duplicating a derived channel listener; removing it clears the lint (\#826)', () => {
  const derived = { id: 'rev-on-pr', type: 'github-event', channel: true,
    events: ['pull_request.opened', 'pull_request.reopened'] };
  const manual = { id: 'rev-manual', type: 'github-event',
    events: ['pull_request.reopened', 'pull_request.opened'] }; // same set, different order
  // With the manual duplicate present.
  const dup = buildProcessGraph([
    { id: 'dev', triggers: [], github: { producesPr: true } },
    { id: 'rev', channels: [{ artifact: 'pr', from: 'dev' }], triggers: [derived, manual] },
  ]);
  const l = dup.lints.find(x => x.code === 'duplicate-listener' && x.nodeId === 'rev');
  assert.ok(l, 'duplicate-listener raised');
  assert.equal(l.severity, 'warning');
  assert.deepEqual([...l.triggerIds].sort(), ['rev-manual', 'rev-on-pr']);
  // Deleting the manual trigger clears the lint.
  const clean = buildProcessGraph([
    { id: 'dev', triggers: [], github: { producesPr: true } },
    { id: 'rev', channels: [{ artifact: 'pr', from: 'dev' }], triggers: [derived] },
  ]);
  assert.ok(!clean.lints.some(x => x.code === 'duplicate-listener'));
});

test('lint: duplicate-listener requires matching labelFilter, not just events (\#826)', () => {
  const g = buildProcessGraph([
    { id: 'a', triggers: [
      { id: 't1', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' },
      { id: 't2', type: 'github-event', events: ['issues.labeled'], labelFilter: 'dispatch' },
    ] },
  ]);
  assert.ok(!g.lints.some(x => x.code === 'duplicate-listener'), 'different labels are distinct listeners');
});

test('lint: duplicate-listener does NOT fire on per-upstream data-flow push triggers (\#826)', () => {
  const g = buildProcessGraph([
    { id: 'c', triggers: [
      { id: 'c-on-push-up1', type: 'github-event', dataFlow: true, events: ['push'] },
      { id: 'c-on-push-up2', type: 'github-event', dataFlow: true, events: ['push'] },
    ] },
  ]);
  assert.ok(!g.lints.some(x => x.code === 'duplicate-listener'), 'intentional one-per-upstream listeners');
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

test('channel-label + labelFilter trigger on the same label draws ONE edge, not two (#537)', () => {
  // The Core-SDLC shape: reworker emits `ready-for-review`; code-reviewer both
  // consumes developer's PR channel on that label AND has an explicit
  // `pull_request.labeled` labelFilter trigger for it. The trigger loop already
  // wires reworker→code-reviewer, so the #401 channel back-emitter loop must not
  // draw a second, trigger-less duplicate.
  const g = buildProcessGraph([
    { id: 'developer', triggers: [], github: { producesPr: true } },
    { id: 'reworker', triggers: [], emits: ['ready-for-review'] },
    { id: 'code-reviewer', channels: [{ artifact: 'pr', from: 'developer', label: 'ready-for-review' }], triggers: [
      { id: 't1783952055673966', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review' },
    ] },
  ]);
  const edges = edgesBetween(g, 'reworker', 'code-reviewer').filter(e => e.kind === 'agent');
  assert.equal(edges.length, 1);
  // The surviving edge is the trigger-backed one (carries the triggerId + events),
  // not the trigger-less channel duplicate.
  assert.equal(edges[0].triggerId, 't1783952055673966');
  assert.deepEqual(edges[0].events, ['pull_request.labeled']);
  // The channel back-emitter loop drew nothing trigger-less for this pair.
  assert.ok(!edges.some(e => e.triggerId == null));
});

test('#401 still holds when the same consumer has an unrelated labelFilter trigger (#537 regression guard)', () => {
  // code-reviewer listens on `go` ONLY via a channel (no labelFilter trigger for
  // it), while also carrying a labelFilter trigger for a DIFFERENT label. The
  // #537 guard must be per-label: the `go` feedback edge from a third emitter
  // must still be drawn.
  const g = buildProcessGraph([
    { id: 'intake', triggers: [], github: { producesIssue: true }, emits: ['go'] },
    { id: 'router', triggers: [], emits: ['go'] },
    { id: 'code-reviewer', channels: [{ artifact: 'issue', from: 'intake', label: 'go' }], triggers: [
      { id: 't', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review' },
    ] },
  ]);
  const goEdges = g.edges.filter(e => e.label === 'go' && e.kind === 'agent');
  assert.deepEqual(goEdges.map(e => `${e.from}->${e.to}`).sort(), ['router->code-reviewer']);
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

test('a human-approval gate (downstream waits on a flagged label) renders as a gate and never trips gate-violation', () => {
  // The #346 shape: downstream listens on the gate label; nobody emits it. The
  // label is named as a plain action (#928/#927) — the flag makes it a gate.
  const g = buildProcessGraph([
    { id: 'release', triggers: [
      { id: 'gate', type: 'github-event', events: ['issues.labeled'], labelFilter: 'approved-for-go-live' },
    ] },
  ], { labels: [{ name: 'approved-for-go-live', humanGate: true, brake: false }] });
  const gateEdge = g.edges.find(e => e.label === 'approved-for-go-live');
  assert.equal(gateEdge.kind, 'gate');
  assert.equal(gateEdge.from, null);
  assert.deepEqual(g.gates, [{ label: 'approved-for-go-live', humanOnly: true }]);
  assert.ok(!g.lints.some(l => l.code === 'gate-violation'));
  // and it is NOT an orphan-listener (gates are external, not orphans)
  assert.ok(!g.lints.some(l => l.code === 'orphan-listener'));
});

// #928 edge case — a label that is BOTH listened-for and flagged humanGate keeps
// its human-origin edge; the agent that also emits it does not get an agent edge.
test('a listened-for label flagged humanGate keeps the human-origin edge', () => {
  const g = buildProcessGraph([
    { id: 'rogue', emits: ['approved-for-go-live'], triggers: [] },
    { id: 'release', triggers: [{ id: 'g', type: 'github-event', events: ['issues.labeled'], labelFilter: 'approved-for-go-live' }] },
  ], { labels: [{ name: 'approved-for-go-live', humanGate: true, brake: false }] });
  const edges = g.edges.filter(e => e.label === 'approved-for-go-live');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, null);
  assert.equal(edges[0].kind, 'gate');
  assert.ok(!g.edges.some(e => e.from === 'rogue' && e.label === 'approved-for-go-live'));
});


test('node view exposes the expected fields', () => {
  const g = buildProcessGraph([{
    id: 'dev', role: 'team-member', displayName: 'Developer', sessionPolicy: 'per-invocation',
    environmentId: 'team-x', emits: ['started:dev'],
    triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'],
      labelFilter: 'assigned:dev' }],
  }]);
  const n = g.nodes[0];
  assert.equal(n.role, 'team-member');
  assert.equal(n.displayName, 'Developer');
  assert.equal(n.sessionPolicy, 'per-invocation');
  assert.equal(n.environmentId, 'team-x');
  // Agent-level emits carry the label hand-offs (#414/#783).
  assert.deepEqual(n.emits, ['started:dev']);
  const t = n.triggers[0];
  assert.deepEqual(t.events, ['issues.labeled']);
  assert.ok(!('from' in t), 'origin filter removed from the trigger view');
  assert.equal(t.labelFilter, 'assigned:dev');
  // Trigger view no longer carries emits (#783).
  assert.ok(!('emits' in t));
});

test('trigger-level emits are ignored — only agent-level emits wire edges (#783)', () => {
  // A legacy trigger still carrying `emits` must NOT produce a hand-off edge; the
  // agent-level emit is the sole source. Proves AC4 (t.emits is no longer read).
  const g = buildProcessGraph([
    { id: 'a', triggers: [{ id: 't', type: 'github-event', events: ['x'], emits: ['legacy'] }] },
    { id: 'b', triggers: [{ id: 't2', type: 'github-event', labelFilter: 'legacy' }] },
  ]);
  assert.equal(edgesBetween(g, 'a', 'b').length, 0, 'no edge from a trigger-level emit');
  // The listener is a plain orphan (nobody emits the label at the agent level).
  assert.ok(g.lints.some(l => l.code === 'orphan-listener' && l.nodeId === 'b'));
  // …and there is no dead-end-emitter lint for the ignored trigger emit.
  assert.ok(!g.lints.some(l => l.code === 'dead-end-emitter'));
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

// ─── outcome-port lints (#830, agent-outcomes concept §8) ────────────────────

// A downstream agent that listens on `label` via a labelFilter trigger — used to
// give an outcome edge a consumer so a lint clears when "fixed".
const outcomeListener = (id, label) => ({
  id, role: 'agent',
  triggers: [{ id: `${id}-t`, type: 'github-event', events: ['issues.labeled'], labelFilter: label }],
});
// A dispatcher-style node carrying an authored outcomes port and no triggers.
const withOutcomes = (id, mode, options) => ({ id, role: 'agent', triggers: [], outcomes: { mode, options } });

test('lint: outcome-without-consumer fires (warning) and clears when a listener exists', () => {
  const emitter = withOutcomes('reviewer', 'exactlyOne', [
    { id: 'accept', actions: [{ type: 'setLabel', label: 'ready-to-merge' }] },
    { id: 'reject', actions: [{ type: 'setLabel', label: 'revisions-required' }] },
  ]);
  // Nobody listens on either label → two outcome-without-consumer lints, and NO
  // dead-end-emitter (that legacy code must not double-report an outcome edge).
  const orphaned = buildProcessGraph([emitter]);
  const owc = orphaned.lints.filter(l => l.code === 'outcome-without-consumer');
  assert.equal(owc.length, 2);
  assert.ok(owc.every(l => l.severity === 'warning' && l.nodeId === 'reviewer' && l.outcome));
  assert.ok(!orphaned.lints.some(l => l.code === 'dead-end-emitter'),
    'an outcome dead-end is reported as outcome-without-consumer, not dead-end-emitter');

  // Wire a consumer for each label → the lint clears.
  const wired = buildProcessGraph([
    emitter, outcomeListener('merger', 'ready-to-merge'), outcomeListener('reworker', 'revisions-required'),
  ]);
  assert.ok(!wired.lints.some(l => l.code === 'outcome-without-consumer'));
});

test('lint: outcome-without-consumer exempts `none` (terminal-by-design) actions', () => {
  const g = buildProcessGraph([
    withOutcomes('closer', 'anyOf', [{ id: 'done', title: 'Closed', actions: [{ type: 'none' }] }]),
  ]);
  assert.ok(!g.lints.some(l => l.code === 'outcome-without-consumer'));
  assert.ok(!g.lints.some(l => l.code === 'dead-end-emitter'));
});

test('AC2: an outcome label consumed via a human-gated channel is not a false outcome-without-consumer / orphan pair', () => {
  // `author` sets `needs-review` from an outcome; `qa` consumes it through a
  // human-gated PR channel (a human applies the label). The channel makes `qa` a
  // label listener on `needs-review`, so the emit has a consumer and the listener
  // has an emitter — neither lint may fire.
  const g = buildProcessGraph([
    withOutcomes('author', 'anyOf', [{ id: 'to-review', actions: [{ type: 'setLabel', label: 'needs-review' }] }]),
    { id: 'qa', role: 'agent', triggers: [],
      channels: [{ artifact: 'pr', from: 'author', label: 'needs-review', gate: 'human' }] },
  ]);
  assert.ok(!g.lints.some(l => l.code === 'outcome-without-consumer'),
    'the human-gated channel consumes the outcome label');
  assert.ok(!g.lints.some(l => l.code === 'orphan-listener'),
    'the outcome emitter satisfies the channel listener');
  // The label registers as a listen key (that is what suppresses both lints); the
  // author→qa edge itself is the on:'github' port edge, drawn in unified-graph.
  assert.ok(g.labels.some(l => l.name === 'needs-review'));
});

test('lint: switch-with-one-option fires (info) for exactlyOne with <2 options and clears at two', () => {
  const one = buildProcessGraph([
    withOutcomes('gate', 'exactlyOne', [{ id: 'only', actions: [{ type: 'setLabel', label: 'go' }] }]),
    outcomeListener('next', 'go'),
  ]);
  const swo = one.lints.find(l => l.code === 'switch-with-one-option');
  assert.ok(swo && swo.severity === 'info' && swo.nodeId === 'gate');

  const two = buildProcessGraph([
    withOutcomes('gate', 'exactlyOne', [
      { id: 'a', actions: [{ type: 'setLabel', label: 'go' }] },
      { id: 'b', actions: [{ type: 'setLabel', label: 'stop' }] },
    ]),
    outcomeListener('next', 'go'), outcomeListener('halt', 'stop'),
  ]);
  assert.ok(!two.lints.some(l => l.code === 'switch-with-one-option'));
});

test('lint: switch-with-one-option does NOT fire for an anyOf with one option', () => {
  const g = buildProcessGraph([
    withOutcomes('emit', 'anyOf', [{ id: 'only', actions: [{ type: 'setLabel', label: 'go' }] }]),
    outcomeListener('next', 'go'),
  ]);
  assert.ok(!g.lints.some(l => l.code === 'switch-with-one-option'));
});

test('lint: same-label-multiple-outcomes fires (warning) under exactlyOne when two options set one label', () => {
  const dup = buildProcessGraph([
    withOutcomes('router', 'exactlyOne', [
      { id: 'path-a', actions: [{ type: 'setLabel', label: 'ready' }] },
      { id: 'path-b', actions: [{ type: 'setLabel', label: 'ready' }] },
    ]),
    outcomeListener('dev', 'ready'),
  ]);
  const slm = dup.lints.find(l => l.code === 'same-label-multiple-outcomes');
  assert.ok(slm && slm.severity === 'warning' && slm.nodeId === 'router' && slm.label === 'ready');

  // Distinct labels per branch → cleared.
  const distinct = buildProcessGraph([
    withOutcomes('router', 'exactlyOne', [
      { id: 'path-a', actions: [{ type: 'setLabel', label: 'ready' }] },
      { id: 'path-b', actions: [{ type: 'setLabel', label: 'hold-off' }] },
    ]),
    outcomeListener('dev', 'ready'), outcomeListener('wait', 'hold-off'),
  ]);
  assert.ok(!distinct.lints.some(l => l.code === 'same-label-multiple-outcomes'));
});

test('lint: same-label-multiple-outcomes does NOT fire under anyOf (both branches may run)', () => {
  const g = buildProcessGraph([
    withOutcomes('multi', 'anyOf', [
      { id: 'a', actions: [{ type: 'setLabel', label: 'ping' }] },
      { id: 'b', actions: [{ type: 'setLabel', label: 'ping' }] },
    ]),
    outcomeListener('rx', 'ping'),
  ]);
  assert.ok(!g.lints.some(l => l.code === 'same-label-multiple-outcomes'));
});

test('lint: human-label-as-outcome fires (error) for a FLAGGED gate outcome label', () => {
  const human = buildProcessGraph([
    withOutcomes('rogue', 'anyOf', [{ id: 'approve', actions: [{ type: 'setLabel', label: 'approved-for-dispatch' }] }]),
  ], { labels: [{ name: 'approved-for-dispatch', humanGate: true, brake: false }] });
  const hlo = human.lints.find(l => l.code === 'human-label-as-outcome');
  assert.ok(hlo && hlo.severity === 'error' && hlo.nodeId === 'rogue' && hlo.label === 'approved-for-dispatch' && hlo.outcome === 'approve');
  // The gate label is filtered out of the emit index, so gate-violation must not
  // also fire (human-label-as-outcome is its outcome-port successor).
  assert.ok(!human.lints.some(l => l.code === 'gate-violation'));

  // #928 AC3 — a BRAKE outcome is legitimate (the reworker pausing the loop) and
  // must NOT fire human-label-as-outcome any more.
  const brake = buildProcessGraph([
    withOutcomes('rogue', 'anyOf', [{ id: 'pause', actions: [{ type: 'setLabel', label: 'human-decision-required' }] }]),
  ], { labels: [{ name: 'human-decision-required', humanGate: false, brake: true }] });
  assert.ok(!brake.lints.some(l => l.code === 'human-label-as-outcome'));
  assert.ok(!brake.lints.some(l => l.code === 'gate-violation'));

  // A clean, non-gate outcome label → no human-label-as-outcome.
  const clean = buildProcessGraph([
    withOutcomes('ok', 'anyOf', [{ id: 'go', actions: [{ type: 'setLabel', label: 'ready' }] }]),
    outcomeListener('next', 'ready'),
  ]);
  assert.ok(!clean.lints.some(l => l.code === 'human-label-as-outcome'));
});

test('AC3: a legacy flat-emits agent produces the identical lint set (no outcome-port lints)', () => {
  const legacy = buildProcessGraph([
    { id: 'a', role: 'agent', emits: ['stage:done'], triggers: [] },
  ]);
  // Unchanged: a flat emit nobody listens on is still a dead-end-emitter …
  assert.ok(legacy.lints.some(l => l.code === 'dead-end-emitter' && l.nodeId === 'a'));
  // … and none of the new outcome-port lints appear for a legacy agent.
  for (const code of ['outcome-without-consumer', 'switch-with-one-option', 'same-label-multiple-outcomes', 'human-label-as-outcome']) {
    assert.ok(!legacy.lints.some(l => l.code === code), `legacy flow must not emit ${code}`);
  }
});

// --- loop trigger normalisation (#932) -------------------------------------

test('triggerView: loop trigger carries its stop-contract summary', () => {
  const g = buildProcessGraph([
    {
      id: 'dev', role: 'agent', triggers: [{
        id: 'drain', type: 'loop', enabled: true,
        until: { command: 'npm test', env: { CI: '1' } },
        maxIterations: 25, minGapSeconds: 5,
        // fields the graph view must NOT surface:
        prompt: 'do the thing', roomId: '!r:local',
      }],
    },
  ]);
  const t = g.nodes[0].triggers[0];
  assert.equal(t.type, 'loop');
  assert.equal(t.maxIterations, 25);
  assert.equal(t.minGapSeconds, 5);
  assert.deepEqual(t.until, { command: 'npm test' }); // env/prompt/roomId not leaked
  assert.ok(!('prompt' in t) && !('roomId' in t) && !('env' in t));
});

test('triggerView: loop carries the verifier shape but never the command/env (#933)', () => {
  const gCmd = buildProcessGraph([
    { id: 'dev', role: 'agent', triggers: [{
      id: 'l', type: 'loop', maxIterations: 5,
      verify: { command: 'npm run lint', env: { CI: '1' } },
    }] },
  ]);
  assert.deepEqual(gCmd.nodes[0].triggers[0].verify, { mode: 'command' });

  const gAgent = buildProcessGraph([
    { id: 'dev', role: 'agent', triggers: [{
      id: 'l', type: 'loop', maxIterations: 5, verify: { agentId: 'team-x-reviewer' },
    }] },
  ]);
  assert.deepEqual(gAgent.nodes[0].triggers[0].verify,
    { mode: 'agent', agentId: 'team-x-reviewer' });

  const gFlow = buildProcessGraph([
    { id: 'dev', role: 'agent', triggers: [{
      id: 'l', type: 'loop', maxIterations: 5, verify: { flow: true },
    }] },
  ]);
  assert.deepEqual(gFlow.nodes[0].triggers[0].verify, { mode: 'flow' });

  const gNone = buildProcessGraph([
    { id: 'dev', role: 'agent', triggers: [{ id: 'l', type: 'loop', maxIterations: 5 }] },
  ]);
  assert.ok(!('verify' in gNone.nodes[0].triggers[0]));
});

test('triggerView: loop without an until command omits the until summary', () => {
  const g = buildProcessGraph([
    { id: 'dev', role: 'agent', triggers: [{ id: 'l', type: 'loop', maxIterations: 3 }] },
  ]);
  const t = g.nodes[0].triggers[0];
  assert.equal(t.maxIterations, 3);
  assert.ok(!('until' in t));
  assert.ok(!('minGapSeconds' in t));
});

test('a loop trigger emits a kind:loop self-edge carrying its stop-contract summary (#936)', () => {
  const g = buildProcessGraph([
    { id: 'dev', role: 'agent', triggers: [{
      id: 'l', type: 'loop', maxIterations: 25, maxTokens: 2000000,
      until: { command: 'npm test', env: { CI: '1' } },
      verify: { agentId: 'team-x-reviewer' },
      prompt: 'work it', roomId: '!r:local',
    }] },
  ]);
  // One self-edge (like a cron timer) but a distinct kind so the canvas can
  // draw the stop-contract badge instead of a schedule row.
  assert.equal(g.edges.length, 1);
  const e = g.edges[0];
  assert.equal(e.kind, 'loop');
  assert.equal(e.from, 'dev');
  assert.equal(e.to, 'dev');
  assert.equal(e.triggerId, 'l');
  // The render-ready summary carries budget / until / verifier — and nothing
  // secret (the command string / env were already redacted by triggerView).
  assert.deepEqual(e.loop, {
    maxIterations: 25,
    maxTokens: 2000000,
    until: { command: 'npm test' },
    verify: { mode: 'agent', agentId: 'team-x-reviewer' },
  });
  // No orphan/dead-end noise from a self-edge.
  assert.equal(g.lints.length, 0);
});

test('a loop trigger self-edge omits absent stop-contract fields (#936)', () => {
  const g = buildProcessGraph([
    { id: 'dev', role: 'agent', triggers: [{ id: 'l', type: 'loop', maxIterations: 5 }] },
  ]);
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0].loop, { maxIterations: 5 });
  assert.equal(g.lints.length, 0);
});

// ─── unclaimed-listener (#958, concept §3.5) ──────────────────────────────────

test('lint: unclaimed-listener fires (info) for a label listener without a claim', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['ready'], triggers: [] },
    { id: 'b', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' }] },
  ]);
  const l = g.lints.find(x => x.code === 'unclaimed-listener');
  assert.ok(l, 'expected an unclaimed-listener lint');
  assert.equal(l.severity, 'info');   // ADVISORY — must never block a shipped bundle
  assert.equal(l.nodeId, 'b');
  assert.equal(l.label, 'ready');
  assert.deepEqual(l.triggerIds, ['t']);
});

test('lint: unclaimed-listener stays silent once the listener carries its claim', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['ready'], triggers: [] },
    { id: 'b', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready',
      claim: { remove: 'ready', add: 'ready:wip' } }] },
  ]);
  assert.ok(!g.lints.some(x => x.code === 'unclaimed-listener'));
});

test('lint: unclaimed-listener ignores raw event and claim-label listeners', () => {
  const g = buildProcessGraph([
    // No labelFilter → nothing to claim.
    { id: 'a', triggers: [{ id: 't1', type: 'github-event', events: ['push'] }] },
    // Listening on a claim label → claiming it would derive `ready:wip:wip`.
    { id: 'b', triggers: [{ id: 't2', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready:wip' }] },
    // Not a github-event trigger at all.
    { id: 'c', triggers: [{ id: 't3', type: 'cron', cron: '0 3 * * *' }] },
  ]);
  assert.ok(!g.lints.some(x => x.code === 'unclaimed-listener'));
});

test('#958: a claim rides on the listener edge and on the node trigger port', () => {
  const claim = { remove: 'ready', add: 'ready:wip' };
  const g = buildProcessGraph([
    { id: 'a', emits: ['ready'], triggers: [] },
    { id: 'b', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready', claim }] },
  ]);
  const e = g.edges.find(x => x.label === 'ready' && x.to === 'b');
  assert.deepEqual(e.claim, claim, 'the listener edge carries the claim (canvas badge)');
  const port = g.nodes.find(n => n.id === 'b').triggers.find(t => t.id === 't');
  assert.deepEqual(port.claim, claim, 'the node trigger port carries the claim (Routing readout)');
});

test('#958: a gate listener also carries its claim on the human-sourced edge', () => {
  // `ready` is the canonical case: a HUMAN applies it, the agent claims it.
  const claim = { remove: 'ready', add: 'ready:wip' };
  const g = buildProcessGraph([
    { id: 'dev', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready', claim }] },
  ], { labels: [{ name: 'ready', humanGate: true }] });
  const e = g.edges.find(x => x.label === 'ready' && x.to === 'dev');
  assert.equal(e.kind, 'gate');
  assert.equal(e.from, null);          // comes from outside (a human)
  assert.deepEqual(e.claim, claim);
});

test('#958: a malformed claim is not surfaced on the graph', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['ready'], triggers: [] },
    { id: 'b', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready',
      claim: { remove: 'ready' } }] },  // no `add`
  ]);
  const e = g.edges.find(x => x.label === 'ready' && x.to === 'b');
  assert.equal(e.claim, undefined);
  // ...and it still counts as unclaimed, so the blind spot stays visible.
  assert.ok(g.lints.some(x => x.code === 'unclaimed-listener' && x.nodeId === 'b'));
});

// ── #981: explicit human touchpoints ─────────────────────────────────────────

test('#981: flagging a listened-but-unemitted label humanGate clears orphan-listener and draws the gate edge', () => {
  const mk = (labels) => buildProcessGraph([
    { id: 'dev3', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready-3' }] },
  ], labels ? { labels } : undefined);
  const before = mk(null);
  assert.ok(lintCodes(before).includes('orphan-listener'));
  const after = mk([{ name: 'ready-3', humanGate: true }]);
  assert.ok(!lintCodes(after).includes('orphan-listener'));
  const e = after.edges.find(x => x.label === 'ready-3' && x.to === 'dev3');
  assert.equal(e.kind, 'gate');
  assert.equal(e.from, null); // a human applies it — unified-graph pins it to @human
});

test('#981: a brake emit becomes a hand-off edge instead of a dropped dead-end (no lint)', () => {
  const mk = (labels) => buildProcessGraph([
    { id: 'reworker', emits: ['human-decision-needed'], triggers: [] },
  ], labels ? { labels } : undefined);
  const before = mk(null);
  assert.ok(lintCodes(before).includes('dead-end-emitter'));
  const after = mk([{ name: 'human-decision-needed', brake: true }]);
  assert.ok(!lintCodes(after).includes('dead-end-emitter'));
  assert.ok(!lintCodes(after).includes('outcome-without-consumer'));
  const e = after.edges.find(x => x.label === 'human-decision-needed' && x.from === 'reworker');
  assert.ok(e, 'the emit is VISIBLE as a hand-off, not dropped (pre-#981 regression)');
  assert.equal(e.kind, 'brake');
  assert.equal(e.handoff, 'human');
  assert.equal(e.to, null);
  assert.ok(!e.deadEnd);
});

test('#981: an OUTCOME setting a brake label hands off with its outcome id (no outcome-without-consumer)', () => {
  const g = buildProcessGraph([
    { id: 'dev', triggers: [], outcomes: { mode: 'exactlyOne', options: [
      { id: 'done', title: 'Done', actions: [{ type: 'setLabel', label: 'ready-for-test' }] },
      { id: 'blocked', title: 'Blocked', actions: [{ type: 'setLabel', label: 'human-decision-required' }] },
    ] } },
    { id: 'qa', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready-for-test' }] },
  ], { labels: [{ name: 'human-decision-required', brake: true }] });
  assert.ok(!lintCodes(g).some(c => c === 'outcome-without-consumer'));
  const e = g.edges.find(x => x.label === 'human-decision-required' && x.from === 'dev');
  assert.equal(e.kind, 'brake');
  assert.equal(e.handoff, 'human');
  assert.equal(e.outcome, 'blocked');
});

test('#981: a brake emit hands off to the human even when another agent re-listens on the label', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['needs-decision'], triggers: [] },
    { id: 'b', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'needs-decision' }] },
  ], { labels: [{ name: 'needs-decision', brake: true }] });
  // Emit side: a → human. Listen side: human (null) → b. The human sits in between.
  assert.ok(g.edges.some(e => e.from === 'a' && e.handoff === 'human' && e.label === 'needs-decision'));
  assert.ok(g.edges.some(e => e.from === null && e.to === 'b' && e.kind === 'brake' && e.label === 'needs-decision'));
});

test('#981: prAudience human clears producer-unconsumed and draws the delivery edge; unset lints as before', () => {
  const before = buildProcessGraph([
    { id: 'dev', github: { producesPr: true }, triggers: [] },
  ]);
  assert.ok(lintCodes(before).includes('producer-unconsumed'));
  const after = buildProcessGraph([
    { id: 'dev', github: { producesPr: true, prAudience: 'human' }, triggers: [] },
  ]);
  assert.ok(!lintCodes(after).includes('producer-unconsumed'));
  const e = after.edges.find(x => x.kind === 'delivery' && x.from === 'dev');
  assert.equal(e.artifact, 'pr');
  assert.equal(e.handoff, 'human');
  // The audience flag rides on the node's github port (round-trip via export).
  assert.equal(after.nodes[0].github.prAudience, 'human');
});

test('#981: issueAudience is independent of prAudience', () => {
  const g = buildProcessGraph([
    { id: 'triage', github: { producesPr: true, producesIssue: true, issueAudience: 'human' }, triggers: [] },
  ]);
  const deliveries = g.edges.filter(x => x.kind === 'delivery');
  assert.deepEqual(deliveries.map(d => d.artifact), ['issue']);
  // The PR side still lints — only the issue side declared a human consumer.
  assert.ok(g.lints.some(l => l.code === 'producer-unconsumed' && /pull requests/.test(l.message)));
});

test('#981: gate-violation still fires when an agent declares an emit of a humanGate label', () => {
  const g = buildProcessGraph([
    { id: 'rogue', emits: ['ready-3'], triggers: [] },
  ], { labels: [{ name: 'ready-3', humanGate: true }] });
  assert.ok(g.lints.some(l => l.code === 'gate-violation' && l.nodeId === 'rogue'));
});

test('#981: humanTouchpoints enumerates injection / decision / delivery; empty without flags', () => {
  const g = buildProcessGraph([
    { id: 'dev3', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready-3' }] },
    { id: 'reworker', emits: ['human-decision-needed'], triggers: [] },
    { id: 'merger', github: { producesPr: true, prAudience: 'human' }, triggers: [] },
    { id: 'dispatcher', channels: [{ artifact: 'issue', from: 'analyst', label: 'dispatch', gate: 'human' }], triggers: [] },
    { id: 'analyst', github: { producesIssue: true }, triggers: [] },
  ], { labels: [
    { name: 'ready-3', humanGate: true },
    { name: 'human-decision-needed', brake: true },
  ] });
  assert.deepEqual(g.humanTouchpoints, [
    { type: 'injection', agentId: 'dispatcher', label: 'dispatch', artifact: 'issue' },
    { type: 'injection', label: 'ready-3', agentId: 'dev3' },
    { type: 'decision', label: 'human-decision-needed', agentId: 'reworker' },
    { type: 'delivery', artifact: 'pr', agentId: 'merger' },
  ]);

  const none = buildProcessGraph([
    { id: 'a', emits: ['ready'], triggers: [] },
    { id: 'b', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' }] },
  ]);
  assert.deepEqual(none.humanTouchpoints, []);
});

test('#981: one label listened by two triggers yields ONE injection touchpoint', () => {
  const g = buildProcessGraph([
    { id: 'dev', triggers: [
      { id: 't1', type: 'github-event', events: ['issues.labeled'], labelFilter: 'go' },
      { id: 't2', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'go' },
    ] },
  ], { labels: [{ name: 'go', humanGate: true }] });
  assert.equal(g.humanTouchpoints.filter(t => t.type === 'injection').length, 1);
});

// ── #987: named human roles as first-class flow nodes ────────────────────────

test('#987: a human role synthesizes a kind:human node, no triggers/session', () => {
  const g = buildProcessGraph([
    { id: 'dev', triggers: [] },
  ], { humans: [{ id: 'reviewer', name: 'Issue Reviewer', description: 'reviews issues', stage: 'triage' }] });
  const hn = g.nodes.find(n => n.id === 'reviewer');
  assert.ok(hn, 'human node present');
  assert.equal(hn.kind, 'human');
  assert.equal(hn.role, 'human');
  assert.equal(hn.displayName, 'Issue Reviewer');
  assert.equal(hn.stage, 'triage');
  assert.deepEqual(hn.triggers, []);
  assert.equal(hn.sessionPolicy, null);
  assert.equal(hn.synthetic, true);
});

test('#987 AC2: a gate label emitted by a human draws humanId → listener; classifies as gate with NO registry flag', () => {
  const g = buildProcessGraph([
    { id: 'dispatcher', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'dispatch' }] },
  ], { humans: [{ id: 'reviewer', name: 'Issue Reviewer', emits: ['dispatch'] }] });
  // No `labels` registry at all — the human's emit alone makes `dispatch` a gate.
  const e = g.edges.find(x => x.label === 'dispatch' && x.to === 'dispatcher');
  assert.ok(e, 'edge present');
  assert.equal(e.kind, 'gate');
  assert.equal(e.from, 'reviewer'); // bound to the named human, not null/@human
  assert.ok(!lintCodes(g).includes('orphan-listener'));
});

test('#987 AC2: registry-flag gate path is unchanged (no human emits it → from null)', () => {
  const g = buildProcessGraph([
    { id: 'dispatcher', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'approved' }] },
  ], { labels: [{ name: 'approved', humanGate: true }], humans: [{ id: 'reviewer', name: 'R', emits: ['other'] }] });
  const e = g.edges.find(x => x.label === 'approved' && x.to === 'dispatcher');
  assert.equal(e.kind, 'gate');
  assert.equal(e.from, null);
});

test('#987 AC3: a brake consumed by a human draws emitter → humanId; unbound brakes keep null', () => {
  const bound = buildProcessGraph([
    { id: 'reworker', emits: ['needs-decision'], triggers: [] },
  ], {
    labels: [{ name: 'needs-decision', brake: true }],
    humans: [{ id: 'lead', name: 'Tech Lead', consumes: [{ label: 'needs-decision' }] }],
  });
  const be = bound.edges.find(x => x.label === 'needs-decision' && x.from === 'reworker');
  assert.equal(be.kind, 'brake');
  assert.equal(be.handoff, 'human');
  assert.equal(be.to, 'lead');

  const unbound = buildProcessGraph([
    { id: 'reworker', emits: ['needs-decision'], triggers: [] },
  ], { labels: [{ name: 'needs-decision', brake: true }] });
  const ue = unbound.edges.find(x => x.label === 'needs-decision' && x.from === 'reworker');
  assert.equal(ue.to, null); // generic @human
});

test('#987 AC4: Issue-Reviewer scenario renders BA → Issue Reviewer → Dispatcher, no @human', () => {
  const g = buildProcessGraph([
    { id: 'ba', github: { producesIssue: true }, triggers: [] },
    { id: 'dispatcher', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'dispatch' }] },
  ], {
    humans: [{
      id: 'issue-reviewer', name: 'Issue Reviewer',
      emits: ['dispatch'],
      consumes: [{ artifact: 'issue', from: 'ba' }],
    }],
  });
  // BA → Issue Reviewer (delivery of the issue).
  const delivery = g.edges.find(e => e.kind === 'delivery' && e.from === 'ba');
  assert.ok(delivery, 'delivery edge present');
  assert.equal(delivery.to, 'issue-reviewer');
  assert.equal(delivery.artifact, 'issue');
  // Issue Reviewer → Dispatcher (the dispatch gate).
  const gate = g.edges.find(e => e.kind === 'gate' && e.label === 'dispatch');
  assert.equal(gate.from, 'issue-reviewer');
  assert.equal(gate.to, 'dispatcher');
  // No producer-unconsumed for the BA's issue (the human consumes it).
  assert.ok(!lintCodes(g).includes('producer-unconsumed'));
  // No generic @human anywhere in this process graph (all edges named).
  assert.ok(!g.edges.some(e => e.from === null && e.kind === 'gate'));
});

test('#987 AC5: a PR bound to a human suppresses producer-unconsumed and draws the delivery', () => {
  const g = buildProcessGraph([
    { id: 'dev', github: { producesPr: true }, triggers: [] },
  ], { humans: [{ id: 'maintainer', name: 'Maintainer', consumes: [{ artifact: 'pr', from: 'dev' }] }] });
  assert.ok(!lintCodes(g).includes('producer-unconsumed'));
  const e = g.edges.find(x => x.kind === 'delivery' && x.from === 'dev');
  assert.equal(e.to, 'maintainer');
  assert.equal(e.artifact, 'pr');
});

test('#1003: produces* projection — an outcome-only producer graphs identically to a consistent flag-carrier', () => {
  const outcomes = { mode: 'anyOf', options: [{ id: 'opens-pr', title: 'Opens PR', actions: [{ type: 'openPr' }] }] };
  const consumer = { id: 'qa', triggers: [], channels: [{ artifact: 'pr', from: 'dev' }] };
  // Outcome only (what the #1003 engine writes) vs. outcome + legacy flag
  // (an already-consistent agent): node.github, edges and lints must agree.
  const outcomeOnly = buildProcessGraph([{ id: 'dev', outcomes, triggers: [] }, consumer], {});
  const withFlag = buildProcessGraph([{ id: 'dev', outcomes, github: { producesPr: true }, triggers: [] }, consumer], {});
  const devA = outcomeOnly.nodes.find(n => n.id === 'dev');
  const devB = withFlag.nodes.find(n => n.id === 'dev');
  assert.deepEqual(devA.github, { producesPr: true });
  assert.deepEqual(devA.github, devB.github);
  assert.deepEqual(outcomeOnly.edges, withFlag.edges);
  assert.deepEqual(outcomeOnly.lints, withFlag.lints);
});

test('#1001 (D4): an outcomes-authored openIssue reviewed by a bound human raises no consumer lint', () => {
  // The concept §1 D4 repro, via the outcomes port (not raw github flags): BA's
  // outcome opens an issue, a named human role reviews it. The reviewer IS the
  // consumer — the graph must draw the delivery and raise neither
  // producer-unconsumed nor outcome-without-consumer.
  const roles = [
    { id: 'ba', outcomes: { mode: 'anyOf', options: [{ id: 'ticket', title: 'Opens issue', actions: [{ type: 'openIssue' }] }] }, triggers: [] },
    { id: 'dev', triggers: [] },
  ];
  const withHuman = buildProcessGraph(roles, {
    humans: [{ id: 'ba-human', name: 'BA Human', consumes: [{ artifact: 'issue', from: 'ba' }] }],
  });
  assert.ok(!lintCodes(withHuman).includes('producer-unconsumed'));
  assert.ok(!lintCodes(withHuman).includes('outcome-without-consumer'));
  const e = withHuman.edges.find(x => x.kind === 'delivery' && x.from === 'ba');
  assert.equal(e.to, 'ba-human');
  assert.equal(e.artifact, 'issue');
  // Without the binding the advisory smell fires — the suppression is the
  // reviewer, not the outcome shape.
  const withoutHuman = buildProcessGraph(roles, { humans: [{ id: 'ba-human', name: 'BA Human' }] });
  assert.ok(lintCodes(withoutHuman).includes('producer-unconsumed'));
});

test('#987 AC6: gate-violation fires when an agent emits a human-emitted label', () => {
  const g = buildProcessGraph([
    { id: 'rogue', emits: ['dispatch'], triggers: [] },
  ], { humans: [{ id: 'reviewer', name: 'R', emits: ['dispatch'] }] });
  assert.ok(g.lints.some(l => l.code === 'gate-violation' && l.nodeId === 'rogue' && l.label === 'dispatch'));
});

test('#987 AC7: humanTouchpoints carry role when bound', () => {
  const g = buildProcessGraph([
    { id: 'ba', github: { producesIssue: true }, triggers: [] },
    { id: 'dispatcher', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'dispatch' }] },
    { id: 'reworker', emits: ['needs-decision'], triggers: [] },
    { id: 'dev', github: { producesPr: true }, triggers: [] },
  ], {
    labels: [{ name: 'needs-decision', brake: true }],
    humans: [{
      id: 'reviewer', name: 'Issue Reviewer',
      emits: ['dispatch'],
      consumes: [{ artifact: 'issue', from: 'ba' }, { label: 'needs-decision' }, { artifact: 'pr', from: 'dev' }],
    }],
  });
  const injection = g.humanTouchpoints.find(t => t.type === 'injection' && t.label === 'dispatch');
  assert.equal(injection.role, 'reviewer');
  const decision = g.humanTouchpoints.find(t => t.type === 'decision');
  assert.equal(decision.role, 'reviewer');
  const deliveries = g.humanTouchpoints.filter(t => t.type === 'delivery');
  assert.ok(deliveries.every(d => d.role === 'reviewer'));
});

test('#987: a label emitted by two humans yields two gate edges + two injection touchpoints', () => {
  const g = buildProcessGraph([
    { id: 'dispatcher', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'go' }] },
  ], { humans: [
    { id: 'lead-a', name: 'Lead A', emits: ['go'] },
    { id: 'lead-b', name: 'Lead B', emits: ['go'] },
  ] });
  const gates = g.edges.filter(e => e.kind === 'gate' && e.label === 'go');
  assert.deepEqual(gates.map(e => e.from).sort(), ['lead-a', 'lead-b']);
  assert.equal(g.humanTouchpoints.filter(t => t.type === 'injection').length, 2);
});

test('#987: first matching human in humans[] order wins for a consumed artifact', () => {
  const g = buildProcessGraph([
    { id: 'dev', github: { producesPr: true }, triggers: [] },
  ], { humans: [
    { id: 'first', name: 'First', consumes: [{ artifact: 'pr', from: 'dev' }] },
    { id: 'second', name: 'Second', consumes: [{ artifact: 'pr', from: 'dev' }] },
  ] });
  const deliveries = g.edges.filter(e => e.kind === 'delivery' && e.from === 'dev');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].to, 'first');
});

test('#987 AC8: a flow with no humans[] is byte-identical to omitting the option', () => {
  const agents = [
    { id: 'ba', github: { producesIssue: true }, triggers: [] },
    { id: 'dev', emits: ['ready'], triggers: [] },
    { id: 'qa', triggers: [{ id: 't', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' }] },
  ];
  const opts = { labels: [{ name: 'ready', humanGate: false }] };
  const withEmpty = buildProcessGraph(agents, { ...opts, humans: [] });
  const without = buildProcessGraph(agents, opts);
  assert.deepEqual(withEmpty, without);
});

test('#1004: a marked outcome is an endpoint, not a dead-end — no lint, endpoint edge', () => {
  const mk = (extra) => buildProcessGraph([
    { id: 'dev', triggers: [], outcomes: { mode: 'anyOf', options: [
      { id: 'done', title: 'Done', actions: [{ type: 'setLabel', label: 'archived' }], ...extra },
    ] } },
  ], {});
  // Unmarked: the dead-end warning fires (outcome-without-consumer, #830).
  const open = mk({});
  assert.ok(lintCodes(open).includes('outcome-without-consumer'));
  assert.ok(open.edges.some(e => e.label === 'archived' && e.deadEnd));
  // Terminal: a proper endpoint — edge carries `endpoint`, no lint.
  const term = mk({ terminal: true });
  assert.ok(!lintCodes(term).includes('outcome-without-consumer'));
  const te = term.edges.find(e => e.label === 'archived');
  assert.equal(te.endpoint, 'terminal');
  assert.ok(!te.deadEnd);
  // External with note: endpoint + note forwarded for the port chip.
  const ext = mk({ external: { note: 'state marker for the org board' } });
  assert.ok(!lintCodes(ext).includes('outcome-without-consumer'));
  const ee = ext.edges.find(e => e.label === 'archived');
  assert.equal(ee.endpoint, 'external');
  assert.equal(ee.note, 'state marker for the org board');
});

test('#1004: a marked artifact outcome suppresses producer-unconsumed', () => {
  const mk = (extra) => buildProcessGraph([
    { id: 'dev', triggers: [], outcomes: { mode: 'anyOf', options: [
      { id: 'ship', title: 'Ships PR', actions: [{ type: 'openPr' }], ...extra },
    ] } },
  ], {});
  assert.ok(lintCodes(mk({})).includes('producer-unconsumed'), 'unmarked producer still lints');
  assert.ok(!lintCodes(mk({ terminal: true })).includes('producer-unconsumed'), 'the merged PR IS the product');
  assert.ok(!lintCodes(mk({ external: {} })).includes('producer-unconsumed'), 'external consumer declared');
});

test('#1006: raw-trigger-nonconformant lint — visible deviation, advisory only', () => {
  const g = buildProcessGraph([
    { id: 'rogue', triggers: [
      { id: 't-two', type: 'github-event', events: ['issues.labeled', 'pull_request.labeled'], labelFilter: 'go', prompt: 'p' },
      { id: 't-ok', type: 'github-event', events: ['issues.labeled'], labelFilter: 'fine', claim: { remove: 'fine', add: 'fine:wip' } },
      { id: 't-badclaim', type: 'github-event', events: ['issues.labeled'], labelFilter: 'x', claim: { remove: 'x', add: 'nope' } },
    ] },
  ], {});
  const raws = g.lints.filter(l => l.code === 'raw-trigger-nonconformant');
  assert.equal(raws.length, 2);
  assert.ok(raws.every(l => l.severity === 'info'), 'advisory, never blocking');
  assert.deepEqual(raws.map(l => l.triggerIds[0]).sort(), ['t-badclaim', 't-two']);
});

test('#2626: an invalid cron trigger lints as never firing, not as a tolerated deviation', () => {
  const g = buildProcessGraph([
    { id: 'sched', triggers: [
      { id: 'bad', type: 'cron', cron: '75 * * * *', prompt: 'p' },
      { id: 'good', type: 'cron', cron: '0 9 * * 1-5', prompt: 'p' },
    ] },
  ], {});
  const raws = g.lints.filter(l => l.code === 'raw-trigger-nonconformant');
  assert.deepEqual(raws.map(l => l.triggerIds[0]), ['bad']);
  assert.match(raws[0].message, /`bad` never fires: Invalid cron expression "75 \* \* \* \*": minute must be 0–59/);
  assert.doesNotMatch(raws[0].message, /still runs/);
});

test('#1008: derived channel/data-flow triggers are exempt from the raw-trigger lint', () => {
  // A derived listener is ENGINE-written and regenerated on every port
  // reconcile — the operator cannot "edit it to conform". The unlabelled
  // PR-open channel derivation carries the two-event open pair; that must not
  // flag every team that uses a plain PR channel.
  const g = buildProcessGraph([
    { id: 'consumer', channels: [{ artifact: 'pr', from: 'producer' }], triggers: [
      { id: 'consumer-on-pr', type: 'github-event', channel: true,
        events: ['pull_request.opened', 'pull_request.reopened'], prompt: 'p' },
      { id: 'push-from-up', type: 'github-event', dataFlow: true,
        events: ['push', 'push'], prompt: 'p' },
      { id: 'hand-authored-two', type: 'github-event',
        events: ['issues.labeled', 'pull_request.labeled'], labelFilter: 'go', prompt: 'p' },
    ] },
    { id: 'producer', github: { producesPr: true }, triggers: [] },
  ], {});
  const raws = g.lints.filter(l => l.code === 'raw-trigger-nonconformant');
  assert.deepEqual(raws.map(l => l.triggerIds[0]), ['hand-authored-two'],
    'only the hand-authored deviation is flagged');
});

// ── #1197: a plain label a person consumes is a delivery, not a gate/brake ────

test('#1197: a plain label consumed by a human draws a delivery edge (kind label, handoff human, no brake) + touchpoint', () => {
  const g = buildProcessGraph([
    { id: 'reworker', emits: ['ready-for-review'], triggers: [] },
  ], {
    // ready-for-review carries NO gate/brake flag — a plain label.
    labels: [{ name: 'ready-for-review', humanGate: false, brake: false }],
    humans: [{ id: 'lead', name: 'Tech Lead', consumes: [{ label: 'ready-for-review' }] }],
  });
  const e = g.edges.find(x => x.label === 'ready-for-review' && x.from === 'reworker');
  assert.ok(e, 'the plain label is delivered, not dropped as a dead end');
  assert.equal(e.kind, 'label');
  assert.equal(e.handoff, 'human');
  assert.equal(e.to, 'lead');
  assert.ok(!e.brake, 'a plain-label delivery is NOT a brake');
  assert.ok(!e.deadEnd);
  // No blocking classification: the label is not turned into a gate/brake.
  assert.ok(!lintCodes(g).includes('dead-end-emitter'));
  assert.ok(!lintCodes(g).includes('outcome-without-consumer'));
  assert.ok(!lintCodes(g).includes('gate-violation'));
  // Enumerated as a delivery touchpoint bound to the named role.
  const tp = g.humanTouchpoints.find(t => t.type === 'delivery' && t.label === 'ready-for-review');
  assert.ok(tp, 'a label delivery is a human touchpoint');
  assert.equal(tp.agentId, 'reworker');
  assert.equal(tp.role, 'lead');
});

test('#1197: an OUTCOME setting a plain label a human consumes carries its outcome id (no dead-end)', () => {
  const g = buildProcessGraph([
    { id: 'reworker', triggers: [], outcomes: { mode: 'anyOf', options: [
      { id: 'send-for-review', title: 'Send for review', actions: [{ type: 'setLabel', label: 'ready-for-review' }] },
    ] } },
  ], { humans: [{ id: 'lead', name: 'Tech Lead', consumes: [{ label: 'ready-for-review' }] }] });
  assert.ok(!lintCodes(g).includes('outcome-without-consumer'));
  const e = g.edges.find(x => x.label === 'ready-for-review' && x.from === 'reworker');
  assert.equal(e.kind, 'label');
  assert.equal(e.handoff, 'human');
  assert.equal(e.to, 'lead');
  assert.equal(e.outcome, 'send-for-review');
});

test('#1197: a brake a human consumes stays a brake (not the plain-label path); an unconsumed plain label still dead-ends', () => {
  const brake = buildProcessGraph([
    { id: 'reworker', emits: ['needs-decision'], triggers: [] },
  ], {
    labels: [{ name: 'needs-decision', brake: true }],
    humans: [{ id: 'lead', name: 'Tech Lead', consumes: [{ label: 'needs-decision' }] }],
  });
  const be = brake.edges.find(x => x.label === 'needs-decision' && x.from === 'reworker');
  assert.equal(be.kind, 'brake', 'a flagged brake keeps its brake classification');
  assert.equal(be.to, 'lead');
  // Only one edge for the label — the plain-label loop must skip brakes (no dup).
  assert.equal(brake.edges.filter(x => x.label === 'needs-decision' && x.from === 'reworker').length, 1);

  const unconsumed = buildProcessGraph([
    { id: 'reworker', emits: ['ready-for-review'], triggers: [] },
  ], { labels: [{ name: 'ready-for-review', humanGate: false, brake: false }] });
  assert.ok(lintCodes(unconsumed).includes('dead-end-emitter'),
    'a plain label nobody consumes still reads as a dead end');
});

test('#1197: a plain label consumed by a person AND listened on by an agent draws both edges', () => {
  const g = buildProcessGraph([
    { id: 'reworker', emits: ['ready-for-review'], triggers: [] },
    { id: 'reviewer', triggers: [{ id: 't', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review' }] },
  ], { humans: [{ id: 'lead', name: 'Tech Lead', consumes: [{ label: 'ready-for-review' }] }] });
  assert.ok(g.edges.some(e => e.from === 'reworker' && e.to === 'reviewer' && e.kind === 'agent' && !e.handoff),
    'the agent listener edge is still drawn');
  assert.ok(g.edges.some(e => e.from === 'reworker' && e.to === 'lead' && e.handoff === 'human'),
    'the person delivery edge is also drawn');
});

// ─── #2031: direct agent-to-agent hand-off edges (on:'wake', concept §10) ────

test('#2031: a wakeAgent outcome action draws a producer→target wake edge', () => {
  const g = buildProcessGraph([
    { id: 'dev', displayName: 'Developer', triggers: [], outcomes: { mode: 'anyOf', options: [
      { id: 'handed-off', title: 'Handed off', actions: [{ type: 'wakeAgent', to: 'rev', note: 'mind step 3' }] },
    ] } },
    { id: 'rev', displayName: 'Reviewer', triggers: [] },
  ]);
  const wake = g.edges.filter(e => e.kind === 'wake');
  assert.equal(wake.length, 1);
  assert.deepEqual(wake[0], { from: 'dev', to: 'rev', kind: 'wake', outcome: 'handed-off', note: 'mind step 3' });
  // No label token anywhere: a direct hand-off is not a label hand-off.
  assert.equal(wake[0].label, undefined);
  assert.deepEqual(g.nodes.find(n => n.id === 'dev').emits, [],
    'a wakeAgent contributes nothing to the emit projection');
  assert.deepEqual(lintCodes(g), [], 'a wired hand-off raises no lint');
});

test('#2031: a note-less wakeAgent draws an edge with no note key', () => {
  const g = buildProcessGraph([
    { id: 'dev', triggers: [], outcomes: { mode: 'anyOf', options: [
      { id: 'h', actions: [{ type: 'wakeAgent', to: 'rev' }] },
    ] } },
    { id: 'rev', triggers: [] },
  ]);
  const e = g.edges.find(x => x.kind === 'wake');
  assert.ok(e && !('note' in e), 'an absent note is omitted, never an empty string');
});

test('#2031: two hand-offs from one producer to the SAME target stay two edges', () => {
  // The pair alone does not identify a hand-off — the outcome option does. Both
  // must survive here, or unified-graph's edgeId has nothing to key on.
  const g = buildProcessGraph([
    { id: 'dev', triggers: [], outcomes: { mode: 'anyOf', options: [
      { id: 'approved', actions: [{ type: 'wakeAgent', to: 'rev' }] },
      { id: 'second-look', actions: [{ type: 'wakeAgent', to: 'rev' }] },
    ] } },
    { id: 'rev', triggers: [] },
  ]);
  assert.deepEqual(g.edges.filter(e => e.kind === 'wake').map(e => e.outcome),
    ['approved', 'second-look']);
});

test('#2031: an unresolvable, self- or human-targeted hand-off draws NO edge', () => {
  const mk = (to, opts) => buildProcessGraph([
    { id: 'dev', triggers: [], outcomes: { mode: 'anyOf', options: [
      { id: 'h', actions: [{ type: 'wakeAgent', to }] },
    ] } },
  ], opts);
  assert.deepEqual(mk('ghost').edges.filter(e => e.kind === 'wake'), [],
    'an unknown target draws no line into nothing');
  assert.deepEqual(mk('dev').edges.filter(e => e.kind === 'wake'), [],
    'a self-wake is refused server-side — never drawn as a legal loop');
  // A person has no pending queue, so nothing could deliver the wake. `nodeIds`
  // is the agent id set, which is what rejects the human role here.
  const human = mk('lead', { humans: [{ id: 'lead', name: 'Tech Lead' }] });
  assert.deepEqual(human.edges.filter(e => e.kind === 'wake'), []);
  assert.ok(human.nodes.some(n => n.id === 'lead' && n.kind === 'human'),
    'the human role is still a node — only the wake edge is withheld');
});

test('#2031: a legacy agent with flat emits and no authored outcomes is untouched', () => {
  const g = buildProcessGraph([
    { id: 'dev', emits: ['ready-for-review'], triggers: [] },
    { id: 'rev', triggers: [{ id: 't', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review' }] },
  ]);
  assert.deepEqual(g.edges.filter(e => e.kind === 'wake'), []);
  assert.ok(g.edges.some(e => e.from === 'dev' && e.to === 'rev' && e.label === 'ready-for-review'));
});

// ─── #2032: direct hand-off lints (concept §12 P3, §13 Q3) ──────────────────

// A hand-off's target listener is `wake-agent`-typed and DERIVED — the
// producer never names a trigger id, so the consumer resolves its own at drain
// time (`_execute_wake_agent` takes the first ENABLED one).
const wakeListener = (over = {}) => ({ id: 'rev-on-handoff', type: 'wake-agent', prompt: 'take over', ...over });

function handoffGraph({ to = 'rev', note = 'mind step 3', target = {} } = {}) {
  return buildProcessGraph([
    { id: 'dev', displayName: 'Developer', triggers: [], outcomes: { mode: 'anyOf', options: [
      { id: 'handed-off', actions: [{ type: 'wakeAgent', to, ...(note ? { note } : {}) }] },
    ] } },
    { id: 'rev', displayName: 'Reviewer', triggers: [wakeListener()], ...target },
  ]);
}

test('#2032: a fully wired hand-off with a note raises no lint at all', () => {
  assert.deepEqual(lintCodes(handoffGraph()), []);
});

test('#2032: wake-target-disabled fires when the target listener is switched off', () => {
  // The outcome-without-consumer sibling: the producer's `aee-wake` succeeds,
  // the entry is enqueued, and `_execute_wake_agent` then drops it because no
  // enabled `wake-agent` trigger tells the consumer what to do — with nothing
  // on GitHub to show any of it happened.
  const g = handoffGraph({ target: { triggers: [wakeListener({ enabled: false })] } });
  const l = g.lints.filter(x => x.code === 'wake-target-disabled');
  assert.equal(l.length, 1);
  assert.equal(l[0].severity, 'warning');
  assert.equal(l[0].nodeId, 'dev', 'attributed to the producer, whose outcome it is');
  assert.equal(l[0].outcome, 'handed-off');
  assert.match(l[0].message, /queued and then dropped/);
});

test('#2032: one enabled listener beside a disabled one clears the lint', () => {
  // The runner takes the FIRST enabled one, so a single enabled listener is
  // enough — the lint must not fire on "some are disabled".
  const g = handoffGraph({ target: { triggers: [
    wakeListener({ id: 'old', enabled: false }), wakeListener({ id: 'live' }),
  ] } });
  assert.ok(!lintCodes(g).includes('wake-target-disabled'));
});

test('#2032: a MISSING listener is deliberately not linted', () => {
  // That listener is derived, never authored (`expandWakeHandoffs` /
  // `reconcileTeamWakeHandoffs`), so its absence in a draft or an imported
  // bundle is the reconciler's business at materialise time. Warning about it
  // would fire on every draft that has ever drawn a hand-off.
  const g = handoffGraph({ target: { triggers: [] } });
  assert.ok(!lintCodes(g).includes('wake-target-disabled'));
  assert.deepEqual(lintCodes(g), []);
});

test('#2032: wake-target-unresolved names the three hand-offs that draw no edge', () => {
  // Each of these draws NO edge by design, so without a lint the outcome
  // exists, the canvas shows nothing, and delivery refuses it at runtime with
  // a 404/403 the author never sees.
  const unknown = handoffGraph({ to: 'ghost' });
  assert.deepEqual(unknown.lints.filter(l => l.code === 'wake-target-unresolved')
    .map(l => l.severity), ['warning']);
  assert.match(unknown.lints.find(l => l.code === 'wake-target-unresolved').message,
    /not an agent in this flow/);

  const self = handoffGraph({ to: 'dev' });
  assert.match(self.lints.find(l => l.code === 'wake-target-unresolved').message,
    /hands off to itself/);

  const human = buildProcessGraph([
    { id: 'dev', triggers: [], outcomes: { mode: 'anyOf', options: [
      { id: 'h', actions: [{ type: 'wakeAgent', to: 'lead', note: 'n' }] },
    ] } },
  ], { humans: [{ id: 'lead', name: 'Tech Lead' }] });
  assert.match(human.lints.find(l => l.code === 'wake-target-unresolved').message,
    /a person has no queue/);
});

test('#2032: an unresolved hand-off is reported ONCE, not also as note-less', () => {
  // A target that cannot receive anything makes the note question moot — two
  // lints on one broken action would read as two problems.
  const g = handoffGraph({ to: 'ghost', note: '' });
  assert.deepEqual(lintCodes(g), ['wake-target-unresolved']);
});

test('#2032: wake-without-note is the Q3 answer — info, never a requirement', () => {
  // §13 Q3: the note stays optional (a required field invites "done"), but a
  // note-less hand-off carries less than a label does — a label at least names
  // a stage, while this row can only say who woke whom.
  const g = handoffGraph({ note: '' });
  const l = g.lints.filter(x => x.code === 'wake-without-note');
  assert.equal(l.length, 1);
  assert.equal(l[0].severity, 'info');
  assert.equal(l[0].nodeId, 'dev');
  assert.equal(l[0].outcome, 'handed-off');
  assert.ok(!lintCodes(handoffGraph({ note: 'a sentence' })).includes('wake-without-note'));
});

test('#2032: computeLints still works without a classifier (nodes+edges callers)', () => {
  // The signature is `computeLints(nodes, edges, classifier?)`; the new lints
  // read `isBrake`, which the fallback classifier must therefore also provide.
  const nodes = [{ id: 'a', triggers: [] }, { id: 'b', triggers: [] }];
  const edges = [{ from: 'a', to: 'b', label: 'hold', kind: 'agent', triggerId: 't' }];
  assert.doesNotThrow(() => computeLints(nodes, edges));
});

// ─── label-target-mismatch (#2629) ───────────────────────────────────────────
// A label on a PR arrives as `pull_request.labeled`, on an issue as
// `issues.labeled` — a consumer subscribed to the other one never wakes.

const prListener = (id, label) => ({
  id, role: 'agent',
  triggers: [{ id: `${id}-t`, type: 'github-event', events: ['pull_request.labeled'], labelFilter: label }],
});
// The #2622 incident shape: a merger woken on PRs sets `needs-conflict-resolution`.
const merger = (actions) => ({
  id: 'merger', role: 'agent',
  triggers: [{ id: 'merger-t', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-to-merge' }],
  outcomes: { mode: 'exactlyOne', options: [
    { id: 'merged', actions: [{ type: 'none' }] },
    { id: 'conflicts', actions },
  ] },
});
const mismatches = g => g.lints.filter(l => l.code === 'label-target-mismatch');

test('lint: label-target-mismatch fires (warning) when a PR label is consumed on issues.labeled', () => {
  const g = buildProcessGraph([
    merger([{ type: 'setLabel', label: 'needs-conflict-resolution', target: 'pr' }]),
    outcomeListener('solver', 'needs-conflict-resolution'),
  ]);
  const [m] = mismatches(g);
  assert.ok(m, 'mismatch lint expected');
  assert.equal(m.severity, 'warning');
  assert.equal(m.nodeId, 'solver');
  assert.equal(m.label, 'needs-conflict-resolution');
  assert.equal(m.outcome, 'conflicts');
  assert.deepEqual(m.triggerIds, ['solver-t']);
  assert.match(m.message, /pull_request\.labeled/);

  // Consumer repointed to pull_request.labeled → cleared.
  const ok = buildProcessGraph([
    merger([{ type: 'setLabel', label: 'needs-conflict-resolution', target: 'pr' }]),
    prListener('solver', 'needs-conflict-resolution'),
  ]);
  assert.equal(mismatches(ok).length, 0);
});

test('lint: label-target-mismatch infers the PR target from the producer\'s own PR-only triggers', () => {
  // No explicit target — the incident as authored. The merger is only ever woken
  // on pull requests, so the label it sets can only land on a PR.
  const g = buildProcessGraph([
    merger([{ type: 'setLabel', label: 'needs-conflict-resolution' }]),
    outcomeListener('solver', 'needs-conflict-resolution'),
  ]);
  assert.equal(mismatches(g).length, 1);
});

test('lint: label-target-mismatch infers the target from an openPr in the same outcome', () => {
  const dev = withOutcomes('dev', 'anyOf', [
    { id: 'opens-pr', actions: [{ type: 'openPr' }, { type: 'setLabel', label: 'ready-for-docs' }] },
  ]);
  assert.equal(mismatches(buildProcessGraph([dev, outcomeListener('docs', 'ready-for-docs')])).length, 1);
  assert.equal(mismatches(buildProcessGraph([dev, prListener('docs', 'ready-for-docs')])).length, 0);
});

test('lint: an explicit target wins over the producer-trigger inference', () => {
  // Woken on PRs, but the outcome says it labels the linked issue.
  const g = buildProcessGraph([
    merger([{ type: 'setLabel', label: 'reopen', target: 'issue' }]),
    outcomeListener('ba', 'reopen'),
  ]);
  assert.equal(mismatches(g).length, 0);
  const g2 = buildProcessGraph([
    merger([{ type: 'setLabel', label: 'reopen', target: 'issue' }]),
    prListener('ba', 'reopen'),
  ]);
  assert.equal(mismatches(g2).length, 1);
});

test('lint: label-target-mismatch stays silent when the target is unknown', () => {
  // No target, no artifact action, no triggers — nothing to disagree with.
  const g = buildProcessGraph([
    withOutcomes('router', 'anyOf', [{ id: 'go', actions: [{ type: 'setLabel', label: 'go' }] }]),
    outcomeListener('a', 'go'), prListener('b', 'go'),
  ]);
  assert.equal(mismatches(g).length, 0);
});

test('lint: label-target-mismatch accepts a listener subscribed to both labeled events', () => {
  const both = {
    id: 'solver', role: 'agent',
    triggers: [{ id: 'solver-t', type: 'github-event', events: ['issues.labeled', 'pull_request.labeled'], labelFilter: 'x' }],
  };
  const g = buildProcessGraph([merger([{ type: 'setLabel', label: 'x', target: 'pr' }]), both]);
  assert.equal(mismatches(g).length, 0);
});
