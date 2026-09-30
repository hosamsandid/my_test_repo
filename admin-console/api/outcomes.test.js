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
  slugifyOutcome, setLabelTarget, triggerObjectKind, labelTargetEvent,
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

// #928 AC4 — a setLabel onto a human gate is rejected on the FLAG basis. The name
// is irrelevant: `approved-for-dispatch` carries no `human:` prefix.
test('validateOutcomes rejects a FLAGGED human-gate label as a setLabel target', () => {
  const port = { mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'setLabel', label: 'approved-for-dispatch' }] }] };
  const v = validateOutcomes(port, { labels: [{ name: 'approved-for-dispatch', humanGate: true }] });
  assert.equal(v.ok, false);
  assert.match(v.error, /human-gate/);
});

test('validateOutcomes rejects a gate declared by a channel `gate: \'human\'` port', () => {
  const port = { mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'setLabel', label: 'design-approved' }] }] };
  const v = validateOutcomes(port, {
    agents: [{ id: 'dev', channels: [{ artifact: 'issue', from: 'x', label: 'design-approved', gate: 'human' }] }],
  });
  assert.equal(v.ok, false);
});

// #928 AC8 — the `human:` naming convention is retired: with no flag, the label
// is a plain agent label and a perfectly legal outcome.
test('validateOutcomes ACCEPTS an unflagged `human:`-named label (name convention retired)', () => {
  const v = validateOutcomes({ mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'setLabel', label: 'human:approve' }] }] });
  assert.equal(v.ok, true);
});

// #928 AC3 — a brake pauses the loop but IS agent-applied (the reworker setting
// `human-decision-required`), so it must not be rejected as an outcome.
test('validateOutcomes ACCEPTS a brake label as a setLabel target', () => {
  const port = { mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'setLabel', label: 'human-decision-required' }] }] };
  const v = validateOutcomes(port, { labels: [{ name: 'human-decision-required', humanGate: false, brake: true }] });
  assert.equal(v.ok, true);
});

test('validateOutcomes: the old hardcoded brake names carry no meaning of their own', () => {
  for (const label of ['hold', 'needs:human']) {
    const v = validateOutcomes({ mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'setLabel', label }] }] });
    assert.equal(v.ok, true, `expected ${label} accepted without a flag`);
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
  // Leading/trailing separator runs are trimmed; interior dashes are preserved.
  assert.equal(slugifyOutcome('  ready  '), 'ready');
  assert.equal(slugifyOutcome('---ready---'), 'ready');
  assert.equal(slugifyOutcome('a--b'), 'a--b');
  assert.equal(slugifyOutcome('----'), 'outcome');
  // A long run of separators must not blow up (js/polynomial-redos regression).
  assert.equal(slugifyOutcome('-'.repeat(100000) + 'x'), 'x');
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
    roles: [{ id: 'r', outcomes: { mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'setLabel' }] }] } }],
  };
  const v = validateProcessTemplate(bad);
  assert.equal(v.ok, false);
  assert.match(v.error, /role r:/);
});

