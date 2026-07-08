"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  effectiveHorizon,
  passesHorizon,
  selectFreshEvents,
  GRACE_MS,
  SEEN_MAX,
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
