'use strict';

// Unit tests for the pure admission-control core (#2114, flow-control §4.0).
//
// The four acceptance criteria of #2114 map onto these sections:
//   AC1 second dispatch is held until the first ticket is truly done → "the lane"
//   AC2 the count is platform-computed, verifiable without an agent → "reconcile"
//   AC3 a held dispatch is not lost, it fires when capacity frees → "promotion"
//   AC4 pure core unit-tested; no wipLimit = today's behaviour → "back-compat"

const { test } = require('node:test');
const assert = require('node:assert');

const ac = require('./admission-control');

const REPO = 'acme/app';
const T0 = Date.parse('2026-09-08T12:00:00.000Z');

// A pending-queue entry exactly as the poller builds it (github-poller `_enqueue`).
function issueEntry(number, { label = 'ready', triggerId = 't1', eventId = null } = {}) {
  const id = eventId || `e-issue-${number}`;
  return {
    triggerId,
    github: {
      event: 'issues.labeled',
      eventId: id,
      repo: REPO,
      payload: { action: 'labeled', label: { name: label }, issue: { number, labels: [{ name: label }] } },
    },
  };
}

function prEntry(number, { closes = [], triggerId = 't2', eventId = null } = {}) {
  const id = eventId || `e-pr-${number}-${closes.join('.')}`;
  return {
    triggerId,
    github: {
      event: 'pull_request.labeled',
      eventId: id,
      repo: REPO,
      payload: { action: 'labeled', pull_request: { number, closesIssues: closes } },
    },
  };
}

// ─── entryTicketRef: which ticket is this dispatch about? ────────────────────

test('entryTicketRef: an issue event resolves to that issue', () => {
  assert.deepEqual(ac.entryTicketRef(issueEntry(42)), { repo: REPO, ticket: 42, refs: [42] });
});

test('entryTicketRef: a PR event keys on the issue it closes, not on the PR', () => {
  // The whole reason `wipLimit: 1` does not deadlock on its own first hand-off:
  // the developer's PR belongs to the ticket the dispatcher opened the lane for.
  assert.deepEqual(ac.entryTicketRef(prEntry(77, { closes: [42] })), {
    repo: REPO, ticket: 42, refs: [42, 77],
  });
});

test('entryTicketRef: a PR with no closing keyword is its own ticket', () => {
  assert.deepEqual(ac.entryTicketRef(prEntry(77)), { repo: REPO, ticket: 77, refs: [77] });
});

test('entryTicketRef: an issue_comment on a PR is PR-shaped', () => {
  const entry = {
    triggerId: 't', github: {
      event: 'issue_comment.created', eventId: 'e', repo: REPO,
      payload: { issue: { number: 77, pull_request: { url: 'x' }, closesIssues: [42] } },
    },
  };
  assert.deepEqual(ac.entryTicketRef(entry), { repo: REPO, ticket: 42, refs: [42, 77] });
});

test('entryTicketRef: control traffic carries no ticket', () => {
  // Every non-github kind the pending queue holds — these must never be gated.
  assert.equal(ac.entryTicketRef({ triggerId: 'cron-1' }), null);
  assert.equal(ac.entryTicketRef({ kind: 'session-reset' }), null);
  assert.equal(ac.entryTicketRef({ kind: 'handover-dm', text: 'hi' }), null);
  assert.equal(ac.entryTicketRef({ kind: 'wake-agent', fromAgentId: 'a' }), null);
  assert.equal(ac.entryTicketRef({ github: { repo: REPO, payload: {} } }), null);
  assert.equal(ac.entryTicketRef(null), null);
});

// ─── back-compat: no wipLimit = today's behaviour (AC4) ──────────────────────

test('back-compat: with no wipLimit every dispatch is admitted and the lane is untouched', () => {
  for (const limit of [undefined, null, 0, -1, 1.5, '1', {}]) {
    const lane = ac.emptyLane();
    const r = ac.admit({ lane, wipLimit: limit, agentId: 'dev', entry: issueEntry(1), now: T0 });
    assert.equal(r.admit, true, `limit=${JSON.stringify(limit)}`);
    assert.equal(r.reason, 'no-limit');
    // The SAME object comes back — an ungated flow never grows a lane record.
    assert.equal(r.lane, lane);
    assert.deepEqual(lane, ac.emptyLane());
  }
});

