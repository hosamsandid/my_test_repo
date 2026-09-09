'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildFlowModel } = require('./flow-anomaly-detector');
const {
  TICKET_STATES,
  BLOCKER_CODES,
  BLOCKER_RANK,
  ANOMALY_TO_BLOCKER,
  DEFAULT_TICKET_THRESHOLDS,
  entryWakeLabels,
  terminalConsumerIds,
  labelDepths,
  buildTicketModel,
  parseEpicId,
  buildTicketLedger,
  checkSuperseded,
  checkStaleBase,
  checkConflict,
  checkCiRed,
  checkApprovedNotMerged,
  recurrenceFor,
} = require('./ticket-reconciler');

// A fixed clock so every case is deterministic (Date.now() is never called).
const NOW = Date.parse('2026-09-08T12:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

// --- The golden graph -------------------------------------------------------
// The real Agent Studio SDLC flow of concept §1, with THREE dispatch lanes so
// the lane derivation has something to distinguish, and a Merger that emits
// nothing (the §1.1 blind spot).
const MEMBERS = [
  {
    id: 'team-developer',
    displayName: 'Developer',
    emits: ['ready-for-review'],
    github: { producesPr: true },
    triggers: [
      { id: 't-dev-1', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready',
        claim: { remove: 'ready', add: 'ready:wip' } },
      { id: 't-dev-2', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready-2',
        claim: { remove: 'ready-2', add: 'ready-2:wip' } },
    ],
  },
  {
    id: 'team-code-reviewer',
    displayName: 'Code Reviewer',
    emits: ['ready-for-documentation-update', 'revisions-required'],
    triggers: [
      { id: 't-rev', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review',
        claim: { remove: 'ready-for-review', add: 'ready-for-review:wip' } },
    ],
  },
  {
    id: 'team-doc-sync',
    displayName: 'Documentation Sync',
    emits: ['ready-to-merge'],
    triggers: [
      { id: 't-doc', type: 'github-event', events: ['pull_request.labeled'],
        labelFilter: 'ready-for-documentation-update',
        claim: { remove: 'ready-for-documentation-update', add: 'ready-for-documentation-update:wip' } },
    ],
  },
  {
    id: 'team-merger',
    displayName: 'Merger',
    // No emits, no producesPr — its only observable success is a merged PR.
    // This is what makes it the TERMINAL consumer, derived not named.
    triggers: [
      { id: 't-merge', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-to-merge',
        claim: { remove: 'ready-to-merge', add: 'ready-to-merge:wip' } },
    ],
  },
  {
    id: 'team-reworker',
    displayName: 'Reworker',
    emits: ['ready-for-review'],
    triggers: [
      { id: 't-rework', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'revisions-required',
        claim: { remove: 'revisions-required', add: 'revisions-required:wip' } },
    ],
  },
];

const LABELS = [
  { name: 'ready', humanGate: true },
  { name: 'ready-2', humanGate: true },
  { name: 'ready-for-review' },
  { name: 'ready-for-documentation-update' },
  { name: 'ready-to-merge' },
  { name: 'revisions-required' },
  { name: 'req:refine', humanGate: true },
];

const MODEL = buildFlowModel(MEMBERS, { labels: LABELS });

// --- Fixture builders -------------------------------------------------------

function issue(over = {}) {
  return {
    kind: 'issue',
    repo: 'acme/app',
    number: 100,
    url: 'https://github.com/acme/app/issues/100',
    title: 'A ticket',
    body: '',
    state: 'open',
    createdAt: hoursAgo(48),
    updatedAt: hoursAgo(2),
    parentIssueNumber: null,
    labels: [],
    linkedPrNumbers: [],
    ...over,
  };
}

function pr(over = {}) {
  return {
    kind: 'pr',
    repo: 'acme/app',
    number: 200,
    url: 'https://github.com/acme/app/pull/200',
    title: 'Implement the thing',
    body: 'Closes #100',
    state: 'open',
    merged: false,
    draft: false,
    createdAt: hoursAgo(24),
    updatedAt: hoursAgo(1),
    headSha: 'deadbeef',
    baseRef: 'main',
    baseSha: 'cafe',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    checks: 'success',
    failedChecks: [],
    reviewDecision: null,
    approvedAt: null,
    reviewCount: 0,
    baseAheadBy: 0,
    addedFiles: [],
    addedFilesInBase: [],
    baseFileIndexComplete: true,
    labels: [],
    closesIssues: [100],
    linkedPrNumbers: [],
    ...over,
  };
}

function ledger(github, extra = {}) {
  return buildTicketLedger({ model: MODEL, members: MEMBERS, github, now: NOW, ...extra });
}

function one(github, extra = {}) {
  const { tickets } = ledger(github, extra);
  assert.ok(tickets.length >= 1, 'expected at least one ticket');
  return tickets[0];
}

// ---------------------------------------------------------------------------
// Graph derivation — the part that must NOT be name-matching.
// ---------------------------------------------------------------------------

test('entry lanes are the wake labels nobody emits — derived, not named', () => {
  const entries = entryWakeLabels(MODEL, MEMBERS);
  assert.deepStrictEqual([...entries].sort(), ['ready', 'ready-2']);
  // Every other wake label IS emitted by some consumer, so none of them is an entry.
  assert.ok(!entries.has('ready-for-review'));
  assert.ok(!entries.has('ready-to-merge'));
});

test('the terminal consumer is the one that emits nothing and produces nothing', () => {
  assert.deepStrictEqual([...terminalConsumerIds(MODEL)], ['team-merger']);
});

test('label depth increases along the flow graph', () => {
  const d = labelDepths(MODEL, MEMBERS);
  assert.strictEqual(d.get('ready'), 0);
  assert.strictEqual(d.get('ready-2'), 0);
  assert.strictEqual(d.get('ready-for-review'), 1);
  assert.strictEqual(d.get('ready-for-documentation-update'), 2);
  assert.strictEqual(d.get('ready-to-merge'), 3);
});

test('a flow with a different vocabulary yields the same positions', () => {
  // The same shape, none of the same names — nothing may be hardcoded.
  const model = buildFlowModel([
    { id: 'a', displayName: 'A', emits: ['zeta'], github: { producesPr: true },
      triggers: [{ id: '1', type: 'github-event', labelFilter: 'alpha' }] },
    { id: 'b', displayName: 'B', emits: [],
      triggers: [{ id: '2', type: 'github-event', labelFilter: 'zeta' }] },
  ], { labels: [{ name: 'alpha', humanGate: true }, { name: 'zeta' }] });
  const members = [
    { id: 'a', displayName: 'A', emits: ['zeta'], github: { producesPr: true },
      triggers: [{ id: '1', type: 'github-event', labelFilter: 'alpha' }] },
    { id: 'b', displayName: 'B', emits: [],
      triggers: [{ id: '2', type: 'github-event', labelFilter: 'zeta' }] },
  ];
  assert.deepStrictEqual([...entryWakeLabels(model, members)], ['alpha']);
  assert.deepStrictEqual([...terminalConsumerIds(model)], ['b']);
  const tm = buildTicketModel(model, members);
  assert.ok(tm.reachesTerminal.has('zeta'));
});

test('buildTicketModel places the pre-terminal (documentation) stage', () => {
  const tm = buildTicketModel(MODEL, MEMBERS);
  assert.ok(tm.reachesTerminal.has('ready-to-merge'));
  assert.ok(tm.preTerminal.has('ready-for-documentation-update'));
  assert.ok(!tm.preTerminal.has('ready'));
});

// ---------------------------------------------------------------------------
// Epic linkage.
// ---------------------------------------------------------------------------

test('parseEpicId reads the prose forms this team actually writes', () => {
  assert.strictEqual(parseEpicId('Part of the **Flow Control** epic #2112 · design of record'), 2112);
  assert.strictEqual(parseEpicId('Epic: #2076\n\nSomething'), 2076);
  assert.strictEqual(parseEpicId('Part of #2041 phase P0'), 2041);
  assert.strictEqual(parseEpicId('Parent issue #99'), 99);
});

test('parseEpicId returns null rather than guessing', () => {
  assert.strictEqual(parseEpicId('See #2112 for background'), null);
  assert.strictEqual(parseEpicId(''), null);
  assert.strictEqual(parseEpicId(null), null);
});

test('a native sub-issue parent is used when the body says nothing', () => {
  const t = one({ issues: [issue({ parentIssueNumber: 4242 })], prs: [] });
  assert.strictEqual(t.epicId, 4242);
});

// ---------------------------------------------------------------------------
// AC1 — the ledger shape.
// ---------------------------------------------------------------------------

test('AC1: the ledger row carries every field the endpoint contract names', () => {
  const t = one({
    issues: [issue({
      body: 'Part of the Flow Control epic #2112',
      labels: [{ name: 'ready-2:completed', appliedAt: hoursAgo(3) }],
      linkedPrNumbers: [200],
    })],
    prs: [pr({ labels: [{ name: 'ready-for-review', appliedAt: hoursAgo(3) }] })],
  });
  for (const key of [
    'ticketId', 'title', 'epicId', 'lane', 'state', 'ownerAgentId',
    'blocker', 'reasonDetail', 'ageInStateMs', 'prNumber', 'prState', 'evidence',
  ]) {
    assert.ok(key in t, `missing ledger field: ${key}`);
  }
  assert.strictEqual(t.ticketId, 'acme/app#100');
  assert.strictEqual(t.epicId, 2112);
  assert.strictEqual(t.lane, 'ready-2');
  assert.strictEqual(t.prNumber, 200);
  assert.strictEqual(t.prState, 'open');
  assert.ok(Array.isArray(t.evidence) && t.evidence.length > 0);
  assert.ok(TICKET_STATES.includes(t.state));
});

test('the lane survives the dispatch label swapping to :wip and :completed', () => {
  for (const name of ['ready-2', 'ready-2:wip', 'ready-2:completed']) {
    const t = one({ issues: [issue({ labels: [{ name, appliedAt: hoursAgo(1) }] })], prs: [] });
    assert.strictEqual(t.lane, 'ready-2', `lane lost for ${name}`);
  }
});

test('ageInStateMs measures the CURRENT state, not the ticket age', () => {
  const t = one({
    issues: [issue({ createdAt: hoursAgo(200), labels: [{ name: 'ready', appliedAt: hoursAgo(5) }] })],
    prs: [],
  });
  assert.strictEqual(t.ageInStateMs, 5 * 3600000);
});

test('the ledger is deterministic — same snapshot, byte-identical output', () => {
  const snapshot = {
    issues: [issue({ number: 1, labels: [{ name: 'ready', appliedAt: hoursAgo(1) }] }),
      issue({ number: 2, labels: [{ name: 'ready-2', appliedAt: hoursAgo(1) }] })],
    prs: [],
  };
  assert.strictEqual(JSON.stringify(ledger(snapshot)), JSON.stringify(ledger(snapshot)));
});

// ---------------------------------------------------------------------------
// Lifecycle states.
// ---------------------------------------------------------------------------

test('lifecycle: an issue with no flow label at all is backlog', () => {
  const t = one({ issues: [issue({ labels: [{ name: 'enhancement' }] })], prs: [] });
  assert.strictEqual(t.state, 'backlog');
  assert.strictEqual(t.lane, null);
  assert.strictEqual(t.ownerAgentId, null);
});

test('lifecycle: a dispatched-but-unclaimed entry label is ready', () => {
  const t = one({ issues: [issue({ labels: [{ name: 'ready-2', appliedAt: minsAgo(5) }] })], prs: [] });
  assert.strictEqual(t.state, 'ready');
  assert.strictEqual(t.ownerAgentId, 'team-developer');
});

test('lifecycle: a claimed entry label with no PR yet is in-dev', () => {
  const t = one({ issues: [issue({ labels: [{ name: 'ready-2:wip', appliedAt: minsAgo(20) }] })], prs: [] });
  assert.strictEqual(t.state, 'in-dev');
});

test('lifecycle: a non-entry human gate with no PR is refining', () => {
  const t = one({ issues: [issue({ labels: [{ name: 'req:refine', appliedAt: hoursAgo(1) }] })], prs: [] });
  assert.strictEqual(t.state, 'refining');
});

test('lifecycle: an open PR at the review stage is in-review', () => {
  const t = one({
    issues: [issue({ labels: [{ name: 'ready-2:completed', appliedAt: minsAgo(10) }], linkedPrNumbers: [200] })],
    prs: [pr({ labels: [{ name: 'ready-for-review', appliedAt: minsAgo(10) }] })],
  });
  assert.strictEqual(t.state, 'in-review');
  assert.strictEqual(t.ownerAgentId, 'team-code-reviewer');
});

test('lifecycle: CHANGES_REQUESTED is rework, whatever the labels say', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    // The label still claims the review stage; the review itself is the evidence.
    prs: [pr({ reviewDecision: 'CHANGES_REQUESTED', reviewCount: 1,
      labels: [{ name: 'ready-for-review', appliedAt: hoursAgo(1) }] })],
  });
  assert.strictEqual(t.state, 'rework');
});

