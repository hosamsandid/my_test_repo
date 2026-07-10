"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GitHubPoller,
  effectiveHorizon,
  backfillHorizonStamps,
  passesHorizon,
  selectFreshEvents,
  planBurstHandoffs,
  shouldFetchNextPage,
  prApiUrlToHtmlUrl,
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

// ── backfillHorizonStamps (#525): pin the horizon of unstamped github triggers ─

test("backfillHorizonStamps: stamps createdAt+activatedAt on an unstamped github trigger", () => {
  const triggers = [{ id: "t1", type: "github-event", repo: "o/r", events: ["issues.labeled"] }];
  const { triggers: out, changed } = backfillHorizonStamps(triggers, "2026-05-01T00:00:00Z");
  assert.equal(changed, true);
  assert.equal(out[0].createdAt, "2026-05-01T00:00:00Z");
  assert.equal(out[0].activatedAt, "2026-05-01T00:00:00Z");
  // Other fields preserved.
  assert.equal(out[0].repo, "o/r");
  // Input not mutated.
  assert.equal(triggers[0].createdAt, undefined);
});

test("backfillHorizonStamps: already-stamped github trigger is untouched (idempotent)", () => {
  const triggers = [{ id: "t1", type: "github-event", createdAt: "2026-01-01T00:00:00Z", activatedAt: "2026-02-01T00:00:00Z" }];
  const { triggers: out, changed } = backfillHorizonStamps(triggers, "2026-05-01T00:00:00Z");
  assert.equal(changed, false);
  assert.equal(out, triggers); // same reference — no rewrite
});

test("backfillHorizonStamps: a createdAt-only trigger keeps its stable horizon", () => {
  // createdAt present ⇒ horizon already stable ⇒ leave activatedAt alone (don't flip precedence).
  const triggers = [{ id: "t1", type: "github-event", createdAt: "2026-01-01T00:00:00Z" }];
  const { triggers: out, changed } = backfillHorizonStamps(triggers, "2026-05-01T00:00:00Z");
  assert.equal(changed, false);
  assert.equal(out[0].activatedAt, undefined);
});

test("backfillHorizonStamps: preserves an existing activatedAt when only createdAt is missing", () => {
  const triggers = [{ id: "t1", type: "github-event", activatedAt: "2026-03-01T00:00:00Z" }];
  const { triggers: out, changed } = backfillHorizonStamps(triggers, "2026-05-01T00:00:00Z");
  assert.equal(changed, true);
  assert.equal(out[0].createdAt, "2026-05-01T00:00:00Z");
  assert.equal(out[0].activatedAt, "2026-03-01T00:00:00Z");
});

test("backfillHorizonStamps: non-github-event triggers are ignored", () => {
  const triggers = [
    { id: "c1", type: "cron", cron: "0 9 * * *" },
    { id: "o1", type: "once", at: "2026-05-01T00:00:00Z" },
  ];
  const { triggers: out, changed } = backfillHorizonStamps(triggers, "2026-05-01T00:00:00Z");
  assert.equal(changed, false);
  assert.equal(out, triggers);
});

test("backfillHorizonStamps: mixed set stamps only the unstamped github trigger", () => {
  const triggers = [
    { id: "g1", type: "github-event", createdAt: "2026-01-01T00:00:00Z", activatedAt: "2026-01-01T00:00:00Z" },
    { id: "g2", type: "github-event" },
    { id: "c1", type: "cron", cron: "0 9 * * *" },
  ];
  const { triggers: out, changed } = backfillHorizonStamps(triggers, "2026-05-01T00:00:00Z");
  assert.equal(changed, true);
  assert.equal(out[0].createdAt, "2026-01-01T00:00:00Z"); // untouched
  assert.equal(out[1].createdAt, "2026-05-01T00:00:00Z"); // stamped
  assert.equal(out[2].createdAt, undefined); // cron untouched
});