test('back-compat: limitInForce accepts only positive integers', () => {
  assert.equal(ac.limitInForce(1), 1);
  assert.equal(ac.limitInForce(3), 3);
  for (const bad of [0, -1, 1.5, null, undefined, '2', NaN, Infinity]) {
    assert.equal(ac.limitInForce(bad), null, String(bad));
  }
});

test('back-compat: control traffic is admitted even under a limit, with the lane full', () => {
  const full = ac.admit({ lane: ac.emptyLane(), wipLimit: 1, agentId: 'dev', entry: issueEntry(1), now: T0 }).lane;
  const r = ac.admit({ lane: full, wipLimit: 1, agentId: 'dev', entry: { kind: 'session-reset' }, now: T0 });
  assert.equal(r.admit, true);
  assert.equal(r.reason, 'not-a-flow-dispatch');
  assert.equal(r.lane, full);
});

// ─── the lane: hold at the limit (AC1) ──────────────────────────────────────

test('wipLimit 1: the first ticket is admitted, a second ticket is held', () => {
  const first = ac.admit({ lane: ac.emptyLane(), wipLimit: 1, agentId: 'dev', entry: issueEntry(42), now: T0 });
  assert.equal(first.admit, true);
  assert.equal(first.reason, 'capacity');
  assert.deepEqual(first.lane.inFlight.map(t => t.key), [`${REPO}#42`]);

  const second = ac.admit({ lane: first.lane, wipLimit: 1, agentId: 'dev', entry: issueEntry(43), now: T0 + 1000 });
  assert.equal(second.admit, false);
  assert.equal(second.reason, 'at-limit');
  assert.deepEqual(second.lane.inFlight.map(t => t.key), [`${REPO}#42`], 'the lane did not grow');
  assert.equal(second.lane.held.length, 1);
  assert.deepEqual(second.lane.held[0].entry, issueEntry(43), 'the entry is held verbatim');
  assert.equal(second.lane.held[0].ticket, `${REPO}#43`);
});

test('wipLimit 2 admits two tickets and holds the third', () => {
  let lane = ac.emptyLane();
  for (const n of [1, 2]) {
    const r = ac.admit({ lane, wipLimit: 2, agentId: 'dev', entry: issueEntry(n), now: T0 });
    assert.equal(r.admit, true, `#${n}`);
    lane = r.lane;
  }
  const third = ac.admit({ lane, wipLimit: 2, agentId: 'dev', entry: issueEntry(3), now: T0 });
  assert.equal(third.admit, false);
  assert.equal(third.lane.inFlight.length, 2);
});

test('a same-ticket hand-off is admitted with the lane full — the flow does not deadlock', () => {
  // dispatcher labels issue 42 → developer runs → opens PR 77 (Closes #42) →
  // the reviewer's wake must go through even though wipLimit is 1.
  const admitted = ac.admit({ lane: ac.emptyLane(), wipLimit: 1, agentId: 'dev', entry: issueEntry(42), now: T0 });
  const handoff = ac.admit({
    lane: admitted.lane, wipLimit: 1, agentId: 'reviewer',
    entry: prEntry(77, { closes: [42] }), now: T0 + 60_000,
  });
  assert.equal(handoff.admit, true);
  assert.equal(handoff.reason, 'same-ticket');
  assert.equal(handoff.lane.inFlight.length, 1, 'still one ticket in flight');
  assert.deepEqual(handoff.lane.inFlight[0].objects.sort(), [`${REPO}#42`, `${REPO}#77`]);

  // …and the next event about the PR alone (no closesIssues on it) now also
  // resolves to the same ticket, because the PR joined the ticket's objects.
  const later = ac.admit({
    lane: handoff.lane, wipLimit: 1, agentId: 'merger',
    entry: prEntry(77, { triggerId: 't3', eventId: 'e3' }), now: T0 + 120_000,
  });
  assert.equal(later.admit, true);
  assert.equal(later.reason, 'same-ticket');
});

