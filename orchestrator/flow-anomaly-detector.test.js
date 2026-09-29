'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildFlowModel,
  detectFlowAnomalies,
  claimLabelFor,
  CLAIM_SUFFIX,
  COMPLETED_SUFFIX,
  DEFAULT_THRESHOLDS,
} = require('./flow-anomaly-detector');

// A fixed clock so every case is deterministic (Date.now() is never called).
const NOW = Date.parse('2026-07-29T12:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

// --- The Agent Studio SDLC flow used as the golden graph ---------------------
// Mirrors the real 2026-07-29 chain: Business Analyst → (human `ready`) →
// Developer → Code Reviewer, plus a Merger consuming `ready-to-merge` and a
// human gate `human-decision-required`.
const MEMBERS = [
  {
    id: 'team-developer',
    displayName: 'Developer',
    emits: ['ready-for-review'],
    github: { producesPr: true },
    triggers: [
      { id: 't-dev', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready',
        claim: { remove: 'ready', add: 'ready:wip' } },
    ],
  },
  {
    id: 'team-code-reviewer',
    displayName: 'Code Reviewer',
    emits: ['ready-to-merge', 'revisions-required'],
    triggers: [
      { id: 't-rev', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review',
        claim: { remove: 'ready-for-review', add: 'ready-for-review:wip' } },
    ],
  },
  {
    id: 'team-merger',
    displayName: 'Merger',
    // No emits, no producesPr — its success is observable only as a merged PR
    // (the #949 dead-end class).
    triggers: [
      { id: 't-merge', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-to-merge',
        claim: { remove: 'ready-to-merge', add: 'ready-to-merge:wip' } },
    ],
  },
];

const LABELS = [
  { name: 'ready', humanGate: true }, // applied by a human — but consumed as a wake
  { name: 'ready-for-review' },
  { name: 'ready-to-merge' },
  { name: 'revisions-required' },
  { name: 'human-decision-required', humanGate: true, brake: true },
];

// Note: `ready` is flagged humanGate in the registry above only to prove the
// gate/wake distinction is by *consumption*, not naming — but a wake listener
// consumes it, so the model still treats it as a wake. Use a registry WITHOUT
// the humanGate flag on `ready` for the main cases so it is unambiguously a wake.
const WAKE_LABELS = LABELS.map((l) => (l.name === 'ready' ? { name: 'ready' } : l));

// ---------------------------------------------------------------------------
// Model derivation
// ---------------------------------------------------------------------------

test('buildFlowModel derives wake/claim/gate edges from ports', () => {
  const model = buildFlowModel(MEMBERS, { labels: WAKE_LABELS });

  const wakeReady = model.wakeEdges.find((w) => w.label === 'ready');
  assert.ok(wakeReady, 'ready is a wake edge');
  assert.equal(wakeReady.claimLabel, 'ready:wip');
  assert.deepEqual(wakeReady.consumers, ['team-developer']);

  const claimReady = model.claimEdges.find((c) => c.claimLabel === 'ready:wip');
  assert.ok(claimReady, 'ready:wip is a claim edge');
  assert.equal(claimReady.wakeLabel, 'ready');
  assert.deepEqual(claimReady.consumers, ['team-developer']);

  assert.deepEqual(model.gateLabels.sort(), ['human-decision-required']);

  assert.equal(model.consumers['team-developer'].producesPr, true);
  assert.deepEqual(model.consumers['team-code-reviewer'].emits.sort(), ['ready-to-merge', 'revisions-required']);
});

test('buildFlowModel: a humanGate label is not treated as a wake even if a listener names it', () => {
  const model = buildFlowModel(MEMBERS, { labels: LABELS }); // `ready` flagged humanGate here
  assert.ok(!model.wakeEdges.find((w) => w.label === 'ready'),
    'a humanGate label is excluded from wake edges (#928 config over naming)');
});

test('buildFlowModel: claim label comes from claim.add when present, else <wake>:wip', () => {
  const model = buildFlowModel([
    { id: 'a', triggers: [{ type: 'github-event', labelFilter: 'go' }] }, // no explicit claim
  ], {});
  assert.equal(model.wakeEdges[0].claimLabel, claimLabelFor('go'));
});

// ---------------------------------------------------------------------------
// Golden fixtures — the four anomaly classes
// ---------------------------------------------------------------------------

const MODEL = buildFlowModel(MEMBERS, { labels: WAKE_LABELS });

test('wake-not-claimed: `ready` sitting past T1 with no claim and no run', () => {
  const github = {
    objects: [
      { kind: 'issue', number: 902, url: 'https://gh/issues/902', title: 'Do the thing', state: 'open',
        createdAt: minsAgo(30), updatedAt: minsAgo(30),
        labels: [{ name: 'ready', appliedAt: minsAgo(20) }] },
    ],
  };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].class, 'wake-not-claimed');
  assert.equal(anomalies[0].label, 'ready');
  assert.equal(anomalies[0].object.number, 902);
  assert.equal(anomalies[0].agentId, 'team-developer');
  assert.ok(anomalies[0].ageMs >= 19 * 60000);
});