test('lifecycle: the pre-terminal stage is doc', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({ labels: [{ name: 'ready-for-documentation-update', appliedAt: minsAgo(10) }] })],
  });
  assert.strictEqual(t.state, 'doc');
  assert.strictEqual(t.ownerAgentId, 'team-doc-sync');
});

test('lifecycle: reaching the terminal consumer is mergeable', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({ labels: [{ name: 'ready-to-merge', appliedAt: minsAgo(10) }] })],
  });
  assert.strictEqual(t.state, 'mergeable');
  assert.strictEqual(t.ownerAgentId, 'team-merger');
});

test('lifecycle: approved + green is mergeable even with no merge label', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({ reviewDecision: 'APPROVED', approvedAt: minsAgo(10), reviewCount: 1 })],
  });
  assert.strictEqual(t.state, 'mergeable');
});

test('lifecycle: a closed issue is done', () => {
  const t = one({ issues: [issue({ state: 'closed' })], prs: [] });
  assert.strictEqual(t.state, 'done');
});

// ---------------------------------------------------------------------------
// AC2 — `superseded`.
// ---------------------------------------------------------------------------

test('AC2: superseded flags a duplicate whose added files already exist in main', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({
      addedFiles: ['orchestrator/ticket-reconciler.js', 'orchestrator/ticket-reconciler.test.js'],
      addedFilesInBase: ['orchestrator/ticket-reconciler.js', 'orchestrator/ticket-reconciler.test.js'],
      baseFileIndexComplete: true,
    })],
  });
  assert.strictEqual(t.blocker, 'superseded');
  assert.strictEqual(t.needsHuman, true);
  assert.match(t.reasonDetail, /already exists on `main`/);
  assert.ok(t.evidence.some((e) => e.type === 'file'));
});