test('#2114 regression: a synthetic internal PR hand-off carries closesIssues, so it admits same-ticket rather than deadlocking', () => {
  // The prior admission-control tests hand-craft `closesIssues` via prEntry(),
  // so they never exercised the real synthetic-event builders. This drives the
  // exact reviewer repro: an internal-transport reviewer-wake (developer → PR →
  // reviewer) is the FIRST admission-gated reference to PR 77, built by
  // flow-emit's real `buildSyntheticEvent`/`buildPendingEntry`, with issue 42
  // already occupying the only slot.
  const flowEmit = require('./flow-emit');
  const key = flowEmit.eventKeyForKind('pr');
  const iso = new Date(T0).toISOString();
  const admitted = ac.admit({ lane: ac.emptyLane(), wipLimit: 1, agentId: 'dev', entry: issueEntry(42), now: T0 });

  // The BUG shape — a synthetic PR event with NO closesIssues (what the two
  // producers built before this fix): mis-keys as a brand-new ticket and is held
  // forever, deadlocking the flow (the first ticket never finishes because its
  // finisher is stuck in the hold queue).
  const bugEvent = flowEmit.buildSyntheticEvent({
    repo: REPO, label: 'ready-for-review', kind: 'pr', number: 77,
    producerId: 'dev', eventId: 'int:bug', now: iso,
  });
  const held = ac.admit({ lane: admitted.lane, wipLimit: 1, agentId: 'reviewer',
    entry: flowEmit.buildPendingEntry('t-bug', key, bugEvent), now: T0 + 60_000 });
  assert.equal(held.admit, false, 'without closesIssues the hand-off is wrongly a new ticket (the bug)');

  // The FIXED shape — the caller now threads the strict `closesIssues` (parsed
  // from the PR body/branch it already fetched) into the builder, so admission
  // keys the hand-off to issue 42's ticket and lets it through.
  const fixedEvent = flowEmit.buildSyntheticEvent({
    repo: REPO, label: 'ready-for-review', kind: 'pr', number: 77, closesIssues: [42],
    producerId: 'dev', eventId: 'int:fix', now: iso,
  });
  assert.deepEqual(fixedEvent.payload.pull_request.closesIssues, [42],
    'the builder propagates closesIssues onto the PR subject');
  const handoff = ac.admit({ lane: admitted.lane, wipLimit: 1, agentId: 'reviewer',
    entry: flowEmit.buildPendingEntry('t-fix', key, fixedEvent), now: T0 + 60_000 });
  assert.equal(handoff.admit, true, 'with closesIssues the hand-off resolves to the issue ticket');
  assert.equal(handoff.reason, 'same-ticket');
  assert.equal(handoff.lane.inFlight.length, 1, 'still one ticket in flight — no deadlock');
});

test('a re-delivered event is not held twice', () => {
  const full = ac.admit({ lane: ac.emptyLane(), wipLimit: 1, agentId: 'dev', entry: issueEntry(42), now: T0 }).lane;
  const e = issueEntry(43, { eventId: 'dup' });
  const once = ac.admit({ lane: full, wipLimit: 1, agentId: 'dev', entry: e, now: T0 });
  const twice = ac.admit({ lane: once.lane, wipLimit: 1, agentId: 'dev', entry: e, now: T0 + 5 });
  assert.equal(twice.lane.held.length, 1);
  // A DIFFERENT agent woken by the same event is a different dispatch.
  const other = ac.admit({ lane: twice.lane, wipLimit: 1, agentId: 'reviewer', entry: e, now: T0 + 6 });
  assert.equal(other.lane.held.length, 2);
});

test('admit never mutates the lane it was given', () => {
  const lane = ac.admit({ lane: ac.emptyLane(), wipLimit: 1, agentId: 'dev', entry: issueEntry(42), now: T0 }).lane;
  const before = JSON.stringify(lane);
  ac.admit({ lane, wipLimit: 1, agentId: 'dev', entry: issueEntry(43), now: T0 });
  ac.admit({ lane, wipLimit: 1, agentId: 'dev', entry: prEntry(77, { closes: [42] }), now: T0 });
  assert.equal(JSON.stringify(lane), before);
});

// ─── activeFlowLabels ───────────────────────────────────────────────────────

