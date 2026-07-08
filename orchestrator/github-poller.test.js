"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  effectiveHorizon,
  passesHorizon,
  selectFreshEvents,
  planBurstHandoffs,
  shouldFetchNextPage,
  GRACE_MS,
  SEEN_MAX,
  BURST_CAP,
  PER_PAGE,
  MAX_PAGES,
} = require("./github-poller");

// ── effectiveHorizon (Baustein A): activatedAt > createdAt > mtime ─────────────

test("effectiveHorizon: activatedAt wins over createdAt and mtime", () => {
  const trigger = { activatedAt: "2026-07-01T00:00:00Z", createdAt: "2026-06-01T00:00:00Z" };
  assert.equal(effectiveHorizon(trigger, "2026-05-01T00:00:00Z"), "2026-07-01T00:00:00Z");
});

test("effectiveHorizon: createdAt used when activatedAt absent", () => {
  const trigger = { createdAt: "2026-06-01T00:00:00Z" };
  assert.equal(effectiveHorizon(trigger, "2026-05-01T00:00:00Z"), "2026-06-01T00:00:00Z");
});

test("effectiveHorizon: falls back to triggers mtime for unstamped triggers", () => {
  assert.equal(effectiveHorizon({}, "2026-05-01T00:00:00Z"), "2026-05-01T00:00:00Z");
  assert.equal(effectiveHorizon(null, "2026-05-01T00:00:00Z"), "2026-05-01T00:00:00Z");
});

test("effectiveHorizon: null when nothing is available", () => {
  assert.equal(effectiveHorizon({}, null), null);
  assert.equal(effectiveHorizon(null, undefined), null);
});

// ── passesHorizon (Baustein B): >= horizon − grace ────────────────────────────

test("passesHorizon: event well after the horizon passes", () => {
  assert.equal(
    passesHorizon("2026-07-01T12:00:00Z", "2026-07-01T00:00:00Z", GRACE_MS),
    true,
  );
});

test("passesHorizon: event before horizon − grace is dropped", () => {
  // 10 min before the horizon, grace is 5 min → dropped.
  assert.equal(
    passesHorizon("2026-06-30T23:50:00Z", "2026-07-01T00:00:00Z", GRACE_MS),
    false,
  );
});

test("passesHorizon: event inside the grace window is kept", () => {
  // 2 min before the horizon, within the 5 min grace → kept.
  assert.equal(
    passesHorizon("2026-06-30T23:58:00Z", "2026-07-01T00:00:00Z", GRACE_MS),
    true,
  );
});

test("passesHorizon: missing horizon or timestamp fails open (kept)", () => {
  assert.equal(passesHorizon("2026-07-01T00:00:00Z", null, GRACE_MS), true);
  assert.equal(passesHorizon(null, "2026-07-01T00:00:00Z", GRACE_MS), true);
  assert.equal(passesHorizon("not-a-date", "2026-07-01T00:00:00Z", GRACE_MS), true);
});

// ── selectFreshEvents (Baustein F): seen-id membership, not timestamp ──────────

test("selectFreshEvents: new id with an OLDER created_at is still fresh", () => {
  // The whole point of F: ordering/lateness is irrelevant, only id membership.
  const seen = ["100"];
  const events = [{ id: "99", created_at: "2026-06-01T00:00:00Z" }];
  const { fresh } = selectFreshEvents(events, seen, SEEN_MAX);
  assert.deepEqual(fresh.map(e => e.id), ["99"]);
});

test("selectFreshEvents: already-seen ids are skipped", () => {
  const seen = ["1", "2"];
  const events = [
    { id: "1", created_at: "2026-07-01T00:00:00Z" },
    { id: "3", created_at: "2026-07-01T00:01:00Z" },
  ];
  const { fresh } = selectFreshEvents(events, seen, SEEN_MAX);
  assert.deepEqual(fresh.map(e => e.id), ["3"]);
});

test("selectFreshEvents: nextSeen prepends current ids and dedupes", () => {
  const seen = ["2", "1"];
  const events = [{ id: "3" }, { id: "2" }];
  const { nextSeen } = selectFreshEvents(events, seen, SEEN_MAX);
  assert.deepEqual(nextSeen, ["3", "2", "1"]);
});

test("selectFreshEvents: nextSeen is capped at seenMax", () => {
  const events = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
  const { nextSeen } = selectFreshEvents(events, [], 4);
  assert.equal(nextSeen.length, 4);
  assert.deepEqual(nextSeen, ["0", "1", "2", "3"]);
});

test("selectFreshEvents: empty input yields no fresh events", () => {
  const { fresh, nextSeen } = selectFreshEvents([], ["1"], SEEN_MAX);
  assert.deepEqual(fresh, []);
  assert.deepEqual(nextSeen, ["1"]);
});

test("selectFreshEvents: events without an id are ignored", () => {
  const events = [{ created_at: "2026-07-01T00:00:00Z" }, { id: "5" }];
  const { fresh, nextSeen } = selectFreshEvents(events, [], SEEN_MAX);
  assert.deepEqual(fresh.map(e => e.id), ["5"]);
  assert.deepEqual(nextSeen, ["5"]);
});

// ── planBurstHandoffs (Baustein C, #449): group by (agent, conv), cap → digest ─

function deliverable(agentId, convKey, id) {
  return {
    agentId,
    triggerId: `${agentId}-trig`,
    convKey,
    key: "pull_request.opened",
    ghEvent: { id },
  };
}