// #928 AC6 — the bundle's own `labels[]` registry is the gate authority for the
// outcomes it validates: the same role passes or fails purely on the flag.
test('AC1/#928: a role outcome setting a bundle-flagged gate label fails validation', () => {
  const role = { id: 'r', outcomes: { mode: 'anyOf', options: [{ id: 'a', actions: [{ type: 'setLabel', label: 'approved-for-dispatch' }] }] } };
  const base = { processTemplateVersion: 1, name: 'x', level: 'template', roles: [role] };
  assert.equal(validateProcessTemplate(base).ok, true, 'no registry → plain agent label');
  const gated = { ...base, labels: [{ name: 'approved-for-dispatch', humanGate: true, brake: false }] };
  const v = validateProcessTemplate(gated);
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

test('gate-violation still fires if a FLAGGED gate label reaches the emit index (defence in depth)', () => {
  // validateOutcomes blocks this at write time, but the graph must still flag it
  // if it somehow lands (the projection routes setLabel labels through n.emits).
  const g = buildProcessGraph(
    [{ id: 'rogue', role: 'agent', triggers: [], emits: ['approved-for-dispatch'] }],
    { labels: [{ name: 'approved-for-dispatch', humanGate: true, brake: false }] },
  );
  assert.ok(g.lints.some(l => l.code === 'gate-violation'));
  // …and the same emit is clean without the flag (#928 AC8).
  const plain = buildProcessGraph([{ id: 'rogue', role: 'agent', triggers: [], emits: ['approved-for-dispatch'] }]);
  assert.ok(!plain.lints.some(l => l.code === 'gate-violation'));
});

// ─── #1004: open-end markers (terminal / external) ───────────────────────────

test('#1004: validateOutcomes accepts and gates the open-end markers', () => {
  const opt = (extra) => ({ mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'openPr' }], ...extra }] });
  assert.equal(validateOutcomes(opt({ terminal: true })).ok, true);
  assert.equal(validateOutcomes(opt({ external: {} })).ok, true);
  assert.equal(validateOutcomes(opt({ external: { note: 'CI workflow' } })).ok, true);
  // Gated shapes.
  assert.match(validateOutcomes(opt({ terminal: false })).error, /terminal must be true/);
  assert.match(validateOutcomes(opt({ external: 'yes' })).error, /external must be an object/);
  assert.match(validateOutcomes(opt({ external: { note: 42 } })).error, /note must be a string/);
  assert.match(validateOutcomes(opt({ terminal: true, external: {} })).error, /mutually exclusive/);
});

test('#1004: normalizeOutcomes round-trips the markers and trims the note', () => {
  const n = normalizeOutcomes({ mode: 'anyOf', options: [
    { id: 'a', actions: [{ type: 'openPr' }], terminal: true },
    { id: 'b', actions: [{ type: 'openIssue' }], external: { note: '  platform team  ' } },
    { id: 'c', actions: [{ type: 'none' }] },
  ] });
  assert.equal(n.options[0].terminal, true);
  assert.deepEqual(n.options[1].external, { note: 'platform team' });
  assert.ok(!('terminal' in n.options[2]) && !('external' in n.options[2]));
  // Idempotent — a second normalize changes nothing.
  assert.deepEqual(normalizeOutcomes(n), n);
});

test('#1004: substituteOutcomes carries the markers and substitutes the note', () => {
  const s = substituteOutcomes({ mode: 'anyOf', options: [
    { id: 'a', actions: [{ type: 'openPr' }], terminal: true },
    { id: 'b', actions: [{ type: 'openIssue' }], external: { note: 'CI on {{repoFullName}}' } },
  ] }, (t) => t.replace('{{repoFullName}}', 'org/repo'));
  assert.equal(s.options[0].terminal, true);
  assert.deepEqual(s.options[1].external, { note: 'CI on org/repo' });
});

// ─── wakeAgent: direct agent-to-agent hand-off (#2030, concept §4) ───────────

const {
  WAKE_NOTE_MAX, WAKE_NOTE_TRUNCATION_MARK, clampWakeNote, outcomeWakePairs,
} = require('./outcomes');
const { remapOutcomeWakeTargets, roleKeyOf } = require('./process-template');

// A producer whose "done" outcome opens a PR *and* hands off directly — the
// composition the concept was raised for (§4.1).
const handoffPort = (extra = {}) => ({
  mode: 'anyOf',
  options: [{
    id: 'hand-to-reviewer',
    title: 'Hand off to Code Reviewer',
    when: 'Implementation is complete and the tests are green',
    actions: [
      { type: 'openPr' },
      { type: 'wakeAgent', to: 'code-reviewer', note: 'Look closely at the migration in step 3.', ...extra },
    ],
  }],
});
const FLOW = { agents: [{ id: 'developer' }, { id: 'code-reviewer' }], roleId: 'developer' };

test('#2030: wakeAgent is an admitted action type', () => {
  assert.equal(validateOutcomes(handoffPort(), FLOW).ok, true);
});

test('#2030: a wakeAgent action needs a to', () => {
  for (const bad of [undefined, '', '   ', 42, null]) {
    const port = { mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'wakeAgent', ...(bad === undefined ? {} : { to: bad }) }] }] };
    const v = validateOutcomes(port, FLOW);
    assert.equal(v.ok, false, JSON.stringify(bad));
    assert.equal(v.error, 'option x: wakeAgent action needs a to');
  }
});