test('activeFlowLabels takes wake, claim and gate labels but never :completed', () => {
  const model = {
    wakeEdges: [{ label: 'ready', claimLabel: 'ready:wip' }, { label: 'ready-for-review', claimLabel: 'ready-for-review:wip' }],
    claimEdges: [{ claimLabel: 'ready-to-merge:wip' }],
    gateLabels: new Set(['needs-human']),
  };
  const s = ac.activeFlowLabels(model);
  assert.deepEqual([...s].sort(), [
    'needs-human', 'ready', 'ready-for-review', 'ready-for-review:wip', 'ready-to-merge:wip', 'ready:wip',
  ]);
  assert.equal(s.has('ready:completed'), false);
});

test('activeFlowLabels drops an explicitly :completed entry and tolerates a junk model', () => {
  const s = ac.activeFlowLabels({ wakeEdges: [{ label: 'ready:completed', claimLabel: '' }], gateLabels: ['gate'] });
  assert.deepEqual([...s], ['gate']);
  assert.deepEqual([...ac.activeFlowLabels(null)], []);
});

// ─── reconcile from GitHub truth (AC2) ──────────────────────────────────────

const ACTIVE = new Set(['ready', 'ready:wip', 'ready-for-review', 'needs-human']);

function laneWith(number, { admittedAt = new Date(T0).toISOString(), objects = [] } = {}) {
  return {
    version: 1, updatedAt: null, held: [],
    inFlight: [{ key: `${REPO}#${number}`, repo: REPO, number, admittedAt, objects }],
  };
}

// Well past the grace window, so only GitHub truth decides.
const LATER = T0 + 60 * 60 * 1000;

test('reconcile: an open issue carrying an active flow label stays in flight', () => {
  const snapshot = { repos: [REPO], objects: [{ repo: REPO, number: 42, kind: 'issue', labels: ['ready:wip'], closes: [] }] };
  const r = ac.reconcileInFlight({ lane: laneWith(42), snapshot, activeLabels: ACTIVE, now: LATER });
  assert.equal(r.lane.inFlight.length, 1);
  assert.deepEqual(r.released, []);
});

test('reconcile: an open PR referencing the ticket keeps it in flight even with no label on the issue', () => {
  // The state after the developer finishes: issue carries only `ready:completed`,
  // the work lives on the open PR.
  const snapshot = {
    repos: [REPO],
    objects: [
      { repo: REPO, number: 42, kind: 'issue', labels: ['ready:completed'], closes: [] },
      { repo: REPO, number: 77, kind: 'pr', labels: ['ready-for-review'], closes: [42] },
    ],
  };
  const r = ac.reconcileInFlight({ lane: laneWith(42), snapshot, activeLabels: ACTIVE, now: LATER });
  assert.equal(r.lane.inFlight.length, 1);
  assert.ok(r.lane.inFlight[0].objects.includes(`${REPO}#77`), 'the PR is learned as part of the ticket');
});

test('reconcile: a stuck ticket holds the lane — a conflicting PR and a needs-human gate both count', () => {
  // §4.0: a stuck in-flight ticket never permits a second dispatch to route
  // around it. Neither of these two states releases the slot.
  const conflicting = {
    repos: [REPO],
    objects: [{ repo: REPO, number: 77, kind: 'pr', labels: [], closes: [42] }],
  };
  assert.equal(ac.reconcileInFlight({ lane: laneWith(42), snapshot: conflicting, activeLabels: ACTIVE, now: LATER }).released.length, 0);

  const gated = {
    repos: [REPO],
    objects: [{ repo: REPO, number: 42, kind: 'issue', labels: ['needs-human'], closes: [] }],
  };
  assert.equal(ac.reconcileInFlight({ lane: laneWith(42), snapshot: gated, activeLabels: ACTIVE, now: LATER }).released.length, 0);
});

test('reconcile: a merged PR and a closed issue release the lane', () => {
  // Both objects are gone from the open-only snapshot — "truly done".
  const snapshot = { repos: [REPO], objects: [] };
  const r = ac.reconcileInFlight({ lane: laneWith(42), snapshot, activeLabels: ACTIVE, now: LATER });
  assert.deepEqual(r.lane.inFlight, []);
  assert.deepEqual(r.released, [{ key: `${REPO}#42`, reason: 'closed' }]);
});