test("backfillHorizonStamps: guards non-arrays and missing stamp", () => {
  assert.deepEqual(backfillHorizonStamps(null, "2026-05-01T00:00:00Z"), { triggers: null, changed: false });
  const t = [{ id: "g1", type: "github-event" }];
  assert.deepEqual(backfillHorizonStamps(t, null), { triggers: t, changed: false });
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

// ── prApiUrlToHtmlUrl (#496): derive the web URL from the API `url` field ───────

test("prApiUrlToHtmlUrl: converts a pulls API url to the web pull url", () => {
  assert.equal(
    prApiUrlToHtmlUrl("https://api.github.com/repos/o/r/pulls/42"),
    "https://github.com/o/r/pull/42",
  );
});

test("prApiUrlToHtmlUrl: rejects non-matching or non-string input", () => {
  assert.equal(prApiUrlToHtmlUrl("https://api.github.com/repos/o/r/issues/42"), null);
  assert.equal(prApiUrlToHtmlUrl("not a url"), null);
  assert.equal(prApiUrlToHtmlUrl(null), null);
  assert.equal(prApiUrlToHtmlUrl(undefined), null);
});

// ── _enrichPullRequestPayload (#496 regression) ─────────────────────────────────
// Root cause: the live Events API's PullRequestEvent/PullRequestReviewEvent
// payload.pull_request is a *reduced* object (id/number/url/base/head) — no
// title, no html_url — unlike the full webhook-shaped payload the #470/#475
// synthetic tests assumed. This is what a real `gh api repos/<o>/<r>/events`
// PullRequestEvent looked like when this bug was diagnosed (trimmed to the
// fields relevant here).
const LIVE_SHAPED_PR_PAYLOAD = {
  action: "opened",
  number: 500,
  pull_request: {
    url: "https://api.github.com/repos/o/r/pulls/500",
    id: 4024312716,
    number: 500,
    base: { ref: "main" },
    head: { ref: "fix/x" },
  },
};

test("_enrichPullRequestPayload: live-shaped payload gets html_url derived and title fetched", async () => {
  const poller = new GitHubPoller();
  poller._fetchJson = async (url) => {
    assert.equal(url, "https://api.github.com/repos/o/r/pulls/500");
    return { title: "Fix the thing" };
  };
  const out = await poller._enrichPullRequestPayload(
    "pull_request.opened", LIVE_SHAPED_PR_PAYLOAD, "tok",
  );
  assert.equal(out.pull_request.title, "Fix the thing");
  assert.equal(out.pull_request.html_url, "https://github.com/o/r/pull/500");
  // Untouched fields survive.
  assert.equal(out.pull_request.number, 500);
});

test("_enrichPullRequestPayload: same reduced shape for pull_request_review events", async () => {
  const poller = new GitHubPoller();
  poller._fetchJson = async () => ({ title: "Fix the thing" });
  const out = await poller._enrichPullRequestPayload(
    "pull_request_review.submitted", LIVE_SHAPED_PR_PAYLOAD, "tok",
  );
  assert.equal(out.pull_request.title, "Fix the thing");
  assert.equal(out.pull_request.html_url, "https://github.com/o/r/pull/500");
});

test("_enrichPullRequestPayload: already-complete (webhook-shaped) payload is untouched — no fetch", async () => {
  const poller = new GitHubPoller();
  poller._fetchJson = async () => { throw new Error("should not be called"); };
  const payload = {
    pull_request: { number: 12, title: "Add feature", html_url: "https://github.com/o/r/pull/12" },
  };
  const out = await poller._enrichPullRequestPayload("pull_request.opened", payload, "tok");
  assert.equal(out, payload); // identity — untouched
});

test("_enrichPullRequestPayload: non-PR event key is untouched — no fetch", async () => {
  const poller = new GitHubPoller();
  poller._fetchJson = async () => { throw new Error("should not be called"); };
  const payload = { issue: { number: 1 } };
  const out = await poller._enrichPullRequestPayload("issues.labeled", payload, "tok");
  assert.equal(out, payload);
});

test("_enrichPullRequestPayload: title fetch failure still yields the derived html_url (graceful)", async () => {
  const poller = new GitHubPoller();
  poller._fetchJson = async () => { throw new Error("HTTP 502"); };
  const out = await poller._enrichPullRequestPayload(
    "pull_request.opened", LIVE_SHAPED_PR_PAYLOAD, "tok",
  );
  assert.equal(out.pull_request.html_url, "https://github.com/o/r/pull/500");
  assert.equal(out.pull_request.title, undefined);
});

test("_enrichPullRequestPayload: missing pull_request is untouched", async () => {
  const poller = new GitHubPoller();
  poller._fetchJson = async () => { throw new Error("should not be called"); };
  const payload = {};
  const out = await poller._enrichPullRequestPayload("pull_request.opened", payload, "tok");
  assert.equal(out, payload);
});
