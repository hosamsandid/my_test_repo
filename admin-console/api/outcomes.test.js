'use strict';

// Tests for the agent/role OUTCOMES data model (#827, concept §3/§5.1/§7).
// Covers the pure module (schema, lift, projections), the bundle round-trip
// (build → validate → materialise → export → re-import) with {{var}}
// substitution, and the outcome-keyed graph edges (authored + legacy
// byte-identical).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateOutcomes, normalizeOutcomes, isAuthoredOutcomes, liftOutcomes,
  outcomeEmitPairs, outcomeSetLabels, outcomesToGithub, substituteOutcomes,
  slugifyOutcome,
} = require('./outcomes');
const {
  buildProcessTemplate, validateProcessTemplate, templateToCustomRoles,
  buildMemberFromTemplate,
} = require('./process-template');
const { buildProcessGraph } = require('./process-graph');
const { buildUnifiedGraph, processTemplateToUnified } = require('./unified-graph');

const dispatcher = () => ({
  mode: 'exactlyOne',
  options: [
    { id: 'to-developer', title: 'Route to Developer', when: 'Frontend/UI task', actions: [{ type: 'setLabel', label: 'ready' }] },
    { id: 'to-developer-2', title: 'Route to Developer 2', when: 'Backend task', actions: [{ type: 'setLabel', label: 'ready-2' }] },
    { id: 'hold', title: 'Hold', when: 'Ambiguous', actions: [{ type: 'none' }], notify: 'dm' },
  ],
});

// ─── schema validation (AC3) ─────────────────────────────────────────────────

test('validateOutcomes accepts a well-formed switch', () => {
  assert.deepEqual(validateOutcomes(dispatcher()), { ok: true });
});

test('validateOutcomes rejects an unknown mode', () => {
  const v = validateOutcomes({ mode: 'maybe', options: [] });
  assert.equal(v.ok, false);
  assert.match(v.error, /mode/);
});

test('validateOutcomes rejects a human:* label as a setLabel target', () => {
  const v = validateOutcomes({ mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'setLabel', label: 'human:approve' }] }] });
  assert.equal(v.ok, false);
  assert.match(v.error, /gate\/brake/);
});

test('validateOutcomes rejects a brake label (hold / needs:human)', () => {
  for (const label of ['hold', 'needs:human']) {
    const v = validateOutcomes({ mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'setLabel', label }] }] });
    assert.equal(v.ok, false, `expected ${label} rejected`);
  }
});

test('validateOutcomes rejects duplicate option ids', () => {
  const v = validateOutcomes({ mode: 'anyOf', options: [{ id: 'x', actions: [] }, { id: 'x', actions: [] }] });
  assert.equal(v.ok, false);
  assert.match(v.error, /duplicate/);
});

test('validateOutcomes rejects an unknown action type', () => {
  const v = validateOutcomes({ mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'frobnicate' }] }] });
  assert.equal(v.ok, false);
  assert.match(v.error, /unknown action type/);
});

test('validateOutcomes rejects a setLabel with no label', () => {
  const v = validateOutcomes({ mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'setLabel' }] }] });
  assert.equal(v.ok, false);
  assert.match(v.error, /needs a label/);
});

test('validateOutcomes: exactlyOne with fewer than two options is VALID (lint is phase 5)', () => {
  assert.deepEqual(
    validateOutcomes({ mode: 'exactlyOne', options: [{ id: 'only', actions: [{ type: 'none' }] }] }),
    { ok: true });
});

// ─── read-path lift (AC7 / §7) ───────────────────────────────────────────────

test('liftOutcomes derives the degenerate anyOf set from flat emits', () => {
  assert.deepEqual(liftOutcomes({ emits: ['ready', 'dispatch'] }), {
    mode: 'anyOf',
    options: [
      { id: 'ready', actions: [{ type: 'setLabel', label: 'ready' }] },
      { id: 'dispatch', actions: [{ type: 'setLabel', label: 'dispatch' }] },
    ],
  });
});

test('liftOutcomes de-dupes flat emits and prefers authored outcomes', () => {
  assert.deepEqual(liftOutcomes({ emits: ['ready', 'ready'] }).options.length, 1);
  const authored = dispatcher();
  assert.equal(liftOutcomes({ outcomes: authored, emits: ['ignored'] }).options.length, 3);
});

test('liftOutcomes returns null when the agent declares neither', () => {
  assert.equal(liftOutcomes({}), null);
  assert.equal(liftOutcomes({ emits: [] }), null);
});

test('isAuthoredOutcomes distinguishes an authored port from flat emits', () => {
  assert.equal(isAuthoredOutcomes(dispatcher()), true);
  assert.equal(isAuthoredOutcomes({ mode: 'anyOf', options: [] }), false);
  assert.equal(isAuthoredOutcomes(null), false);
});