test('reconcile: an issue left open with only terminal labels and no PR is released', () => {
  const snapshot = { repos: [REPO], objects: [{ repo: REPO, number: 42, kind: 'issue', labels: ['ready:completed', 'enhancement'], closes: [] }] };
  const r = ac.reconcileInFlight({ lane: laneWith(42), snapshot, activeLabels: ACTIVE, now: LATER });
  assert.deepEqual(r.released, [{ key: `${REPO}#42`, reason: 'no-active-label' }]);
});

test('reconcile: fails CLOSED — an unswept repo keeps its slot and is marked unverified', () => {
  const snapshot = { repos: [], objects: [] }; // the GitHub call failed
  const r = ac.reconcileInFlight({ lane: laneWith(42), snapshot, activeLabels: ACTIVE, now: LATER });
  assert.equal(r.lane.inFlight.length, 1);
  assert.equal(r.lane.inFlight[0].unverified, true);
  assert.deepEqual(r.released, []);
});

test('reconcile: the unverified mark clears once the repo is swept again', () => {
  const lane = laneWith(42);
  lane.inFlight[0].unverified = true;
  const snapshot = { repos: [REPO], objects: [{ repo: REPO, number: 42, kind: 'issue', labels: ['ready'], closes: [] }] };
  const r = ac.reconcileInFlight({ lane, snapshot, activeLabels: ACTIVE, now: LATER });
  assert.equal('unverified' in r.lane.inFlight[0], false);
});

test('reconcile: the grace window holds a just-admitted ticket GitHub has not caught up with', () => {
  // An internal-channel emit mirrors its label asynchronously; without the grace
  // window the tick between the emit and the mirror would open the lane.
  const snapshot = { repos: [REPO], objects: [] };
  const fresh = ac.reconcileInFlight({ lane: laneWith(42), snapshot, activeLabels: ACTIVE, now: T0 + 1000 });
  assert.equal(fresh.lane.inFlight.length, 1, 'inside the grace window');
  assert.equal('unverified' in fresh.lane.inFlight[0], false);

  const aged = ac.reconcileInFlight({ lane: laneWith(42), snapshot, activeLabels: ACTIVE, now: T0 + ac.DEFAULT_GRACE_MS + 1 });
  assert.equal(aged.lane.inFlight.length, 0, 'grace is a minimum hold, not a maximum');
});

test('reconcile: a ticket that is itself a PR is held by its own open PR', () => {
  const lane = laneWith(77);
  const snapshot = { repos: [REPO], objects: [{ repo: REPO, number: 77, kind: 'pr', labels: [], closes: [] }] };
  assert.equal(ac.reconcileInFlight({ lane, snapshot, activeLabels: ACTIVE, now: LATER }).released.length, 0);
});

test('reconcile: an object in another repo never satisfies a ticket', () => {
  const snapshot = {
    repos: [REPO, 'acme/other'],
    objects: [{ repo: 'acme/other', number: 42, kind: 'issue', labels: ['ready'], closes: [] }],
  };
  assert.equal(ac.reconcileInFlight({ lane: laneWith(42), snapshot, activeLabels: ACTIVE, now: LATER }).released.length, 1);
});

// ─── promotion: a held dispatch is not lost (AC3) ────────────────────────────

test('promotion: a held dispatch fires when capacity frees, and only then', () => {
  const first = ac.admit({ lane: ac.emptyLane(), wipLimit: 1, agentId: 'dev', entry: issueEntry(42), now: T0 });
  const held = ac.admit({ lane: first.lane, wipLimit: 1, agentId: 'dev', entry: issueEntry(43), now: T0 + 1000 });
  assert.equal(held.lane.held.length, 1);

  // Still full → nothing is released, nothing is lost.
  const blocked = ac.promoteHeld({ lane: held.lane, wipLimit: 1, now: T0 + 2000 });
  assert.deepEqual(blocked.release, []);
  assert.equal(blocked.lane.held.length, 1);

  // Ticket 42 completes → the reconcile empties the lane → the hold promotes.
  const reconciled = ac.reconcileInFlight({
    lane: blocked.lane, snapshot: { repos: [REPO], objects: [] }, activeLabels: ACTIVE, now: LATER,
  });
  const promoted = ac.promoteHeld({ lane: reconciled.lane, wipLimit: 1, now: LATER });
  assert.equal(promoted.release.length, 1);
  assert.deepEqual(promoted.release[0].entry, issueEntry(43));
  assert.equal(promoted.release[0].agentId, 'dev');
  assert.equal(promoted.lane.held.length, 0, 'the entry left the hold queue exactly once');
  assert.deepEqual(promoted.lane.inFlight.map(t => t.key), [`${REPO}#43`], 'and it now occupies the lane');
});

