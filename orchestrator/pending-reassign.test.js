"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  eligibleTargets,
  performReassign,
  triggerAccepts,
  ghEventFromEntry,
  buildReassignedEntry,
  buildReassignLogEvent,
  buildReassignLogFields,
  describeEntryWorkItem,
  REFUSAL_REASONS,
} = require("./pending-reassign");
const pendingQueue = require("./pending-queue");
const { GitHubPoller, GRACE_MS } = require("./github-poller");
const githubEventLog = require("./github-event-log");

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// One collapsed `issues.labeled` event, in BOTH shapes it exists in: as the
// poller's raw ghEvent, and as the queue entry the poller wrote from it
// (`github-poller._enqueue`). The AC1 agreement test below drives the same
// logical event through the poller's fan-out (raw shape) and through
// eligibleTargets (queued shape) and asserts they reach the same verdict.

const PAYLOAD = {
  action: "labeled",
  label: { name: "ux" },
  labels: [{ name: "ux" }, { name: "ready-6" }],
  issue: { number: 2102, title: "Pending queue: reassign", html_url: "https://github.com/org/repo/issues/2102" },
};
const CREATED_AT = "2026-09-08T12:48:06Z";

function ghEvent(over = {}) {
  return {
    id: "ev-2102",
    actor: { login: "thorsten" },
    created_at: CREATED_AT,
    type: "IssuesEvent",
    repo: { name: "org/repo" },
    payload: PAYLOAD,
    ...over,
  };
}

// The queue entry as `_enqueue` writes it, plus the `receivedAt`/`id` that
// `enqueuePending` stamps.
function queuedEntry(over = {}) {
  return {
    receivedAt: "2026-09-08T12:48:10.000Z",
    id: "entry-abc",
    triggerId: "t-source",
    github: {
      event: "issues.labeled",
      eventId: "ev-2102",
      repo: "org/repo",
      actor: "thorsten",
      createdAt: CREATED_AT,
      payload: PAYLOAD,
    },
    ...over,
  };
}