test('AC2: one genuinely new file means it is NOT superseded', () => {
  assert.strictEqual(checkSuperseded(pr({
    addedFiles: ['a.js', 'b.js'],
    addedFilesInBase: ['a.js'],
  })), null);
});

test('AC2: a PR that only modifies files is never superseded', () => {
  assert.strictEqual(checkSuperseded(pr({ addedFiles: [], addedFilesInBase: [] })), null);
});

test('AC2: a truncated base index refuses to accuse — no finding, not a false one', () => {
  assert.strictEqual(checkSuperseded(pr({
    addedFiles: ['a.js'],
    addedFilesInBase: ['a.js'],
    baseFileIndexComplete: false,
  })), null);
});

// ---------------------------------------------------------------------------
// AC3 — `stale-base`.
// ---------------------------------------------------------------------------

test('AC3: stale-base flags a PR that text-merges but fails against current main', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({ mergeable: 'MERGEABLE', checks: 'failure', failedChecks: ['api tests'], baseAheadBy: 7 })],
  });
  assert.strictEqual(t.blocker, 'stale-base');
  assert.match(t.reasonDetail, /7 commits ahead/);
  assert.match(t.reasonDetail, /rebase/);
});

test('AC3: red checks on an UNMOVED base is ci-red, not stale-base', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({ mergeable: 'MERGEABLE', checks: 'failure', failedChecks: ['api tests'], baseAheadBy: 0 })],
  });
  assert.strictEqual(t.blocker, 'ci-red');
  assert.match(t.reasonDetail, /api tests/);
});