test('promotion: FIFO between two new tickets — the earlier hold takes the free slot', () => {
  let lane = ac.admit({ lane: ac.emptyLane(), wipLimit: 1, agentId: 'dev', entry: issueEntry(42), now: T0 }).lane;
  lane = ac.admit({ lane, wipLimit: 1, agentId: 'dev', entry: issueEntry(43), now: T0 + 1 }).lane;
  lane = ac.admit({ lane, wipLimit: 1, agentId: 'dev', entry: issueEntry(44), now: T0 + 2 }).lane;
  assert.equal(lane.held.length, 2);

  lane = ac.reconcileInFlight({ lane, snapshot: { repos: [REPO], objects: [] }, activeLabels: ACTIVE, now: LATER }).lane;
  const p = ac.promoteHeld({ lane, wipLimit: 1, now: LATER });
  assert.equal(p.release.length, 1);
  assert.deepEqual(p.release[0].entry, issueEntry(43));
  assert.equal(p.lane.held.length, 1, '#44 is still held, not dropped');
});

test('promotion: a same-ticket hold jumps a full lane; a new-ticket hold behind it does not', () => {
  // The scan continues past an entry it cannot admit, so a hand-off for the
  // ticket that IS in flight is not stuck behind an unrelated new ticket.
  let lane = ac.admit({ lane: ac.emptyLane(), wipLimit: 1, agentId: 'dev', entry: issueEntry(42), now: T0 }).lane;
  lane = ac.admit({ lane, wipLimit: 1, agentId: 'dev', entry: issueEntry(99), now: T0 + 1 }).lane; // new ticket → held
  // Simulate the hand-off having been held too (e.g. it arrived while the lane
  // record had not yet learned the PR).
  lane = { ...lane, held: [...lane.held, { heldAt: null, agentId: 'reviewer', entry: prEntry(77, { closes: [42] }), ticket: `${REPO}#42` }] };

  const p = ac.promoteHeld({ lane, wipLimit: 1, now: T0 + 5000 });
  assert.equal(p.release.length, 1);
  assert.equal(p.release[0].agentId, 'reviewer');
  assert.equal(p.release[0].reason, 'same-ticket');
  assert.equal(p.lane.held.length, 1);
  assert.equal(p.lane.held[0].agentId, 'dev', 'the unrelated new ticket stays held');
});

test('promotion: removing the wipLimit releases everything that was held', () => {
  let lane = ac.admit({ lane: ac.emptyLane(), wipLimit: 1, agentId: 'dev', entry: issueEntry(42), now: T0 }).lane;
  lane = ac.admit({ lane, wipLimit: 1, agentId: 'dev', entry: issueEntry(43), now: T0 + 1 }).lane;
  lane = ac.admit({ lane, wipLimit: 1, agentId: 'dev', entry: issueEntry(44), now: T0 + 2 }).lane;
  const p = ac.promoteHeld({ lane, wipLimit: null, now: T0 + 3 });
  assert.equal(p.release.length, 2);
  assert.equal(p.lane.held.length, 0);
});

// ─── lane hygiene ───────────────────────────────────────────────────────────

test('normalizeLane survives a missing, corrupt or foreign lane file', () => {
  for (const junk of [null, undefined, 'nope', 42, [], { inFlight: 'x', held: 7 }]) {
    assert.deepEqual(ac.normalizeLane(junk), ac.emptyLane());
  }
  // Partial entries are dropped, not crashed on.
  const l = ac.normalizeLane({
    inFlight: [{ repo: REPO, number: 1 }, { repo: '', number: 2 }, { repo: REPO }, null],
    held: [{ agentId: 'a', entry: {} }, { agentId: '', entry: {} }, { agentId: 'b' }],
  });
  assert.deepEqual(l.inFlight.map(t => t.key), [`${REPO}#1`]);
  assert.deepEqual(l.inFlight[0].objects, [`${REPO}#1`]);
  assert.equal(l.held.length, 1);
});