test('wake-not-claimed does NOT fire before T1', () => {
  const github = { objects: [
    { kind: 'issue', number: 1, url: 'u', state: 'open', createdAt: minsAgo(10), updatedAt: minsAgo(10),
      labels: [{ name: 'ready', appliedAt: minsAgo(10) }] },
  ] };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies.length, 0, '10 min < 15 min T1');
});

test('wake-not-claimed suppressed once the claim label is present', () => {
  const github = { objects: [
    { kind: 'issue', number: 2, url: 'u', state: 'open', createdAt: minsAgo(30), updatedAt: minsAgo(30),
      labels: [{ name: 'ready', appliedAt: minsAgo(20) }, { name: 'ready:wip', appliedAt: minsAgo(19) }] },
  ] };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies.filter((a) => a.class === 'wake-not-claimed').length, 0);
});

test('wake-not-claimed suppressed when a PR already exists (work started without a claim label)', () => {
  const github = { objects: [
    { kind: 'issue', number: 3, url: 'u', state: 'open', createdAt: minsAgo(60), updatedAt: minsAgo(60),
      labels: [{ name: 'ready', appliedAt: minsAgo(40) }], linkedPrNumbers: [55] },
  ] };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies.filter((a) => a.class === 'wake-not-claimed').length, 0);
});

test('claim-stalled: `ready:wip` claimed past T2 with no activity and no running session', () => {
  const github = { objects: [
    { kind: 'issue', number: 10, url: 'https://gh/issues/10', state: 'open',
      createdAt: hoursAgo(5), updatedAt: hoursAgo(3),
      labels: [{ name: 'ready:wip', appliedAt: hoursAgo(3) }] },
  ] };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].class, 'claim-stalled');
  assert.equal(anomalies[0].agentId, 'team-developer');
});

test('claim-stalled suppressed while the consumer session is running', () => {
  const github = { objects: [
    { kind: 'issue', number: 11, url: 'u', state: 'open', createdAt: hoursAgo(5), updatedAt: hoursAgo(3),
      labels: [{ name: 'ready:wip', appliedAt: hoursAgo(3) }] },
  ] };
  const sessions = { 'team-developer': { running: true, runs: [] } };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions, now: NOW });
  assert.equal(anomalies.length, 0);
});

test('claim-stalled suppressed when there is branch/PR activity', () => {
  const github = { objects: [
    { kind: 'issue', number: 12, url: 'u', state: 'open', createdAt: hoursAgo(5), updatedAt: hoursAgo(3),
      labels: [{ name: 'ready:wip', appliedAt: hoursAgo(3) }], linkedPrNumbers: [77] },
  ] };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies.length, 0);
});

test('#1163: a `ready:completed` ticket is done, never flagged claim-stalled', () => {
  // The success mirror marks a finished claimed run `<wake>:completed`. That is
  // a terminal marker, not an active claim — a finished-but-quiet run must not
  // be mistaken for a stalled one even long past T2.
  const github = { objects: [
    { kind: 'issue', number: 13, url: 'u', state: 'open',
      createdAt: hoursAgo(5), updatedAt: hoursAgo(3),
      labels: [{ name: 'ready:completed', appliedAt: hoursAgo(3) }] },
  ] };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies.length, 0);
});