test("planBurstHandoffs: more than cap in one (agent,conv) group → single digest", () => {
  const d = [
    deliverable("a", "pr:1", "1"),
    deliverable("a", "pr:1", "2"),
    deliverable("a", "pr:1", "3"),
    deliverable("a", "pr:1", "4"),
  ];
  const plans = planBurstHandoffs(d, 3);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].mode, "digest");
  assert.equal(plans[0].agentId, "a");
  assert.equal(plans[0].convKey, "pr:1");
  assert.equal(plans[0].items.length, 4);
});

test("planBurstHandoffs: exactly cap stays individual (no premature digest)", () => {
  const d = [
    deliverable("a", "pr:1", "1"),
    deliverable("a", "pr:1", "2"),
    deliverable("a", "pr:1", "3"),
  ];
  const plans = planBurstHandoffs(d, 3);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].mode, "individual");
  assert.equal(plans[0].items.length, 3);
});

test("planBurstHandoffs: groups split by (agent, conversation)", () => {
  const d = [
    deliverable("a", "pr:1", "1"),
    deliverable("a", "pr:1", "2"),
    deliverable("a", "pr:1", "3"),
    deliverable("a", "pr:1", "4"), // agent a / pr:1 → 4 → digest
    deliverable("a", "pr:2", "5"), // agent a / pr:2 → 1 → individual
    deliverable("b", "pr:1", "6"), // agent b / pr:1 → 1 → individual (same conv, other agent)
  ];
  const plans = planBurstHandoffs(d, 3);
  assert.equal(plans.length, 3);
  const byKey = Object.fromEntries(plans.map(p => [`${p.agentId} ${p.convKey}`, p]));
  assert.equal(byKey["a pr:1"].mode, "digest");
  assert.equal(byKey["a pr:2"].mode, "individual");
  assert.equal(byKey["b pr:1"].mode, "individual");
});

test("planBurstHandoffs: preserves per-group event order (oldest-first)", () => {
  const d = [
    deliverable("a", "pr:1", "10"),
    deliverable("a", "pr:1", "11"),
    deliverable("a", "pr:1", "12"),
    deliverable("a", "pr:1", "13"),
  ];
  const plans = planBurstHandoffs(d, 3);
  assert.deepEqual(plans[0].items.map(i => i.ghEvent.id), ["10", "11", "12", "13"]);
});

test("planBurstHandoffs: default cap (BURST_CAP) used when cap omitted or invalid", () => {
  const many = Array.from({ length: BURST_CAP + 1 }, (_, i) => deliverable("a", "pr:1", String(i)));
  assert.equal(planBurstHandoffs(many)[0].mode, "digest");
  assert.equal(planBurstHandoffs(many, -5)[0].mode, "digest"); // invalid cap → default
  const exact = Array.from({ length: BURST_CAP }, (_, i) => deliverable("a", "pr:1", String(i)));
  assert.equal(planBurstHandoffs(exact)[0].mode, "individual");
});

test("planBurstHandoffs: cap=0 makes any non-empty group a digest", () => {
  const plans = planBurstHandoffs([deliverable("a", "pr:1", "1")], 0);
  assert.equal(plans[0].mode, "digest");
});

test("planBurstHandoffs: empty / non-array input yields no plans", () => {
  assert.deepEqual(planBurstHandoffs([], 3), []);
  assert.deepEqual(planBurstHandoffs(null, 3), []);
  assert.deepEqual(planBurstHandoffs(undefined), []);
});

test("planBurstHandoffs: deliverables without an agentId are ignored", () => {
  const d = [{ convKey: "pr:1" }, deliverable("a", "pr:1", "1")];
  const plans = planBurstHandoffs(d, 3);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].agentId, "a");
});

// ── shouldFetchNextPage (#449 pagination): page until known/partial/cap ────────

const fullPage = (startId) =>
  Array.from({ length: PER_PAGE }, (_, i) => ({ id: String(startId + i) }));

test("shouldFetchNextPage: full page, none seen, under cap → page again", () => {
  assert.equal(shouldFetchNextPage(fullPage(1000), [], 1), true);
});

test("shouldFetchNextPage: a partial page is the last one → stop", () => {
  const partial = fullPage(1000).slice(0, PER_PAGE - 1);
  assert.equal(shouldFetchNextPage(partial, [], 1), false);
});

test("shouldFetchNextPage: page containing an already-seen id → stop (reached known)", () => {
  const page = fullPage(1000);
  const seen = [String(1000 + PER_PAGE - 1)]; // last id on the page is already seen
  assert.equal(shouldFetchNextPage(page, seen, 1), false);
});

test("shouldFetchNextPage: at the page cap → stop even if full and unseen", () => {
  assert.equal(shouldFetchNextPage(fullPage(1000), [], MAX_PAGES), false);
  assert.equal(shouldFetchNextPage(fullPage(1000), [], MAX_PAGES - 1), true);
});

test("shouldFetchNextPage: empty seen set with a full page → page again", () => {
  assert.equal(shouldFetchNextPage(fullPage(1), [], 1), true);
});

test("shouldFetchNextPage: non-array / empty page → stop", () => {
  assert.equal(shouldFetchNextPage(null, [], 1), false);
  assert.equal(shouldFetchNextPage([], [], 1), false);
});