// ─── projections ─────────────────────────────────────────────────────────────

test('outcomeSetLabels / outcomeEmitPairs project setLabel actions, keyed by outcome id', () => {
  const o = dispatcher();
  assert.deepEqual(outcomeSetLabels(o), ['ready', 'ready-2']);
  assert.deepEqual(outcomeEmitPairs(o), [
    { label: 'ready', outcome: 'to-developer' },
    { label: 'ready-2', outcome: 'to-developer-2' },
  ]);
});

test('outcomesToGithub folds openPr/openIssue actions into produce flags', () => {
  const o = { mode: 'anyOf', options: [
    { id: 'pr', actions: [{ type: 'openPr' }] },
    { id: 'iss', actions: [{ type: 'openIssue' }, { type: 'setLabel', label: 'triage' }] },
  ] };
  assert.deepEqual(outcomesToGithub(o), { producesPr: true, producesIssue: true });
  assert.deepEqual(outcomesToGithub(dispatcher()), {});
});

test('normalizeOutcomes drops unknown fields but preserves the documented ones', () => {
  const norm = normalizeOutcomes({
    mode: 'anyOf', junk: 1,
    options: [{ id: ' a ', title: 'A', when: 'w', notify: 'dm', bogus: 2,
      actions: [{ type: 'setLabel', label: ' ready ', extra: true }, { type: 'none', label: 'ignored' }] }],
  });
  assert.deepEqual(norm, {
    mode: 'anyOf',
    options: [{ id: 'a', title: 'A', when: 'w',
      actions: [{ type: 'setLabel', label: 'ready' }, { type: 'none' }], notify: 'dm' }],
  });
});

test('substituteOutcomes applies {{var}} to label + when only', () => {
  const out = substituteOutcomes(
    { mode: 'anyOf', options: [{ id: 'a', title: 'keep {{x}}', when: 'repo {{repoFullName}}', actions: [{ type: 'setLabel', label: 'ready-{{stagePrefix}}' }] }] },
    (s) => s.replace('{{repoFullName}}', 'o/r').replace('{{stagePrefix}}', 'dev').replace('{{x}}', 'NO'));
  assert.equal(out.options[0].when, 'repo o/r');
  assert.equal(out.options[0].actions[0].label, 'ready-dev');
  assert.equal(out.options[0].title, 'keep {{x}}'); // title is NOT a template field
});

test('slugifyOutcome makes a stable id from a label', () => {
  assert.equal(slugifyOutcome('ready-2'), 'ready-2');
  assert.equal(slugifyOutcome('stage:build'), 'stage-build');
  assert.equal(slugifyOutcome('!!!'), 'outcome');
});

// ─── bundle round-trip (AC1) ─────────────────────────────────────────────────

test('AC1: outcomes round-trip draft → materialise → member config → export → re-import, with {{var}}', () => {
  // A draft bundle whose one role carries a templated outcomes port.
  const draft = {
    processTemplateVersion: 1, name: 'Dispatch flow', level: 'template',
    roles: [{
      id: 'dispatcher', displayName: 'Dispatcher', role: 'team-member', sessionPolicy: 'per-invocation',
      systemPrompt: 'You route work.',
      outcomes: {
        mode: 'exactlyOne',
        options: [
          { id: 'to-dev', title: 'Route to Dev', when: 'repo {{repoFullName}}', actions: [{ type: 'setLabel', label: 'ready-{{stagePrefix}}' }] },
          { id: 'open-pr', title: 'Open a PR', actions: [{ type: 'openPr' }] },
        ],
      },
    }],
    gates: [], labels: [], stages: [],
  };
  assert.equal(validateProcessTemplate(draft).ok, true);

  // Materialise: bundle role → customRole → per-member config with {{var}} applied.
  const [customRole] = templateToCustomRoles(draft);
  assert.ok(customRole.outcomes, 'customRole carries outcomes');
  const member = buildMemberFromTemplate(customRole, {
    teamId: 'acme', memberId: 'acme-dispatcher', memberDisplayName: 'Dispatcher',
    vars: { repoFullName: 'acme/app', stagePrefix: 'impl' },
  });
  assert.equal(member.outcomes.options[0].actions[0].label, 'ready-impl'); // {{stagePrefix}}
  assert.equal(member.outcomes.options[0].when, 'repo acme/app');          // {{repoFullName}}
  assert.ok(!('emits' in member), 'outcomes supersede emits on the member config');

  // Export: member config → bundle role.
  const exported = buildProcessTemplate({
    name: 'Dispatch flow', level: 'live', teamId: 'acme',
    roles: [{ id: 'acme-dispatcher', displayName: 'Dispatcher', role: 'team-member',
      sessionPolicy: 'per-invocation', systemPrompt: 'You route work.', outcomes: member.outcomes }],
  });
  const exportedRole = exported.roles[0];
  assert.equal(exportedRole.id, 'dispatcher'); // roleKeyOf stripped the team prefix
  assert.equal(exportedRole.outcomes.options[0].actions[0].label, 'ready-impl');

  // Re-import: the exported bundle validates and preserves the port losslessly.
  assert.equal(validateProcessTemplate(exported).ok, true);
  assert.deepEqual(exportedRole.outcomes, member.outcomes);
});

