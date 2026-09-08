import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIFECYCLE_STAGES,
  TICKET_STATES,
  BLOCKERS,
  stageInfo,
  stageIndex,
  blockerInfo,
  synthesizeUrl,
  deepLinks,
  ticketCard,
  groupIntoLanes,
  bucketFor,
  epicRollups,
  rollupSummary,
  boardSummary,
} from './flow-control-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECONCILER = path.join(here, '..', '..', '..', '..', 'orchestrator', 'ticket-reconciler.js');

// A ledger row in the shape `buildTicketLedger` emits. Only the fields the view
// reads are spelled out; `over` supplies the case under test.
const row = (over = {}) => ({
  ticketId: 'acme/repo#2116',
  repo: 'acme/repo',
  kind: 'issue',
  number: 2116,
  title: 'Flow Control board',
  url: 'https://github.com/acme/repo/issues/2116',
  epicId: 2112,
  lane: 'ready-2',
  state: 'in-review',
  stateSince: '2026-09-08T18:00:00.000Z',
  ageInStateMs: 90 * 60000,
  ownerAgentId: 'team-code-reviewer',
  blocker: null,
  blockers: [],
  reasonDetail: null,
  needsHuman: false,
  severity: 'info',
  prNumber: 2127,
  prState: 'open',
  prLinkage: 'closes',
  labels: ['ready-2:completed', 'ready-for-review'],
  anomalies: [],
  recurrence: 0,
  evidence: [
    { type: 'issue', text: '#2116', url: 'https://github.com/acme/repo/issues/2116' },
    { type: 'pr', text: '#2127', url: 'https://github.com/acme/repo/pull/2127' },
  ],
  ...over,
});

// ── AC2: state never comes from raw labels ──────────────────────────────────
//
// The strongest possible form of "it cannot show a false Done" is not a
// source-text assertion (which a single-word slug would make a false-positive
// generator) but a behavioural one: the labels array is not an input at all.

test('AC2: the card is identical with the labels array removed entirely', () => {
  const withLabels = row({ labels: ['ready-2:completed', 'ready-to-merge', 'done'] });
  const without = row();
  delete without.labels;
  assert.deepEqual(ticketCard(without), ticketCard(withLabels));
});

test('AC2: labels claiming completion cannot produce a Done card', () => {
  // The §1 stall exactly: every label says the work finished, GitHub says the PR
  // is open and conflicting. The board must show the reconciler's truth.
  const lying = row({
    labels: ['ready-2:completed', 'ready-for-review:completed', 'ready-to-merge:completed'],
    state: 'in-review',
    blocker: 'claimed-done-not-merged',
    severity: 'warning',
    reasonDetail: 'the completing stage set none of its declared outgoing labels.',
  });
  const card = ticketCard(lying);
  assert.equal(card.state, 'in-review');
  assert.equal(card.stateLabel, 'In review');
  assert.equal(card.blockerLabel, 'Claimed done');

  const lanes = groupIntoLanes([lying]);
  assert.equal(lanes.find((l) => l.state === 'done').count, 0, 'no false Done');
  assert.equal(lanes.find((l) => l.state === 'in-review').count, 1);
});

// ── drift guards against the reconciler ─────────────────────────────────────