test('#1163: COMPLETED_SUFFIX does not satisfy the :wip claim test', () => {
  assert.equal('ready:completed'.endsWith(CLAIM_SUFFIX), false);
  assert.equal(COMPLETED_SUFFIX, ':completed');
});

test('output-missing: Merger ran on PR #949 but it never merged / advanced (the #949 dead-end)', () => {
  const github = { objects: [
    { kind: 'pr', number: 949, url: 'https://gh/pull/949', title: 'Merge me', state: 'open',
      createdAt: hoursAgo(4), updatedAt: hoursAgo(1),
      labels: [{ name: 'ready-to-merge', appliedAt: hoursAgo(1) }] },
  ] };
  const sessions = {
    'team-merger': { running: false, runs: [{ kind: 'pr', number: 949, ranAt: minsAgo(50), finishedAt: minsAgo(45), active: false }] },
  };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions, now: NOW });
  const om = anomalies.filter((a) => a.class === 'output-missing');
  assert.equal(om.length, 1);
  assert.equal(om[0].agentId, 'team-merger');
  assert.equal(om[0].object.number, 949);
});

test('output-missing does NOT fire when the consumer produced its outgoing label', () => {
  const github = { objects: [
    { kind: 'pr', number: 20, url: 'u', state: 'open', createdAt: hoursAgo(4), updatedAt: hoursAgo(1),
      labels: [{ name: 'ready-for-review', appliedAt: hoursAgo(2) }, { name: 'ready-to-merge', appliedAt: hoursAgo(1) }] },
  ] };
  // Code Reviewer ran and emitted `ready-to-merge` — forward progress.
  const sessions = {
    'team-code-reviewer': { running: false, runs: [{ kind: 'pr', number: 20, ranAt: hoursAgo(2), active: false }] },
  };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions, now: NOW });
  assert.equal(anomalies.filter((a) => a.class === 'output-missing').length, 0);
});

test('output-missing does NOT fire while the run is still active', () => {
  const github = { objects: [
    { kind: 'pr', number: 21, url: 'u', state: 'open', createdAt: hoursAgo(4), updatedAt: hoursAgo(1),
      labels: [{ name: 'ready-to-merge', appliedAt: hoursAgo(1) }] },
  ] };
  const sessions = { 'team-merger': { running: true, runs: [{ kind: 'pr', number: 21, ranAt: minsAgo(5), active: true }] } };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions, now: NOW });
  assert.equal(anomalies.filter((a) => a.class === 'output-missing').length, 0);
});

test('gate-idle: a human gate pending past T3 nudges (info severity)', () => {
  const github = { objects: [
    { kind: 'issue', number: 30, url: 'https://gh/issues/30', state: 'open',
      createdAt: hoursAgo(40), updatedAt: hoursAgo(40),
      labels: [{ name: 'human-decision-required', appliedAt: hoursAgo(30) }] },
  ] };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].class, 'gate-idle');
  assert.equal(anomalies[0].severity, 'info');
  assert.equal(anomalies[0].agentId, null);
});

test('gate-idle does NOT fire before T3', () => {
  const github = { objects: [
    { kind: 'issue', number: 31, url: 'u', state: 'open', createdAt: hoursAgo(40), updatedAt: hoursAgo(40),
      labels: [{ name: 'human-decision-required', appliedAt: hoursAgo(10) }] },
  ] };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies.length, 0);
});

// ---------------------------------------------------------------------------
// The full 2026-07-29 incident replay — the acceptance scenario
// ---------------------------------------------------------------------------