function trigger(over = {}) {
  return {
    id: "t-target",
    type: "github-event",
    enabled: true,
    repo: "org/repo",
    events: ["issues.labeled"],
    labelFilter: "ready-6",
    // A stamp well before the event, so the horizon never accidentally decides
    // a test that is about something else.
    activatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

// ── AC1: the endpoint's answer and the poller's fan-out agree ───────────────
//
// The whole point of composing the poller's exported predicates rather than
// writing a second matcher. The test drives ONE fixture set through both paths
// and asserts the accept/refuse verdicts are identical — including a case that
// would diverge if the label filter were re-implemented.

// Run the real `_fanOutBatch` over these subscribers and report, per agent,
// whether the event was actually delivered.
async function pollerVerdicts(subscribers, ev = ghEvent()) {
  const delivered = new Set();
  const origRecord = githubEventLog.record;
  githubEventLog.record = () => {};
  try {
    const poller = new GitHubPoller();
    poller._enqueuePending = () => {};
    poller._enqueue = (agentId) => { delivered.add(agentId); };

    // The Layer-3 throttle must not participate in this comparison, for two
    // independent reasons.
    //
    // CORRECTNESS: it is one of the three gates `triggerAccepts` deliberately
    // does NOT model (it is a per-(agent, conversation) counter, not a property
    // of (trigger, event)). Leaving it in would make a disagreement here mean
    // "the poller had already seen five of these", not "the predicates differ".
    //
    // HYGIENE: `GitHubPoller` loads and SAVES its throttle buckets to the real
    // `/workspace/github-poller/throttle-state.json` — an absolute path outside
    // the repo, shared by every worktree and every test run. So a `_fanOutBatch`
    // test that does not neutralise it writes state that throttles the SAME test
    // on later runs, which is why several tests in github-poller.test.js start
    // failing after this file has been run a few times within one throttle
    // window. Resetting the buckets and stubbing the save keeps this test
    // hermetic and stops it poisoning its neighbours.
    poller.throttleBuckets = {};
    poller._saveThrottleState = () => {};

    await poller._fanOutBatch("org/repo", [ev], subscribers, "tok");
  } finally {
    githubEventLog.record = origRecord;
  }
  return delivered;
}

// The same triggers, expressed the two ways the two paths take them.
const AGREEMENT_CASES = [
  {
    name: "exact label match → accepted",
    agentId: "reviewer-a",
    trigger: trigger({ id: "t-a", labelFilter: "ready-6" }),
  },
  {
    // THE DIVERGENCE CASE. `payload.label.name` is 'ux' but 'ready-6' is in the
    // collapsed `payload.labels` set — so a naive `payload.label.name === want`
    // re-implementation would REFUSE this while the poller accepts it, and a
    // naive "any label in the set" would accept the mismatch case below. Only
    // the real `labelFilterMatches` gets both right.
    name: "label collapsed into payload.labels → accepted (the re-implementation trap)",
    agentId: "reviewer-b",
    trigger: trigger({ id: "t-b", labelFilter: "ready-6" }),
  },
  {
    name: "label the event does not carry at all → refused",
    agentId: "reviewer-c",
    trigger: trigger({ id: "t-c", labelFilter: "needs-triage" }),
  },
  {
    name: "event type not subscribed → refused",
    agentId: "reviewer-d",
    trigger: trigger({ id: "t-d", events: ["pull_request.opened"] }),
  },
  {
    name: "trigger disabled → refused",
    agentId: "reviewer-e",
    trigger: trigger({ id: "t-e", enabled: false }),
  },
  {
    name: "internal transport → refused (never poller-subscribed)",
    agentId: "reviewer-f",
    trigger: trigger({ id: "t-f", transport: "internal" }),
  },
  {
    name: "history horizon after the event → refused",
    agentId: "reviewer-g",
    trigger: trigger({ id: "t-g", activatedAt: "2026-09-09T00:00:00Z" }),
  },
  {
    name: "any-label listener (no filter) → accepted",
    agentId: "reviewer-h",
    trigger: trigger({ id: "t-h", labelFilter: null }),
  },
];

test("AC1: eligibleTargets agrees with the poller's own fan-out on every case", async () => {
  // Poller side: the subscriber shape `_buildPollPlan` produces. Only triggers
  // that pass `pollerSubscribes` ever enter the plan, so the excluded ones are
  // absent here — which is itself part of the verdict.
  const subscribers = AGREEMENT_CASES
    .filter((c) => c.trigger.type === "github-event"
      && c.trigger.enabled !== false
      && c.trigger.transport !== "internal")
    .map((c) => ({
      agentId: c.agentId,
      triggerId: c.trigger.id,
      events: new Set(c.trigger.events),
      horizon: c.trigger.activatedAt || null,
      labelFilter: c.trigger.labelFilter || null,
      claimAdd: null,
    }));
  const delivered = await pollerVerdicts(subscribers);

  // Eligibility side: the same triggers on the same agents, from the QUEUED
  // shape of the same event.
  const { eligible } = eligibleTargets(queuedEntry(), AGREEMENT_CASES.map((c) => ({
    agentId: c.agentId,
    agentName: c.agentId,
    triggers: [c.trigger],
    triggersMtime: null,
  })));
  const accepted = new Set(eligible.map((e) => e.agentId));

  for (const c of AGREEMENT_CASES) {
    assert.equal(
      accepted.has(c.agentId), delivered.has(c.agentId),
      `${c.name}: eligibility says ${accepted.has(c.agentId)}, `
      + `the poller's fan-out says ${delivered.has(c.agentId)}`,
    );
  }
  // Guard against the whole comparison collapsing into "both refuse everything".
  assert.ok(delivered.size >= 3, "fixture must exercise real deliveries");
  assert.ok(accepted.size >= 3, "fixture must exercise real acceptances");
});

test("AC1: the divergence case is genuinely divergent — a naive matcher would disagree", () => {
  // Proves the previous test has teeth: the accepted event's directly-attributed
  // label is NOT the wanted one, so `payload.label.name === want` fails here...
  assert.notEqual(PAYLOAD.label.name, "ready-6");
  const { eligible } = eligibleTargets(queuedEntry(), [{
    agentId: "reviewer-b", triggers: [trigger({ labelFilter: "ready-6" })],
  }]);
  assert.equal(eligible.length, 1, "the real predicate recovers it from payload.labels");

  // ...and the converse: a label in neither the attributed name nor the set is
  // refused, so "accept anything on a labeled event" is equally wrong.
  const { eligible: none } = eligibleTargets(queuedEntry(), [{
    agentId: "reviewer-c", triggers: [trigger({ labelFilter: "needs-triage" })],
  }]);
  assert.equal(none.length, 0);
});

test("AC1: the horizon is evaluated with the poller's grace window, not a bare comparison", () => {
  // Inside the grace window → still accepted, exactly as `passesHorizon` does.
  const justAfter = new Date(Date.parse(CREATED_AT) + Math.floor(GRACE_MS / 2)).toISOString();
  const { eligible } = eligibleTargets(queuedEntry(), [{
    agentId: "a", triggers: [trigger({ activatedAt: justAfter })],
  }]);
  assert.equal(eligible.length, 1, "an event inside the grace window still reaches the target");

  const wellAfter = new Date(Date.parse(CREATED_AT) + GRACE_MS * 4).toISOString();
  const { eligible: none, refused } = eligibleTargets(queuedEntry(), [{
    agentId: "a", triggers: [trigger({ activatedAt: wellAfter })],
  }]);
  assert.equal(none.length, 0);
  assert.equal(refused[0].reason, "history-horizon");
});

test("triggerAccepts refuses a trigger watching a different repository", () => {
  // The poller's plan is keyed on `t.repo`, so this gate is structural there
  // and has to be explicit here.
  const v = triggerAccepts(trigger({ repo: "org/other" }), {
    eventKey: "issues.labeled", ghEvent: ghEvent(), repo: "org/repo", triggersMtime: null,
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "repo-mismatch");
});

test("every refusal reason has operator-readable copy", () => {
  const reasons = new Set();
  for (const c of AGREEMENT_CASES) {
    const v = triggerAccepts(c.trigger, {
      eventKey: "issues.labeled", ghEvent: ghEvent(), repo: "org/repo", triggersMtime: null,
    });
    if (!v.ok) reasons.add(v.reason);
  }
  reasons.add("repo-mismatch");
  for (const r of reasons) {
    assert.ok(REFUSAL_REASONS[r], `refusal reason '${r}' has no copy in REFUSAL_REASONS`);
  }
});

test("eligibleTargets picks the first accepting trigger and reports one row per agent", () => {
  const { eligible } = eligibleTargets(queuedEntry(), [{
    agentId: "multi",
    triggers: [
      trigger({ id: "t-no", labelFilter: "other" }),   // refuses
      trigger({ id: "t-yes" }),                         // accepts — this one wins
      trigger({ id: "t-also", labelFilter: null }),     // would also accept
    ],
  }]);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].triggerId, "t-yes");
  assert.equal(eligible[0].labelFilter, "ready-6");
});

test("eligibleTargets tolerates junk candidates and a trigger-less agent", () => {
  const { eligible, refused } = eligibleTargets(queuedEntry(), [
    null, {}, { agentId: "" }, { agentId: "bare" }, { agentId: "nulls", triggers: [null, undefined] },
  ]);
  assert.equal(eligible.length, 0);
  assert.deepEqual(refused.map((r) => r.agentId), ["bare", "nulls"]);
  assert.equal(refused[0].reason, "not-subscribed");
});

// ── AC9: which kinds expose the action ──────────────────────────────────────

test("AC9: only a github entry with a triggerId and an event is reassignable", () => {
  assert.equal(pendingQueue.isReassignable(queuedEntry()), true);

  // No triggerId → nothing to re-resolve on the target.
  assert.equal(pendingQueue.isReassignable(queuedEntry({ triggerId: null })), false);
  assert.equal(pendingQueue.isReassignable(queuedEntry({ triggerId: "" })), false);

  // No event key → the target's trigger could only be guessed at.
  assert.equal(pendingQueue.isReassignable(
    queuedEntry({ github: { repo: "org/repo" } })), false);
  assert.equal(pendingQueue.isReassignable(queuedEntry({ github: null })), false);

  // Every other kind. `trigger` is the one #2102's Q4 recommended and this
  // implementation deliberately refuses — a queued http invocation carries no
  // event to match a target trigger against.
  for (const e of [
    { kind: "trigger", triggerId: "t1" },
    { kind: "wake-agent", from: "a" },
    { kind: "github-digest", count: 3, triggerIds: ["t1"] },
    { kind: "throttle-warning", convKey: "pr:1" },
    { kind: "session-reset", roomId: "!r" },
    { kind: "session-set", roomId: "!r" },
    { kind: "handover-dm" },
    {}, null, "nope",
  ]) {
    assert.equal(pendingQueue.isReassignable(e), false,
      `kind ${JSON.stringify(e)} must not be reassignable`);
  }
});

test("AC9: summarizeEntry stamps `reassignable` only when true, leaving other kinds byte-identical", () => {
  assert.equal(pendingQueue.summarizeEntry(queuedEntry()).reassignable, true);

  // A non-reassignable summary carries no key at all — not `false`.
  const wake = pendingQueue.summarizeEntry({ kind: "wake-agent", id: "x", from: "a" });
  assert.ok(!('reassignable' in wake), "a non-reassignable summary must not grow the key");

  const noTrigger = pendingQueue.summarizeEntry(
    queuedEntry({ triggerId: null }));
  assert.ok(!('reassignable' in noTrigger));
});

test("summarizeEntry surfaces reassignment provenance so a moved entry does not read as fresh", () => {
  const s = pendingQueue.summarizeEntry(queuedEntry({ reassignedFrom: "reviewer-a" }));
  assert.equal(s.reassignedFrom, "reviewer-a");
  assert.ok(!('reassignedFrom' in pendingQueue.summarizeEntry(queuedEntry())));
});

// ── AC3: the moved entry resolves on the target ─────────────────────────────

test("AC3: the moved entry carries the target's trigger id and full provenance", () => {
  const moved = buildReassignedEntry(queuedEntry(), {
    triggerId: "t-target", fromAgentId: "reviewer-a", byUserId: "u-1",
    at: "2026-09-08T13:00:00.000Z", id: "entry-new",
  });
  assert.equal(moved.triggerId, "t-target", "the TARGET's trigger id, not the source's");
  assert.equal(moved.id, "entry-new");
  assert.equal(moved.reassignedFrom, "reviewer-a");
  assert.equal(moved.reassignedFromEntryId, "entry-abc");
  assert.equal(moved.reassignedBy, "u-1");
  assert.equal(moved.reassignedAt, "2026-09-08T13:00:00.000Z");
  assert.equal(moved.source, "internal");
  // The event itself is carried verbatim — the payload is what the target acts on.
  assert.deepEqual(moved.github, queuedEntry().github);
  // Q3: the original receivedAt survives, so the age signal is not destroyed.
  assert.equal(moved.receivedAt, queuedEntry().receivedAt);
  // Still classified as a github entry, so it drains down the same branch.
  assert.equal(pendingQueue.entryKind(moved), "github");
  // The source entry is not mutated.
  assert.equal(queuedEntry().triggerId, "t-source");
});

// ── #2151: the moved entry's wakeLabel is the TARGET's, never the source's ──

test("#2151: buildReassignedEntry re-stamps wakeLabel from the target's own labelFilter", () => {
  const moved = buildReassignedEntry(queuedEntry({ wakeLabel: "ready" }), {
    triggerId: "t-target", labelFilter: "ready-2", fromAgentId: "reviewer-a",
    byUserId: "u-1", at: "2026-09-08T13:00:00.000Z", id: "entry-new",
  });
  assert.equal(moved.wakeLabel, "ready-2",
    "the target's own labelFilter, not the source's stale wakeLabel ('ready')");
});

test("#2151: buildReassignedEntry stamps null when the target listener carries no labelFilter", () => {
  const moved = buildReassignedEntry(queuedEntry({ wakeLabel: "ready" }), {
    triggerId: "t-target", labelFilter: null, fromAgentId: "reviewer-a",
    byUserId: "u-1", at: "2026-09-08T13:00:00.000Z", id: "entry-new",
  });
  assert.equal(moved.wakeLabel, null,
    "an any-label target listener must not inherit the source's wakeLabel");
});

test("AC3: the target's consumer path resolves the moved entry's trigger id", () => {
  // agent-entrypoint.py `_handle_pending_entry` looks the entry's `triggerId`
  // up in the TARGET's own triggers.json and requires type http|github-event
  // and enabled — reproduced here as the exact predicate it applies. A move
  // that got this wrong drops the entry with one line to stderr.
  const targetTriggers = [trigger({ id: "t-target" }), trigger({ id: "t-other", enabled: false })];
  const moved = buildReassignedEntry(queuedEntry(), {
    triggerId: "t-target", fromAgentId: "reviewer-a", byUserId: "u-1",
    at: "2026-09-08T13:00:00.000Z", id: "entry-new",
  });
  const match = targetTriggers.find((t) => t.id === moved.triggerId
    && ["http", "github-event"].includes(t.type)
    && t.enabled !== false);
  assert.ok(match, "the target must resolve the moved entry's triggerId");

  // And the counter-proof: the UNMOVED entry, carrying the source's id, is
  // exactly what silently evaporates on the target.
  const stale = targetTriggers.find((t) => t.id === queuedEntry().triggerId);
  assert.equal(stale, undefined,
    "the source's trigger id resolves to nothing on the target — the failure this guards");
});

// ── AC6/AC8: the audit row and the loss report ──────────────────────────────

test("AC6: the log event reuses the queued event's own identity so the trail joins up", () => {
  const ev = buildReassignLogEvent(queuedEntry(), { now: "2026-09-08T13:00:00.000Z" });
  const entry = githubEventLog.buildEventEntry({
    ghEvent: ev, repoFullName: "org/repo", key: "issues.labeled",
    outcomes: [{ agentId: "reviewer-b", triggerId: "t-target", status: "reassigned", reason: "operator-reassign", digest: false }],
  });
  // Same event id as the poller's original `delivered` row — that is what makes
  // the two rows read as one story rather than two unrelated events.
  assert.equal(entry.eventId, "ev-2102");
  assert.equal(entry.repo, "org/repo");
  assert.equal(entry.event, "issues.labeled");
  // The label and work item are re-extracted by the real writer, not restated.
  assert.equal(entry.label, "ux");
  assert.equal(entry.workItem.kind, "issue");
  assert.equal(entry.workItem.number, 2102);
  assert.equal(entry.outcomes[0].status, "reassigned");
  assert.equal(entry.noMatchingTrigger, false);
});

test("AC6: a log event falls back to `now` only when the entry carries no timestamp", () => {
  assert.equal(buildReassignLogEvent(queuedEntry(), { now: "X" }).created_at, CREATED_AT);
  const bare = queuedEntry({ github: { event: "issues.labeled", eventId: "e" } });
  assert.equal(buildReassignLogEvent(bare, { now: "X" }).created_at, "X");
});

test("AC6: the reassign block names who moved what, where buildEventEntry has no slot", () => {
  assert.deepEqual(
    buildReassignLogFields({ fromAgentId: "a", toAgentId: "b", byUserId: "u-1" }),
    { reassign: { from: "a", to: "b", by: "u-1" } });
  // An unattributed move omits `by` rather than carrying null.
  assert.deepEqual(
    buildReassignLogFields({ fromAgentId: "a", toAgentId: "b", byUserId: null }),
    { reassign: { from: "a", to: "b" } });
});

test("AC8: the work-item description names repo, number and label for a human to re-apply", () => {
  const w = describeEntryWorkItem(queuedEntry());
  assert.equal(w.repo, "org/repo");
  assert.equal(w.number, 2102);
  assert.equal(w.label, "ux");
  assert.equal(w.event, "issues.labeled");
  assert.match(w.text, /org\/repo#2102/);
  assert.match(w.text, /ux/);
});

test("AC8: the description degrades to a sentence rather than throwing on a bare entry", () => {
  assert.equal(describeEntryWorkItem(null).text, "the queued event");
  assert.equal(describeEntryWorkItem({}).text, "the queued event");
  const prOnly = describeEntryWorkItem({ github: { payload: { pull_request: { number: 7 } } } });
  assert.equal(prOnly.number, 7);
  assert.match(prOnly.text, /#7/);
});

test("ghEventFromEntry is a rename of the poller's own projection, not a reconstruction", () => {
  const ev = ghEventFromEntry(queuedEntry());
  assert.equal(ev.id, "ev-2102");
  assert.equal(ev.created_at, CREATED_AT);
  assert.equal(ev.repo.name, "org/repo");
  assert.equal(ev.actor.login, "thorsten");
  // The payload is carried by reference-equal content — the predicates must see
  // the bytes the poller saw.
  assert.deepEqual(ev.payload, PAYLOAD);
  // A corrupt entry yields an empty payload rather than throwing.
  assert.deepEqual(ghEventFromEntry({ github: { payload: "junk" } }).payload, {});
  assert.deepEqual(ghEventFromEntry(null).payload, {});
});

// ── AC2/AC4/AC8: the move, and the order its two side effects run in ────────
//
// `performReassign` takes `removeAtSource`/`enqueueAtTarget` as injected
// functions, so these drive the REAL sequence over an in-memory queue rather
// than reading orchestrator.js's source for the ordering.

// A harness recording every side effect in the order it happened.
function harness(over = {}) {
  const calls = [];
  const sourceQueue = [queuedEntry()];
  const targetQueue = [];
  const deps = {
    entry: queuedEntry(),
    isReassignable: pendingQueue.isReassignable,
    resolveTarget: () => ({ ok: true, agentId: "reviewer-b", teamId: "team-x" }),
    candidate: { agentId: "reviewer-b", agentName: "Reviewer B", triggers: [trigger()] },
    removeAtSource: () => {
      calls.push("remove");
      const i = sourceQueue.findIndex((e) => e.id === "entry-abc");
      if (i === -1) return { removed: false };
      sourceQueue.splice(i, 1);
      return { removed: true };
    },
    enqueueAtTarget: (moved) => {
      calls.push("enqueue");
      targetQueue.push(moved);
      return true;
    },
    newId: "entry-new",
    now: "2026-09-08T13:00:00.000Z",
    byUserId: "u-1",
    ...over,
  };
  const run = () => performReassign(
    { sourceAgentId: "reviewer-a", targetAgentId: "reviewer-b" }, deps);
  return { run, calls, sourceQueue, targetQueue };
}

test("AC2: the happy path removes at the source BEFORE enqueueing at the target", () => {
  const h = harness();
  const result = h.run();
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls, ["remove", "enqueue"],
    "delete-first: enqueue-first would let a concurrently-draining source double-run the item");
  assert.equal(h.sourceQueue.length, 0);
  assert.equal(h.targetQueue.length, 1);
  assert.equal(h.targetQueue[0].triggerId, "t-target");
  assert.equal(h.targetQueue[0].id, "entry-new");
  assert.equal(result.to, "reviewer-b");
  assert.equal(result.triggerId, "t-target");
  // #2151: the moved entry's wakeLabel is the target trigger's own filter.
  assert.equal(h.targetQueue[0].wakeLabel, "ready-6");
  assert.equal(result.labelFilter, "ready-6");
});

test("AC2: an entry that already fired performs NO enqueue and reports a distinct outcome", () => {
  // `removed: false` is what `cancelPendingEntry` returns when the agent
  // drained the entry between the operator's read and this write.
  const h = harness({ removeAtSource: () => ({ removed: false }) });
  const result = h.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, "already-fired");
  assert.equal(h.targetQueue.length, 0, "nothing may be enqueued once the claim failed");
});

test("AC4: a target with no matching trigger is refused and the source queue is untouched", () => {
  // The headline refusal: the target's only trigger wants a different label.
  const h = harness({
    candidate: { agentId: "reviewer-b", triggers: [trigger({ labelFilter: "needs-triage" })] },
  });
  const result = h.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-matching-trigger");
  assert.equal(result.reason, "label-filter");
  // The entry is STILL in the source queue, and neither side effect ran.
  assert.deepEqual(h.calls, [], "a refusal must not touch either queue");
  assert.equal(h.sourceQueue.length, 1);
  assert.equal(h.sourceQueue[0].id, "entry-abc");
  assert.equal(h.sourceQueue[0].triggerId, "t-source", "the source entry is not re-stamped");
});

test("AC4: every refusal leaves both queues untouched", () => {
  const cases = [
    ["entry-gone", { entry: null }],
    ["kind-not-reassignable", { entry: { kind: "wake-agent", id: "e", from: "x" } }],
    ["cross-team", { resolveTarget: () => ({ ok: false, reason: "cross-team" }) }],
    ["self-target", { resolveTarget: () => ({ ok: false, reason: "self-target" }) }],
    ["unknown-target", { resolveTarget: () => ({ ok: false, reason: "unknown-target" }) }],
    ["target-not-a-candidate", { candidate: null }],
    ["no-matching-trigger", { candidate: { agentId: "reviewer-b", triggers: [] } }],
  ];
  for (const [code, over] of cases) {
    const h = harness(over);
    const result = h.run();
    assert.equal(result.ok, false, `${code} must refuse`);
    assert.equal(result.code, code);
    assert.deepEqual(h.calls, [], `${code} must not touch either queue`);
    assert.equal(h.sourceQueue.length, 1, `${code} must leave the source entry in place`);
  }
});

test("AC8: an enqueue that fails after a successful removal is a hard failure carrying the entry", () => {
  const h = harness({ enqueueAtTarget: () => false });
  const result = h.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, "enqueue-failed");
  // The removal DID happen — the event is in no queue at all.
  assert.equal(h.sourceQueue.length, 0);
  assert.equal(h.targetQueue.length, 0);
  // The work item is named so a human can re-apply the label on GitHub, and the
  // full entry rides along so the caller can park it for recovery.
  assert.match(result.workItem.text, /org\/repo#2102/);
  assert.equal(result.workItem.label, "ux");
  assert.equal(result.entry.triggerId, "t-target");
  assert.equal(result.entry.reassignedFrom, "reviewer-a");
});

test("a throwing source write is reported, not swallowed, and nothing is enqueued", () => {
  const h = harness({ removeAtSource: () => { throw new Error("EACCES"); } });
  const result = h.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, "source-write-failed");
  assert.match(result.error, /EACCES/);
  assert.equal(h.targetQueue.length, 0);
});

test("the acting human is carried onto the moved entry, not invented", () => {
  const withUser = harness().run();
  assert.equal(withUser.entry.reassignedBy, "u-1");
  const anon = harness({ byUserId: undefined }).run();
  assert.equal(anon.entry.reassignedBy, null, "an unattributed move records null, never a guess");
});