test('TICKET_STATES is byte-for-byte the reconciler\'s own list, in order', () => {
  // The browser bundle cannot require from orchestrator/, so the list is
  // duplicated (same reasoning as working-env-repo-diff.test.js). A stage the
  // reconciler can emit but the board does not know would silently land every
  // such ticket in the trailing "Other" lane.
  const src = fs.readFileSync(RECONCILER, 'utf8');
  const at = src.indexOf('const TICKET_STATES = Object.freeze([');
  assert.ok(at > 0, 'TICKET_STATES must be declared in the expected form');
  const end = src.indexOf(']);', at);
  assert.ok(end > at, 'TICKET_STATES must terminate');
  const canonical = [...src.slice(at, end).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(canonical.length >= 5, 'the extraction must actually find states');
  assert.deepEqual([...TICKET_STATES], canonical);
});

test('BLOCKERS covers every reason code the reconciler can emit', () => {
  const src = fs.readFileSync(RECONCILER, 'utf8');
  const at = src.indexOf('const BLOCKER_CODES = Object.freeze([');
  assert.ok(at > 0, 'BLOCKER_CODES must be declared in the expected form');
  const end = src.indexOf(']);', at);
  const canonical = [...src.slice(at, end).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(canonical.length >= 5, 'the extraction must actually find codes');
  const missing = canonical.filter((c) => !BLOCKERS[c]);
  assert.deepEqual(missing, [], 'a code with no entry renders as a bare slug on the badge');
  // …and nothing invented on this side either.
  assert.deepEqual(Object.keys(BLOCKERS).filter((c) => !canonical.includes(c)), []);
});

test('the drift guards are not vacuous — a wrong list is reported', () => {
  const canonical = ['backlog', 'ready', 'done'];
  assert.notDeepEqual(['backlog', 'done', 'ready'], canonical, 'order is part of the claim');
  assert.notDeepEqual(['backlog', 'ready'], canonical, 'a missing state is a failure');
});

// ── stages ──────────────────────────────────────────────────────────────────

test('every stage has a label and a blurb, and the order is the flow order', () => {
  for (const s of LIFECYCLE_STAGES) {
    assert.ok(s.label && s.label !== s.state, `${s.state} needs a human label`);
    assert.ok(s.blurb.length > 10, `${s.state} needs a blurb`);
  }
  assert.ok(stageIndex('backlog') < stageIndex('in-dev'));
  assert.ok(stageIndex('in-dev') < stageIndex('mergeable'));
  assert.ok(stageIndex('mergeable') < stageIndex('done'));
});

test('an unknown state degrades to itself rather than throwing', () => {
  assert.equal(stageInfo('quantum').label, 'quantum');
  assert.equal(stageIndex('quantum'), -1);
  assert.equal(blockerInfo('meteorite').label, 'meteorite');
});

// ── AC3: deep links ─────────────────────────────────────────────────────────

test('AC3: an issue ticket links to both its issue and its PR', () => {
  const { issueUrl, prUrl } = deepLinks(row());
  assert.equal(issueUrl, 'https://github.com/acme/repo/issues/2116');
  assert.equal(prUrl, 'https://github.com/acme/repo/pull/2127');
});

test('AC3: a PR-kind ticket links to the PR and claims no issue it does not have', () => {
  const pr = row({
    kind: 'pr', number: 2127, url: 'https://github.com/acme/repo/pull/2127', prNumber: 2127,
    evidence: [{ type: 'pr', text: '#2127', url: 'https://github.com/acme/repo/pull/2127' }],
  });
  const { issueUrl, prUrl } = deepLinks(pr);
  assert.equal(prUrl, 'https://github.com/acme/repo/pull/2127');
  assert.equal(issueUrl, null, 'inventing an issue link would 404');
});

test('AC3: a PR whose url GitHub did not return is synthesized from the repo', () => {
  const t = row({ evidence: [{ type: 'pr', text: '#2127', url: null }] });
  assert.equal(deepLinks(t).prUrl, 'https://github.com/acme/repo/pull/2127');
});

test('AC3: an unusable repo degrades to no link rather than a broken one', () => {
  assert.equal(synthesizeUrl('not-a-repo', 'pr', 5), null);
  assert.equal(synthesizeUrl(null, 'pr', 5), null);
  assert.equal(synthesizeUrl('acme/repo', 'pr', undefined), null);
  const t = row({ repo: 'not-a-repo', evidence: [] , url: null });
  assert.deepEqual(deepLinks(t), { issueUrl: null, prUrl: null });
});

test('AC3: no PR at all yields no PR link, and the issue link survives', () => {
  const t = row({ prNumber: null, prState: null, evidence: [{ type: 'issue', text: '#2116', url: 'https://gh/i/2116' }] });
  assert.equal(deepLinks(t).prUrl, null);
  // The row's own `url` is the canonical link for the row's own object, so it
  // wins over the evidence entry that describes the same issue.
  assert.equal(deepLinks(t).issueUrl, 'https://github.com/acme/repo/issues/2116');
  assert.equal(deepLinks(row({ url: null, prNumber: null, evidence: [{ type: 'issue', text: '#2116', url: 'https://gh/i/2116' }] })).issueUrl, 'https://gh/i/2116');
});

// ── AC1: the card carries state / owner / age / blocker ─────────────────────

test('AC1: the card projects state, owner, age and blocker from the ledger row', () => {
  const card = ticketCard(row({
    blocker: 'conflict', severity: 'warning', needsHuman: false,
    reasonDetail: 'the PR conflicts with its base branch.',
  }));
  assert.equal(card.stateLabel, 'In review');
  assert.equal(card.owner, 'team-code-reviewer');
  assert.equal(card.age, '1h');
  assert.equal(card.blocker, 'conflict');
  assert.equal(card.blockerLabel, 'Conflict');
  assert.equal(card.reasonDetail, 'the PR conflicts with its base branch.');
  assert.equal(card.severity, 'warning');
  assert.match(card.color, /warning/);
  assert.equal(card.ref, '#2116');
  assert.equal(card.epicId, 2112);
});

test('a PR-kind card labels its reference as a PR', () => {
  assert.equal(ticketCard(row({ kind: 'pr', number: 2127 })).ref, 'PR #2127');
});

test('an unblocked ticket carries no blocker presentation at all', () => {
  const card = ticketCard(row());
  assert.equal(card.blocker, null);
  assert.equal(card.blockerLabel, null);
  assert.equal(card.blockerBlurb, null);
  assert.equal(card.needsHuman, false);
});

// ── swimlanes ───────────────────────────────────────────────────────────────

test('groupIntoLanes returns one lane per stage, empty ones included', () => {
  const lanes = groupIntoLanes([row()]);
  assert.equal(lanes.length, TICKET_STATES.length);
  assert.deepEqual(lanes.map((l) => l.state), [...TICKET_STATES]);
  assert.equal(lanes.find((l) => l.state === 'backlog').count, 0);
});

test('groupIntoLanes can drop empty lanes on request', () => {
  const lanes = groupIntoLanes([row()], { includeEmpty: false });
  assert.deepEqual(lanes.map((l) => l.state), ['in-review']);
});

test('groupIntoLanes preserves the ledger\'s most-actionable-first order', () => {
  // `compareTickets` already sorted these; re-sorting in the view would discard
  // the reconciler's ranking, which is the only ordering an operator can act on.
  const tickets = [
    row({ number: 1, ticketId: '#1', blocker: 'conflict' }),
    row({ number: 2, ticketId: '#2', blocker: 'ci-red' }),
    row({ number: 3, ticketId: '#3' }),
  ];
  const lane = groupIntoLanes(tickets).find((l) => l.state === 'in-review');
  assert.deepEqual(lane.tickets.map((c) => c.number), [1, 2, 3]);
  assert.equal(lane.count, 3);
  assert.equal(lane.blocked, 2);
});

test('a state the console does not know lands in Other, never dropped', () => {
  const lanes = groupIntoLanes([row({ state: 'teleported' })]);
  const other = lanes.find((l) => l.state === 'other');
  assert.equal(other.count, 1);
  assert.equal(lanes.reduce((n, l) => n + l.count, 0), 1, 'nothing is lost');
});

test('groupIntoLanes tolerates junk input', () => {
  assert.equal(groupIntoLanes(null).length, TICKET_STATES.length);
  assert.equal(groupIntoLanes([null, undefined]).reduce((n, l) => n + l.count, 0), 0);
});

// ── epic roll-up ────────────────────────────────────────────────────────────

test('bucketFor is exhaustive and mutually exclusive over state × blocker', () => {
  const buckets = new Set();
  let n = 0;
  for (const state of [...TICKET_STATES, 'teleported']) {
    for (const blocker of [null, 'conflict', 'needs-human']) {
      const b = bucketFor(ticketCard(row({ state, blocker })));
      assert.ok(['done', 'blocked', 'inProgress', 'waiting'].includes(b), `${state}/${blocker} → ${b}`);
      buckets.add(b);
      n += 1;
    }
  }
  assert.equal(buckets.size, 4, 'every bucket is reachable');
  assert.equal(n, (TICKET_STATES.length + 1) * 3);
});

test('a blocker recorded against merged work is history, not a call to action', () => {
  assert.equal(bucketFor(ticketCard(row({ state: 'done', blocker: 'conflict' }))), 'done');
});

test('the four roll-up counts always sum to the total', () => {
  const tickets = [...TICKET_STATES, 'teleported'].flatMap((state, i) => ([
    row({ number: 100 + i, epicId: 2112, state }),
    row({ number: 200 + i, epicId: 2112, state, blocker: 'ci-red' }),
  ]));
  const [roll] = epicRollups(tickets);
  assert.equal(roll.epicId, 2112);
  assert.equal(roll.done + roll.blocked + roll.inProgress + roll.waiting, roll.total);
  assert.equal(roll.total, tickets.length);
});

test('epicRollups groups by epic, skips epic-less tickets, and ranks blocked first', () => {
  const rolls = epicRollups([
    row({ number: 1, epicId: 41, state: 'done' }),
    row({ number: 2, epicId: 41, state: 'done' }),
    row({ number: 3, epicId: 41, state: 'ready' }),
    row({ number: 4, epicId: 99, state: 'in-dev', blocker: 'conflict' }),
    row({ number: 5, epicId: null }),
  ]);
  assert.deepEqual(rolls.map((r) => r.epicId), [99, 41], 'most blocked first');
  assert.equal(rolls.find((r) => r.epicId === 41).total, 3);
  assert.equal(rolls.reduce((n, r) => n + r.total, 0), 4, 'the epic-less ticket is not counted');
});

test('rollupSummary reads like the concept\'s example and drops zero buckets', () => {
  assert.equal(
    rollupSummary({ done: 3, blocked: 1, inProgress: 2, waiting: 4 }),
    '3 done · 1 blocked · 2 in progress · 4 waiting',
  );
  assert.equal(rollupSummary({ done: 4, blocked: 0, inProgress: 0, waiting: 0 }), '4 done');
  assert.equal(rollupSummary({ done: 0, blocked: 0, inProgress: 0, waiting: 0 }), '');
});

test('epicRollups counts the tickets that need a human', () => {
  const [roll] = epicRollups([
    row({ number: 1, epicId: 7, blocker: 'needs-human', needsHuman: true }),
    row({ number: 2, epicId: 7 }),
  ]);
  assert.equal(roll.needsHuman, 1);
});

// ── header ──────────────────────────────────────────────────────────────────

test('boardSummary counts the header figures and surfaces the banner conditions', () => {
  const s = boardSummary({
    generatedAt: '2026-09-08T20:00:00.000Z',
    swept: 12,
    repos: ['acme/repo'],
    errors: ['acme/other: 403'],
    tickets: [
      row({ number: 1 }),
      row({ number: 2, blocker: 'conflict', severity: 'warning' }),
      row({ number: 3, blocker: 'needs-human', needsHuman: true }),
      row({ number: 4, state: 'done' }),
    ],
  });
  assert.equal(s.total, 4);
  assert.equal(s.blocked, 2);
  assert.equal(s.needsHuman, 1);
  assert.equal(s.done, 1);
  assert.equal(s.epics, 1);
  assert.equal(s.swept, 12);
  assert.equal(s.maintenance, false);
  assert.equal(s.noRepos, false);
  assert.deepEqual(s.errors, ['acme/other: 403']);
});

test('boardSummary reports maintenance and the repo-less team', () => {
  assert.equal(boardSummary({ maintenance: true, tickets: [] }).maintenance, true);
  assert.equal(boardSummary({ repos: [], tickets: [] }).noRepos, true);
  // Maintenance already explains the empty board, so the repo banner stands down.
  assert.equal(boardSummary({ maintenance: true, repos: [], tickets: [] }).noRepos, false);
});

test('boardSummary survives a missing or malformed payload', () => {
  for (const data of [null, undefined, {}, { tickets: null }, { tickets: [null] }]) {
    const s = boardSummary(data);
    assert.equal(s.total, 0);
    assert.deepEqual(s.errors, []);
  }
});