test('AC1: an invalid outcomes port fails validateProcessTemplate with the role id', () => {
  const bad = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [{ id: 'r', outcomes: { mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'setLabel', label: 'human:go' }] }] } }],
  };
  const v = validateProcessTemplate(bad);
  assert.equal(v.ok, false);
  assert.match(v.error, /role r:/);
});

test('buildProcessTemplate drops emits when a role also carries authored outcomes', () => {
  const b = buildProcessTemplate({
    name: 'x', level: 'template',
    roles: [{ id: 'r', emits: ['ready'], outcomes: dispatcher() }],
  });
  assert.ok(b.roles[0].outcomes);
  assert.ok(!('emits' in b.roles[0]), 'emits is superseded by outcomes');
});

// ─── outcome-keyed graph edges (AC2) ─────────────────────────────────────────

const listener = (id, label) => ({
  id, role: 'agent', triggers: [{ id: `${id}-t`, type: 'github-event', events: ['issues.labeled'], labelFilter: label }],
});

test('AC2: authored outcomes produce the same label edges as flat emits, plus an `outcome` key', () => {
  const authored = buildProcessGraph([
    { id: 'dispatcher', role: 'agent', triggers: [], outcomes: {
      mode: 'exactlyOne', options: [{ id: 'to-dev', actions: [{ type: 'setLabel', label: 'ready' }] }] } },
    listener('developer', 'ready'),
  ]);
  const legacy = buildProcessGraph([
    { id: 'dispatcher', role: 'agent', triggers: [], emits: ['ready'] },
    listener('developer', 'ready'),
  ]);
  const aEdge = authored.edges.find(e => e.from === 'dispatcher' && e.to === 'developer');
  const lEdge = legacy.edges.find(e => e.from === 'dispatcher' && e.to === 'developer');
  assert.ok(aEdge && lEdge);
  assert.equal(aEdge.outcome, 'to-dev');
  assert.ok(!('outcome' in lEdge), 'legacy edge carries NO outcome field');
  // The authored edge is byte-identical to the legacy one once the additive
  // `outcome` annotation is removed.
  const { outcome, ...aStripped } = aEdge; // eslint-disable-line no-unused-vars
  assert.deepEqual(aStripped, lEdge);
});

test('AC2: a legacy agent (flat emits, no outcomes) builds edges with no outcome field anywhere', () => {
  const g = buildProcessGraph([
    { id: 'reviewer', role: 'agent', triggers: [], emits: ['ready-to-merge', 'revisions-required'] },
    listener('merger', 'ready-to-merge'),
    listener('reworker', 'revisions-required'),
  ]);
  assert.ok(g.edges.length >= 2);
  assert.ok(g.edges.every(e => !('outcome' in e)), 'no outcome annotation on any legacy edge');
});

test('AC2: outcomes openPr projects the github produce flag + node badge (unified graph)', () => {
  const bundle = {
    processTemplateVersion: 1, name: 'x', level: 'template',
    roles: [
      { id: 'author', role: 'team-member', outcomes: { mode: 'anyOf', options: [{ id: 'pr', actions: [{ type: 'openPr' }] }] } },
      { id: 'reviewer', role: 'team-member', channels: [{ artifact: 'pr', from: 'author' }] },
    ],
    gates: [], labels: [],
  };
  const flow = processTemplateToUnified(bundle);
  const g = buildUnifiedGraph(flow.nodes, flow.edges);
  const author = g.nodes.find(n => n.id === 'author');
  assert.deepEqual(author.github, { producesPr: true });
  // channel-from-non-producer must NOT fire — the openPr outcome makes `author`
  // a producer even without an explicit github.producesPr flag.
  assert.ok(!g.lints.some(l => l.code === 'channel-from-non-producer'),
    'openPr outcome satisfies the producer requirement');
});

test('gate-violation still fires if a human:* label reaches the emit index (defence in depth)', () => {
  // validateOutcomes blocks this at write time, but the graph must still flag it
  // if it somehow lands (the projection routes setLabel labels through n.emits).
  const g = buildProcessGraph([
    { id: 'rogue', role: 'agent', triggers: [], emits: ['human:approve'] },
  ]);
  assert.ok(g.lints.some(l => l.code === 'gate-violation'));
});