test('AC3: a conflicting PR is conflict, never stale-base', () => {
  const p = pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', checks: 'failure', baseAheadBy: 9 });
  assert.strictEqual(checkStaleBase(p), null);
  assert.strictEqual(checkConflict(p).code, 'conflict');
});

test('AC3: GitHub\'s own BEHIND state is accepted as the base-moved half', () => {
  const b = checkStaleBase(pr({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', checks: 'success', baseAheadBy: null }));
  assert.strictEqual(b.code, 'stale-base');
});

test('AC3: an UNKNOWN mergeability declines rather than guessing', () => {
  assert.strictEqual(checkStaleBase(pr({ mergeable: 'UNKNOWN', checks: 'failure', baseAheadBy: 5 })), null);
  assert.strictEqual(checkConflict(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })), null);
});

// ---------------------------------------------------------------------------
// AC4 — `claimed-done-not-merged`, the §1.1 blind spot.
// ---------------------------------------------------------------------------

test('AC4: a terminal consumer claiming done over an open PR is flagged', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({ labels: [{ name: 'ready-to-merge:completed', appliedAt: hoursAgo(4) }] })],
  });
  assert.strictEqual(t.blocker, 'claimed-done-not-merged');
  assert.match(t.reasonDetail, /still open and unmerged/);
  assert.match(t.reasonDetail, /Merger/);
});