test('#2030: a wakeAgent target must be a role in this flow', () => {
  const port = { mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'wakeAgent', to: 'ghost' }] }] };
  const v = validateOutcomes(port, FLOW);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'option x: wakeAgent target `ghost` is not a role in this flow');
});

test('#2030: a wakeAgent may not target its own role', () => {
  const port = { mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'wakeAgent', to: 'developer' }] }] };
  const v = validateOutcomes(port, FLOW);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'option x: wakeAgent may not target its own role');
});

test('#2030: a wakeAgent target outside the producer\'s team is refused as cross-team', () => {
  // Reachable where the agents source spans teams (the live PUT path): an agent
  // that really exists elsewhere must read as "outside this team", not as
  // "not a role in this flow" — the two are different mistakes.
  const sources = {
    roleId: 'acme-dev',
    agents: [
      { id: 'acme-dev', parentTeamId: 'acme' },
      { id: 'other-reviewer', parentTeamId: 'other' },
    ],
  };
  const port = { mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'wakeAgent', to: 'other-reviewer' }] }] };
  const v = validateOutcomes(port, sources);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'option x: wakeAgent target `other-reviewer` is outside this team');
});

test('#2030: a wakeAgent note must be a string', () => {
  const port = { mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'wakeAgent', to: 'code-reviewer', note: 42 }] }] };
  const v = validateOutcomes(port, FLOW);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'option x: note must be a string');
});

test('#2030: with no agents source the target rules stay SILENT rather than guessing', () => {
  // Same posture as the gate rule with no label registry: an unverifiable
  // target is not an authoring error — delivery still refuses it with a 404.
  const port = { mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'wakeAgent', to: 'anything' }] }] };
  assert.equal(validateOutcomes(port).ok, true);
  assert.equal(validateOutcomes(port, { labels: [] }).ok, true);
  // The self rule needs only roleId, so it still fires without an agents list.
  const self = { mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'wakeAgent', to: 'me' }] }] };
  assert.match(validateOutcomes(self, { roleId: 'me' }).error, /may not target its own role/);
});

test('#2030: the note is CAPPED and truncated with a marker, never rejected', () => {
  const long = 'x'.repeat(WAKE_NOTE_MAX + 500);
  assert.equal(validateOutcomes({ mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'wakeAgent', to: 'code-reviewer', note: long }] }] }, FLOW).ok, true);
  const clamped = clampWakeNote(long);
  assert.equal(clamped.length, WAKE_NOTE_MAX);
  assert.ok(clamped.endsWith(WAKE_NOTE_TRUNCATION_MARK));
  assert.equal(clampWakeNote('short'), 'short');
});

test('#2030: normalizeOutcomes carries to + note (whitelist 1 — dropped on every persist)', () => {
  const n = normalizeOutcomes(handoffPort());
  assert.deepEqual(n.options[0].actions, [
    { type: 'openPr' },
    { type: 'wakeAgent', to: 'code-reviewer', note: 'Look closely at the migration in step 3.' },
  ]);
  // Idempotent, and the cap is applied here too.
  assert.deepEqual(normalizeOutcomes(n), n);
  const capped = normalizeOutcomes({ mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'wakeAgent', to: ' r ', note: 'z'.repeat(WAKE_NOTE_MAX + 9) }] }] });
  assert.equal(capped.options[0].actions[0].to, 'r');
  assert.equal(capped.options[0].actions[0].note.length, WAKE_NOTE_MAX);
});

test('#2030: substituteOutcomes carries to + substitutes the note (whitelist 2 — dropped at materialise)', () => {
  const s = substituteOutcomes({ mode: 'anyOf', options: [{ id: 'x', actions: [
    { type: 'wakeAgent', to: 'code-reviewer', note: 'Review {{repoFullName}} closely.' },
  ] }] }, (t) => t.replace('{{repoFullName}}', 'org/repo'));
  assert.deepEqual(s.options[0].actions[0], {
    type: 'wakeAgent', to: 'code-reviewer', note: 'Review org/repo closely.',
  });
});