test('laneNeedsRefresh is false only for a lane with nothing in flight and nothing held', () => {
  assert.equal(ac.laneNeedsRefresh(ac.emptyLane()), false);
  assert.equal(ac.laneNeedsRefresh(null), false);
  assert.equal(ac.laneNeedsRefresh(laneWith(1)), true);
  assert.equal(ac.laneNeedsRefresh({ inFlight: [], held: [{ agentId: 'a', entry: {} }] }), true);
});

// ─── the whole lane lifecycle, one scenario (AC1 + AC3 together) ────────────

test('lifecycle: two tickets through a wipLimit-1 flow, hand-offs and all', () => {
  // The exact shape the Flow Control epic was opened for: a dispatcher labels a
  // ticket, the developer opens a PR, the reviewer and merger are woken by it,
  // and only when it has truly landed does the next ticket start. The second
  // dispatch must never run alongside the first, and must never be lost.
  const LIMIT = 1;
  const snap = (objects) => ({ repos: [REPO], objects });
  let lane = ac.emptyLane();
  let t = T0;
  const tick = (objects) => {
    const rec = ac.reconcileInFlight({ lane, snapshot: snap(objects), activeLabels: ACTIVE, now: t });
    const prom = ac.promoteHeld({ lane: rec.lane, wipLimit: LIMIT, now: t });
    lane = prom.lane;
    return prom.release;
  };
  const dispatch = (agentId, entry) => {
    const r = ac.admit({ lane, wipLimit: LIMIT, agentId, entry, now: t });
    lane = r.lane;
    return r;
  };

  // 1. The dispatcher labels issue 42 → the developer is admitted.
  assert.equal(dispatch('dev', issueEntry(42)).admit, true);

  // 2. A second ticket arrives a minute later → held, not run.
  t += 60_000;
  assert.equal(dispatch('dev', issueEntry(43)).admit, false);
  assert.equal(lane.held.length, 1);

  // 3. The developer opens PR 77 (Closes #42); the reviewer's wake is a
  //    hand-off on the SAME ticket and goes through with the lane full.
  t += 60_000;
  assert.equal(dispatch('reviewer', prEntry(77, { closes: [42] })).reason, 'same-ticket');

  // 4. A tick while the work is live: issue claimed, PR open. Nothing moves —
  //    and critically the held second ticket does not sneak through.
  t += 60_000;
  assert.deepEqual(tick([
    { repo: REPO, number: 42, kind: 'issue', labels: ['ready:wip'], closes: [] },
    { repo: REPO, number: 77, kind: 'pr', labels: ['ready-for-review'], closes: [42] },
  ]), []);
  assert.equal(lane.inFlight.length, 1);
  assert.equal(lane.held.length, 1);

  // 5. The PR goes into conflict — no label, still open. A STUCK ticket holds
  //    the lane; it must not let the queued ticket route around it (§4.0).
  t += 60 * 60 * 1000;
  assert.deepEqual(tick([
    { repo: REPO, number: 42, kind: 'issue', labels: ['ready:completed'], closes: [] },
    { repo: REPO, number: 77, kind: 'pr', labels: [], closes: [42] },
  ]), []);
  assert.equal(lane.held.length, 1, 'the second ticket is still waiting, not running');

  // 6. GitHub goes down mid-hold. Fail closed: the lane does not open.
  t += 60_000;
  const outage = ac.reconcileInFlight({ lane, snapshot: { repos: [], objects: [] }, activeLabels: ACTIVE, now: t });
  assert.equal(outage.lane.inFlight.length, 1);
  assert.deepEqual(ac.promoteHeld({ lane: outage.lane, wipLimit: LIMIT, now: t }).release, []);

  // 7. The PR is merged and the issue closes → the lane frees and the held
  //    dispatch fires, exactly once, and takes the slot.
  t += 60_000;
  const released = tick([]);
  assert.equal(released.length, 1);
  assert.deepEqual(released[0].entry, issueEntry(43));
  assert.equal(lane.held.length, 0);
  assert.deepEqual(lane.inFlight.map((x) => x.key), [`${REPO}#43`]);

  // 8. A second tick promotes nothing again — the entry left the queue once.
  t += 60_000;
  assert.deepEqual(tick([
    { repo: REPO, number: 43, kind: 'issue', labels: ['ready'], closes: [] },
  ]), []);
});