test('replay: the 2026-07-29 incident classifies #902 as wake-not-claimed and #949 as output-missing', () => {
  const github = {
    objects: [
      // #902: `ready` delivered, Developer started, Claude died on a transient
      // proxy failure — no retry, no visible trace, the wake sits unclaimed.
      { kind: 'issue', number: 902, url: 'https://gh/issues/902', title: 'prompt↔routing label CI lint',
        state: 'open', createdAt: minsAgo(45), updatedAt: minsAgo(45),
        labels: [{ name: 'ready', appliedAt: minsAgo(30) }] },
      // #949: Merger woke, hit a merge conflict, reported it and stopped — no
      // escalation edge, so the chain dead-ends.
      { kind: 'pr', number: 949, url: 'https://gh/pull/949', title: 'Merger PR',
        state: 'open', createdAt: hoursAgo(6), updatedAt: hoursAgo(3),
        labels: [{ name: 'ready-to-merge', appliedAt: hoursAgo(3) }] },
      // A healthy in-flight item — freshly claimed, must NOT be flagged.
      { kind: 'issue', number: 960, url: 'https://gh/issues/960', state: 'open',
        createdAt: minsAgo(8), updatedAt: minsAgo(5),
        labels: [{ name: 'ready', appliedAt: minsAgo(6) }, { name: 'ready:wip', appliedAt: minsAgo(5) }] },
    ],
  };
  const sessions = {
    'team-merger': { running: false, runs: [{ kind: 'pr', number: 949, ranAt: hoursAgo(2), finishedAt: hoursAgo(2), active: false }] },
  };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions, now: NOW });

  const byNumber = Object.fromEntries(anomalies.map((a) => [a.object.number, a]));
  assert.equal(byNumber[902].class, 'wake-not-claimed');
  assert.equal(byNumber[949].class, 'output-missing');
  assert.ok(!byNumber[960], 'the freshly-claimed healthy item is not flagged');
  assert.equal(anomalies.length, 2);
  // Ranked most-actionable first: output-missing outranks wake-not-claimed.
  assert.equal(anomalies[0].class, 'output-missing');
});

test('a healthy flow with everything fresh produces zero anomalies', () => {
  const github = { objects: [
    { kind: 'issue', number: 1, url: 'u', state: 'open', createdAt: minsAgo(5), updatedAt: minsAgo(5),
      labels: [{ name: 'ready', appliedAt: minsAgo(5) }] },
    { kind: 'pr', number: 2, url: 'u', state: 'closed', merged: true, createdAt: hoursAgo(4), updatedAt: hoursAgo(1),
      labels: [{ name: 'ready-to-merge', appliedAt: hoursAgo(3) }] },
  ] };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies.length, 0);
});

test('closed objects are never flagged', () => {
  const github = { objects: [
    { kind: 'issue', number: 5, url: 'u', state: 'closed', createdAt: hoursAgo(4), updatedAt: hoursAgo(3),
      labels: [{ name: 'ready', appliedAt: hoursAgo(3) }] },
  ] };
  const { anomalies } = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies.length, 0);
});

test('thresholds are overridable per team', () => {
  const github = { objects: [
    { kind: 'issue', number: 40, url: 'u', state: 'open', createdAt: minsAgo(10), updatedAt: minsAgo(10),
      labels: [{ name: 'ready', appliedAt: minsAgo(6) }] },
  ] };
  // Default T1 is 15 min → nothing; a 5-min override → flagged.
  assert.equal(detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW }).anomalies.length, 0);
  const tight = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW, thresholds: { wakeNotClaimedMs: 5 * 60000 } });
  assert.equal(tight.anomalies.length, 1);
  assert.equal(tight.thresholds.wakeNotClaimedMs, 5 * 60000);
});

test('detection is deterministic and does not call the wall clock', () => {
  const github = { objects: [
    { kind: 'issue', number: 50, url: 'u', state: 'open', createdAt: minsAgo(30), updatedAt: minsAgo(30),
      labels: [{ name: 'ready', appliedAt: minsAgo(20) }] },
  ] };
  const a = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  const b = detectFlowAnomalies({ model: MODEL, github, sessions: {}, now: NOW });
  assert.deepEqual(a, b);
  assert.equal(a.now, NOW);
});

test('DEFAULT_THRESHOLDS are the documented T1/T2/T3', () => {
  assert.equal(DEFAULT_THRESHOLDS.wakeNotClaimedMs, 15 * 60 * 1000);
  assert.equal(DEFAULT_THRESHOLDS.claimStalledMs, 2 * 60 * 60 * 1000);
  assert.equal(DEFAULT_THRESHOLDS.gateIdleMs, 24 * 60 * 60 * 1000);
});