test('#2030: `to` is NOT {{var}}-substituted — it is a role reference, remapped instead', () => {
  const s = substituteOutcomes({ mode: 'anyOf', options: [{ id: 'x', actions: [
    { type: 'wakeAgent', to: '{{agentId}}' },
  ] }] }, () => 'SUBSTITUTED');
  assert.equal(s.options[0].actions[0].to, '{{agentId}}');
});

test('#2030: a {{var}} that expands past the cap is re-clamped after substitution', () => {
  const s = substituteOutcomes({ mode: 'anyOf', options: [{ id: 'x', actions: [
    { type: 'wakeAgent', to: 'r', note: '{{big}}' },
  ] }] }, () => 'q'.repeat(WAKE_NOTE_MAX + 100));
  assert.equal(s.options[0].actions[0].note.length, WAKE_NOTE_MAX);
  assert.ok(s.options[0].actions[0].note.endsWith(WAKE_NOTE_TRUNCATION_MARK));
});

test('#2030: outcomeWakePairs indexes the wake edges, order-preserving and deduped', () => {
  const port = { mode: 'anyOf', options: [
    { id: 'a', actions: [{ type: 'wakeAgent', to: 'r1', note: 'n1' }, { type: 'wakeAgent', to: 'r1' }] },
    { id: 'b', actions: [{ type: 'setLabel', label: 'ready' }, { type: 'wakeAgent', to: 'r2' }] },
    { id: 'c', actions: [{ type: 'wakeAgent' }] }, // to-less: skipped defensively
  ] };
  assert.deepEqual(outcomeWakePairs(port), [
    { to: 'r1', outcome: 'a', note: 'n1' },
    { to: 'r2', outcome: 'b' },
  ]);
  assert.deepEqual(outcomeWakePairs(null), []);
});

test('#2030: a wakeAgent contributes no label and no github produce flag', () => {
  // The whole point: this edge carries no label token and opens no artifact.
  assert.deepEqual(outcomeSetLabels({ mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'wakeAgent', to: 'r' }] }] }), []);
  assert.deepEqual(outcomesToGithub({ mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'wakeAgent', to: 'r' }] }] }), {});
});

// ─── round-trip: bundle → member → export (remaps 4 and 5) ──────────────────

test('#2030: buildMemberFromTemplate remaps the role id to a member id', () => {
  const m = buildMemberFromTemplate(
    { id: 'developer', displayName: 'Developer', promptTemplate: 'p', outcomes: handoffPort() },
    { teamId: 'acme', vars: {} },
  );
  const wake = m.outcomes.options[0].actions.find(a => a.type === 'wakeAgent');
  assert.equal(wake.to, 'acme-code-reviewer',
    'a bare role id in a member config would never resolve at delivery');
  assert.equal(wake.note, 'Look closely at the migration in step 3.');
});

test('#2030: remapOutcomeWakeTargets is the exact inverse across the round trip', () => {
  const bundlePort = normalizeOutcomes(handoffPort());
  const live = remapOutcomeWakeTargets(bundlePort, (to) => `acme-${to}`);
  const back = remapOutcomeWakeTargets(live, (to) => roleKeyOf(to, 'acme'));
  assert.deepEqual(back, bundlePort);
});

test('#2030: remapOutcomeWakeTargets leaves a wake-free port byte-identical (same object)', () => {
  const port = normalizeOutcomes(dispatcher());
  assert.equal(remapOutcomeWakeTargets(port, (to) => `acme-${to}`), port);
});

test('#2030: an exported bundle carries a portable role key, not <teamId>-<roleId>', () => {
  const bundle = buildProcessTemplate({
    teamId: 'acme',
    roles: [
      { id: 'acme-developer', displayName: 'Developer', systemPrompt: 'p',
        outcomes: { mode: 'anyOf', options: [{ id: 'h', actions: [{ type: 'wakeAgent', to: 'acme-code-reviewer', note: 'n' }] }] } },
      { id: 'acme-code-reviewer', displayName: 'Code Reviewer', systemPrompt: 'p' },
    ],
  });
  const dev = bundle.roles.find(r => r.id === 'developer');
  assert.equal(dev.outcomes.options[0].actions[0].to, 'code-reviewer');
  // …and the re-exported bundle validates, with the not-self / target-exists
  // rules now reading the portable keys.
  assert.equal(validateProcessTemplate(bundle).ok, true, validateProcessTemplate(bundle).error);
});