test('AC4: a healthy hand-off is NOT flagged — the flow moved on', () => {
  // Developer completed AND the review label it emits is present. This is the
  // false positive the naive "`:completed` + open PR" rule would produce on
  // every single healthy ticket in the flow.
  const t = one({
    issues: [issue({ labels: [{ name: 'ready-2:completed', appliedAt: hoursAgo(4) }], linkedPrNumbers: [200] })],
    prs: [pr({ labels: [{ name: 'ready-for-review', appliedAt: hoursAgo(4) }] })],
  });
  assert.notStrictEqual(t.blocker, 'claimed-done-not-merged');
});

test('AC4: a mid-flow consumer that completed and emitted nothing IS flagged', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({ labels: [{ name: 'ready-for-review:completed', appliedAt: hoursAgo(4) }] })],
  });
  assert.strictEqual(t.blocker, 'claimed-done-not-merged');
  assert.match(t.reasonDetail, /ready-for-documentation-update/);
});

test('AC4: the grace window keeps a just-completed hand-off quiet', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({ labels: [{ name: 'ready-to-merge:completed', appliedAt: minsAgo(5) }] })],
  });
  assert.notStrictEqual(t.blocker, 'claimed-done-not-merged');
  assert.ok(DEFAULT_TICKET_THRESHOLDS.claimedDoneMs > 5 * 60000);
});

test('AC4: no open PR means there is nothing to contradict the claim', () => {
  const t = one({
    issues: [issue({ labels: [{ name: 'ready-to-merge:completed', appliedAt: hoursAgo(8) }] })],
    prs: [],
  });
  assert.notStrictEqual(t.blocker, 'claimed-done-not-merged');
});

test('AC4: a merged PR clears the claim — GitHub agrees with the label', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({ merged: true, labels: [{ name: 'ready-to-merge:completed', appliedAt: hoursAgo(8) }] })],
  });
  assert.strictEqual(t.state, 'done');
  assert.notStrictEqual(t.blocker, 'claimed-done-not-merged');
});

// ---------------------------------------------------------------------------
// The remaining blocker codes.
// ---------------------------------------------------------------------------

test('approved-not-merged only fires past its threshold', () => {
  const fresh = pr({ reviewDecision: 'APPROVED', approvedAt: minsAgo(30) });
  assert.strictEqual(checkApprovedNotMerged(fresh, NOW, DEFAULT_TICKET_THRESHOLDS), null);
  const stale = pr({ reviewDecision: 'APPROVED', approvedAt: hoursAgo(6) });
  assert.strictEqual(checkApprovedNotMerged(stale, NOW, DEFAULT_TICKET_THRESHOLDS).code, 'approved-not-merged');
});

test('approved-not-merged declines when the PR is red or conflicting', () => {
  const red = pr({ reviewDecision: 'APPROVED', approvedAt: hoursAgo(6), checks: 'failure' });
  assert.strictEqual(checkApprovedNotMerged(red, NOW, DEFAULT_TICKET_THRESHOLDS), null);
});