test('#1004: a terminal/external outcome drops the output-missing expectation', () => {
  // Same #949 dead-end fixture, but the Merger declares a marked outcome —
  // "the merged PR IS the product" — so a run that sets no forward label and
  // opens no PR is legitimate, never an anomaly.
  const membersWithMarker = MEMBERS.map((m) => (m.id === 'team-merger'
    ? { ...m, outcomes: { mode: 'anyOf', options: [
        { id: 'merged', title: 'Merged', actions: [{ type: 'none' }], terminal: true },
      ] } }
    : m));
  const model = buildFlowModel(membersWithMarker, { labels: WAKE_LABELS });
  const github = { objects: [
    { kind: 'pr', number: 949, url: 'https://gh/pull/949', title: 'Merge me', state: 'open',
      createdAt: hoursAgo(4), updatedAt: hoursAgo(1),
      labels: [{ name: 'ready-to-merge', appliedAt: hoursAgo(1) }] },
  ] };
  const sessions = {
    'team-merger': { running: false, runs: [{ kind: 'pr', number: 949, ranAt: minsAgo(50), finishedAt: minsAgo(45), active: false }] },
  };
  const { anomalies } = detectFlowAnomalies({ model, github, sessions, now: NOW });
  assert.equal(anomalies.filter((a) => a.class === 'output-missing').length, 0);
  // The external marker behaves the same.
  const membersExternal = MEMBERS.map((m) => (m.id === 'team-merger'
    ? { ...m, outcomes: { mode: 'anyOf', options: [
        { id: 'handoff', actions: [{ type: 'none' }], external: { note: 'release pipeline' } },
      ] } }
    : m));
  const modelExt = buildFlowModel(membersExternal, { labels: WAKE_LABELS });
  const extRun = detectFlowAnomalies({ model: modelExt, github, sessions, now: NOW });
  assert.equal(extRun.anomalies.filter((a) => a.class === 'output-missing').length, 0);
  // Sanity: without the marker the same fixture still fires (the #949 test above).
  const base = detectFlowAnomalies({ model: MODEL, github, sessions, now: NOW });
  assert.equal(base.anomalies.filter((a) => a.class === 'output-missing').length, 1);
});

// ── #2578: a legacy `transport` field no longer changes the diagnosis ───────
//
// The internal transport (#1175) was removed: a trigger still carrying
// `transport: 'internal'` is an ordinary poller-delivered listener, so its
// wake edge carries no `internal` flag and wake-not-claimed keeps the
// lost-event hypothesis.

const LEGACY_MEMBERS = [
  { id: 'team-dev', displayName: 'Dev', triggers: [
    { id: 't1', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready',
      transport: 'internal', claim: { remove: 'ready', add: 'ready:wip' } },
  ] },
];
const LEGACY_MODEL = buildFlowModel(LEGACY_MEMBERS, { labels: [{ name: 'ready' }] });

test('#2578: buildFlowModel ignores a legacy transport field on a wake edge', () => {
  const edge = LEGACY_MODEL.wakeEdges.find((w) => w.label === 'ready');
  assert.deepEqual(edge.consumers, ['team-dev']);
  assert.equal('internal' in edge, false);
});

test('claim-without-wake is the normal claimed state — no anomaly', () => {
  // The post-claim-swap picture (claim label only, wake label removed) is
  // quiet until claim-stalled's T2, which is about the work, not the delivery.
  const github = { objects: [
    { kind: 'issue', number: 7, url: 'u', state: 'open', createdAt: minsAgo(40), updatedAt: minsAgo(30),
      labels: [{ name: 'ready:wip', appliedAt: minsAgo(30) }] },
  ] };
  for (const model of [LEGACY_MODEL, MODEL]) {
    const { anomalies } = detectFlowAnomalies({ model, github, sessions: {}, now: NOW });
    assert.equal(anomalies.length, 0);
  }
});

test('#2578: wake-not-claimed on a legacy transport listener keeps the lost-event hypothesis', () => {
  const github = { objects: [
    { kind: 'issue', number: 9, url: 'u', state: 'open', createdAt: minsAgo(40), updatedAt: minsAgo(40),
      labels: [{ name: 'ready', appliedAt: minsAgo(30) }] },
  ] };
  const { anomalies } = detectFlowAnomalies({ model: LEGACY_MODEL, github, sessions: {}, now: NOW });
  assert.equal(anomalies[0].class, 'wake-not-claimed');
  assert.match(anomalies[0].message, /may have been lost/);
  assert.doesNotMatch(anomalies[0].message, /internal channel/);
});
