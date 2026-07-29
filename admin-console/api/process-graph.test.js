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
  assert.ok(dispatcher.emits.includes('dispatch'),
    'dispatcher should carry `dispatch` as a role-level emitted label');
});

test('template level: a synthetic listener wires to a shipped emitter', () => {
  // Prove the mechanism end-to-end: someone listening on `dispatch` gets an
  // edge from the dispatcher (which emits it).
  const listener = {
    id: 'consumer', role: 'template',
    triggers: [{ id: 'l', type: 'github-event', labelFilter: 'dispatch' }],
  };
  const g = buildProcessGraph([templateNode(loadTpl('dispatcher')), listener]);
  const e = g.edges.find(x => x.from === 'dispatcher' && x.to === 'consumer');
  assert.ok(e, 'expected dispatcher → consumer edge on `dispatch`');
  assert.equal(e.label, 'dispatch');
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

test('lint: a clean wired pair produces no lints', () => {
  const g = buildProcessGraph([
    { id: 'a', emits: ['dispatch'], triggers: [{ id: 't', type: 'github-event', from: 'humans', events: ['x'] }] },
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

test('a loop trigger contributes no graph edge or lint (canvas rendering is a separate ticket)', () => {
  const g = buildProcessGraph([
    { id: 'dev', role: 'agent', triggers: [{ id: 'l', type: 'loop', maxIterations: 5 }] },
  ]);
  // No self-edge (unlike cron/once timers) and no orphan/dead-end noise.
  assert.equal(g.edges.length, 0);
  assert.equal(g.lints.length, 0);
});