test('ci-red names the failing checks', () => {
  const b = checkCiRed(pr({ checks: 'failure', failedChecks: ['api tests', 'CodeQL'] }));
  assert.match(b.reasonDetail, /api tests/);
  assert.match(b.reasonDetail, /CodeQL/);
});

test('orphaned: a flow label no agent listens for', () => {
  // `ready-3` exists on the ticket but this team has no listener for it.
  const model = buildFlowModel(MEMBERS, { labels: [...LABELS, { name: 'ready-3', humanGate: true }] });
  const { tickets } = buildTicketLedger({
    model, members: MEMBERS,
    github: { issues: [issue({ labels: [{ name: 'ready-3', appliedAt: hoursAgo(3) }] })], prs: [] },
    now: NOW,
  });
  // A gate label with no wake edge parks the ticket on `needs-human`, which is
  // the honest reading: a human applies it and a human is who it waits for.
  assert.strictEqual(tickets[0].blocker, 'needs-human');
});

test('orphaned: a PR that closes no issue and carries no flow label', () => {
  const t = one({ issues: [], prs: [pr({ body: 'no linkage at all', closesIssues: [], labels: [] })] });
  assert.strictEqual(t.kind, 'pr');
  assert.strictEqual(t.blocker, 'orphaned');
  assert.strictEqual(t.needsHuman, true);
});

test('a PR claimed by an issue is not also listed as its own ticket', () => {
  const { tickets } = ledger({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr()],
  });
  assert.strictEqual(tickets.length, 1);
  assert.strictEqual(tickets[0].kind, 'issue');
});

test('needs-human reports a human gate the flow is legitimately parked on', () => {
  const t = one({ issues: [issue({ labels: [{ name: 'req:refine', appliedAt: hoursAgo(30) }] })], prs: [] });
  assert.strictEqual(t.blocker, 'needs-human');
  assert.strictEqual(t.needsHuman, true);
  assert.strictEqual(t.state, 'refining');
});

// ---------------------------------------------------------------------------
// Precedence, linkage, folding.
// ---------------------------------------------------------------------------

test('every blocker code has a rank, and superseded outranks everything', () => {
  for (const c of BLOCKER_CODES) assert.ok(BLOCKER_RANK[c] > 0, `no rank for ${c}`);
  const others = BLOCKER_CODES.filter((c) => c !== 'superseded').map((c) => BLOCKER_RANK[c]);
  assert.ok(BLOCKER_RANK.superseded > Math.max(...others));
});

test('precedence: superseded wins over conflict and ci-red on the same PR', () => {
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({
      mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', checks: 'failure', failedChecks: ['x'],
      addedFiles: ['a.js'], addedFilesInBase: ['a.js'], baseFileIndexComplete: true,
    })],
  });
  assert.strictEqual(t.blocker, 'superseded');
  // The weaker findings are still reported — the ledger names one blocker but
  // hides nothing.
  assert.ok(t.blockers.includes('conflict'));
  assert.ok(t.blockers.includes('ci-red'));
});

test('strict `Closes #n` linkage beats a loose reference for attribution', () => {
  const { tickets } = ledger({
    issues: [issue({ number: 100, linkedPrNumbers: [201] })],
    prs: [
      pr({ number: 200, closesIssues: [100] }),
      pr({ number: 201, closesIssues: [] }), // merely mentions #100 somewhere
    ],
  });
  const t = tickets.find((x) => x.number === 100);
  assert.strictEqual(t.prNumber, 200);
  assert.strictEqual(t.prLinkage, 'closes');
});

test('a loose reference is used when nothing strict exists', () => {
  const { tickets } = ledger({
    issues: [issue({ number: 100, linkedPrNumbers: [201] })],
    prs: [pr({ number: 201, closesIssues: [] })],
  });
  const t = tickets.find((x) => x.number === 100);
  assert.strictEqual(t.prNumber, 201);
  assert.strictEqual(t.prLinkage, 'reference');
});