test('#2030: the bundle validator names the producer, so not-self fires on a bundle', () => {
  const bundle = buildProcessTemplate({
    teamId: 'acme',
    roles: [{ id: 'acme-developer', displayName: 'Developer', systemPrompt: 'p' }],
  });
  bundle.roles[0].outcomes = { mode: 'anyOf', options: [{ id: 'h', actions: [{ type: 'wakeAgent', to: 'developer' }] }] };
  const v = validateProcessTemplate(bundle);
  assert.equal(v.ok, false);
  assert.match(v.error, /role developer: option h: wakeAgent may not target its own role/);
});

// ─── setLabel target: Issue vs PR (#2629) ────────────────────────────────────

test('#2629: validateOutcomes accepts target issue/pr on setLabel and rejects anything else', () => {
  const port = target => ({ mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'setLabel', label: 'l', target }] }] });
  assert.equal(validateOutcomes(port('pr')).ok, true);
  assert.equal(validateOutcomes(port('issue')).ok, true);
  assert.equal(validateOutcomes(port(undefined)).ok, true);
  const bad = validateOutcomes(port('pull_request'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /target must be 'issue' or 'pr'/);
});

test('#2629: normalizeOutcomes and substituteOutcomes keep a setLabel target (and drop junk)', () => {
  const port = { mode: 'anyOf', options: [
    { id: 'a', actions: [{ type: 'setLabel', label: '{{p}}-x', target: 'pr' }] },
    { id: 'b', actions: [{ type: 'setLabel', label: 'y', target: 'nope' }] },
  ] };
  const n = normalizeOutcomes(port);
  assert.deepEqual(n.options[0].actions, [{ type: 'setLabel', label: '{{p}}-x', target: 'pr' }]);
  assert.deepEqual(n.options[1].actions, [{ type: 'setLabel', label: 'y' }]);
  const s = substituteOutcomes(port, v => v.replace('{{p}}', 'team'));
  assert.deepEqual(s.options[0].actions, [{ type: 'setLabel', label: 'team-x', target: 'pr' }]);
});

test('#2629: setLabelTarget — explicit, then the outcome\'s artifact, then the producer\'s triggers', () => {
  const prTriggers = [{ type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'go' }];
  const issueTriggers = [{ type: 'github-event', events: ['issues.labeled'], labelFilter: 'go' }];
  const lbl = { type: 'setLabel', label: 'x' };
  assert.equal(setLabelTarget({ actions: [lbl] }, { ...lbl, target: 'issue' }, prTriggers), 'issue');
  assert.equal(setLabelTarget({ actions: [{ type: 'openPr' }, lbl] }, lbl, issueTriggers), 'pr');
  assert.equal(setLabelTarget({ actions: [{ type: 'openIssue' }, lbl] }, lbl, prTriggers), 'issue');
  assert.equal(setLabelTarget({ actions: [lbl] }, lbl, prTriggers), 'pr');
  assert.equal(setLabelTarget({ actions: [lbl] }, lbl, issueTriggers), 'issue');
  assert.equal(setLabelTarget({ actions: [lbl] }, lbl, [...prTriggers, ...issueTriggers]), null);
  assert.equal(setLabelTarget({ actions: [lbl] }, lbl, []), null);
});

test('#2629: triggerObjectKind ignores kind-ambiguous events; labelTargetEvent maps the target', () => {
  assert.equal(triggerObjectKind([{ type: 'github-event', events: ['pull_request_review.submitted'] }]), 'pr');
  assert.equal(triggerObjectKind([{ type: 'github-event', events: ['issue_comment.created', 'push'] }]), null);
  assert.equal(triggerObjectKind([{ type: 'cron', cron: '* * * * *' }]), null);
  assert.equal(labelTargetEvent('pr'), 'pull_request.labeled');
  assert.equal(labelTargetEvent('issue'), 'issues.labeled');
  assert.equal(labelTargetEvent(null), null);
});