test('the four shipped anomaly classes fold in as one input signal', () => {
  const anomalies = [
    { class: 'wake-not-claimed', object: { kind: 'issue', number: 100 }, ageMs: 3600000, message: 'never claimed' },
  ];
  const t = one({ issues: [issue({ labels: [{ name: 'ready-2', appliedAt: hoursAgo(1) }] })], prs: [] }, { anomalies });
  assert.strictEqual(t.blocker, ANOMALY_TO_BLOCKER['wake-not-claimed']);
  assert.strictEqual(t.blocker, 'unclaimed');
  assert.strictEqual(t.anomalies.length, 1);
  assert.match(t.reasonDetail, /never claimed/);
});

test('a hard GitHub fact outranks a folded anomaly on the same ticket', () => {
  const anomalies = [
    { class: 'claim-stalled', object: { kind: 'issue', number: 100 }, ageMs: 7200000, message: 'stalled' },
  ];
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })],
  }, { anomalies });
  assert.strictEqual(t.blocker, 'conflict');
  assert.ok(t.blockers.includes('stalled'));
});

test('an anomaly raised against the linked PR reaches the issue ticket', () => {
  const anomalies = [
    { class: 'gate-idle', object: { kind: 'pr', number: 200 }, ageMs: 90000000, message: 'gate idle' },
  ];
  const t = one({
    issues: [issue({ linkedPrNumbers: [200] })],
    prs: [pr()],
  }, { anomalies });
  assert.ok(t.anomalies.some((a) => a.class === 'gate-idle'));
});

test('recurrence counts past sightings from the anomaly-history substrate', () => {
  const history = [
    { ts: hoursAgo(6), anomalies: [{ object: { kind: 'issue', number: 100 } }] },
    { ts: hoursAgo(4), anomalies: [{ object: { kind: 'issue', number: 999 } }] },
    { ts: hoursAgo(2), anomalies: [{ object: { kind: 'issue', number: 100 } }] },
  ];
  assert.deepStrictEqual(recurrenceFor(history, 'issue', 100), {
    sightings: 2, firstSeenAt: hoursAgo(6),
  });
  assert.strictEqual(recurrenceFor(history, 'issue', 7).sightings, 0);
  assert.strictEqual(recurrenceFor(undefined, 'issue', 100).sightings, 0);
});

test('the ledger sorts most-actionable first', () => {
  const { tickets } = ledger({
    issues: [
      issue({ number: 1, labels: [{ name: 'ready', appliedAt: minsAgo(1) }] }),          // healthy
      issue({ number: 2, linkedPrNumbers: [200] }),                                      // conflict
      issue({ number: 3, linkedPrNumbers: [201] }),                                      // superseded
    ],
    prs: [
      pr({ number: 200, closesIssues: [2], mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
      pr({ number: 201, closesIssues: [3], addedFiles: ['a.js'], addedFilesInBase: ['a.js'] }),
    ],
  });
  assert.deepStrictEqual(tickets.map((t) => t.blocker), ['superseded', 'conflict', null]);
});

// ---------------------------------------------------------------------------
// Robustness — a sweep that could not read something must never fabricate.
// ---------------------------------------------------------------------------

test('an empty snapshot yields an empty ledger, not a throw', () => {
  assert.deepStrictEqual(buildTicketLedger({ model: MODEL, github: {}, now: NOW }).tickets, []);
  assert.deepStrictEqual(buildTicketLedger({}).tickets, []);
});

test('a ticket with no timestamps anywhere reports a null age, never NaN', () => {
  const t = one({
    issues: [issue({ createdAt: null, updatedAt: null, labels: [{ name: 'ready', appliedAt: null }] })],
    prs: [],
  });
  assert.strictEqual(t.ageInStateMs, null);
  assert.strictEqual(t.stateSince, null);
});

test('every state a fixture can produce is in the declared vocabulary', () => {
  const { tickets } = ledger({
    issues: [
      issue({ number: 1, labels: [] }),
      issue({ number: 2, labels: [{ name: 'req:refine', appliedAt: hoursAgo(1) }] }),
      issue({ number: 3, labels: [{ name: 'ready', appliedAt: hoursAgo(1) }] }),
      issue({ number: 4, labels: [{ name: 'ready:wip', appliedAt: hoursAgo(1) }] }),
      issue({ number: 5, state: 'closed' }),
    ],
    prs: [],
  });
  for (const t of tickets) assert.ok(TICKET_STATES.includes(t.state), `bad state ${t.state}`);
});
