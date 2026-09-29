"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GitHubPoller,
  pollerSubscribes,
  parseRepoFullName,
  effectiveHorizon,
  backfillHorizonStamps,
  passesHorizon,
  selectFreshEvents,
  planBurstHandoffs,
  shouldFetchNextPage,
  prApiUrlToHtmlUrl,
  labelFilterMatches,
  GRACE_MS,
  SEEN_MAX,
  BURST_CAP,
  PER_PAGE,
  MAX_PAGES,
} = require("./github-poller");

const realEvents = require("./github-poller-events.fixture.json");

// ── parseRepoFullName (#711): github-only by default, fixture host when opted in ─

test("parseRepoFullName: parses github.com https and ssh URLs", () => {
  assert.equal(parseRepoFullName("https://github.com/acme/widgets"), "acme/widgets");
  assert.equal(parseRepoFullName("https://github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(parseRepoFullName("git@github.com:acme/widgets.git"), "acme/widgets");
});

test("parseRepoFullName: non-github host is unrecognised by default (production)", () => {
  // Byte-identical to prior behaviour: only github.com is a real repo host.
  assert.equal(parseRepoFullName("http://git-remote/e2e/fixture.git"), null);
});

test("parseRepoFullName: non-github host resolves by last two path segments when opted in", () => {
  // #711 E2E path (allowNonGithubHost, gated on a non-default GITHUB_API_BASE):
  // the in-stack git-remote fixture URL maps to the same owner/repo key the
  // fake-github events carry.
  assert.equal(
    parseRepoFullName("http://git-remote/e2e/fixture.git", { allowNonGithubHost: true }),
    "e2e/fixture",
  );
  // github.com URLs still parse identically with the flag on.
  assert.equal(
    parseRepoFullName("https://github.com/acme/widgets", { allowNonGithubHost: true }),
    "acme/widgets",
  );
});

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

// ── labelFilterMatches (webhook-shape coverage) ───────────────────────────────
// These fixtures are WEBHOOK-shaped (nested `issue.labels`) — a shape the Events
// API never emits (it puts the label set at the payload top level, see the
// fixture-backed tests below). They exercise the nested fallback that still
// serves the e2e fake-github and any future webhook ingress.

const labeledEvent = (attributed, currentLabels) => ({
  type: "IssuesEvent",
  payload: {
    action: "labeled",
    label: attributed ? { name: attributed } : undefined,
    issue: { number: 1, labels: (currentLabels || []).map((name) => ({ name })) },
  },
});

test("labelFilterMatches: matches the directly-attributed label", () => {
  assert.equal(labelFilterMatches(labeledEvent("ready", ["ready"]), "ready"), true);
});

test("labelFilterMatches: no filter fires on any label change", () => {
  assert.equal(labelFilterMatches(labeledEvent("ux", ["ux"]), null), true);
});

test("labelFilterMatches: (webhook shape) recovers a collapsed multi-add via nested labels — attributed 'ux', 'ready' also present", () => {
  // Webhook-shaped fallback: adding bug+ux+ready in one action surfaces
  // labeled(ux); the 'ready' wake still fires because 'ready' is in the nested
  // label set. (On the Events API the same recovery comes from payload.labels.)
  assert.equal(labelFilterMatches(labeledEvent("ux", ["bug", "ux", "ready"]), "ready"), true);
});

test("labelFilterMatches: still drops a labeled event when the wanted label is truly absent", () => {
  assert.equal(labelFilterMatches(labeledEvent("ux", ["bug", "ux"]), "ready"), false);
});

test("labelFilterMatches: unlabeled matches only the removed label, not the current set", () => {
  // On removal the wanted label is (correctly) gone from the current set; only
  // the directly-named payload.label counts — no false-positive from siblings.
  const unlabeled = {
    type: "IssuesEvent",
    payload: { action: "unlabeled", label: { name: "ready" }, issue: { number: 1, labels: [{ name: "bug" }] } },
  };
  assert.equal(labelFilterMatches(unlabeled, "ready"), true);
  assert.equal(labelFilterMatches(unlabeled, "bug"), false); // 'bug' still present, but this event didn't touch it
});

test("labelFilterMatches: (webhook shape) pull_request labeled honours the nested label set", () => {
  // Webhook-shaped only: a real Events-API PullRequestEvent never carries
  // pull_request.labels (see the fixture-backed tests). Kept as fallback
  // coverage for webhook ingress.
  const prLabeled = {
    type: "PullRequestEvent",
    payload: {
      action: "labeled",
      label: { name: "needs-review" },
      pull_request: { number: 7, labels: [{ name: "needs-review" }, { name: "revisions-required" }] },
    },
  };
  assert.equal(labelFilterMatches(prLabeled, "revisions-required"), true);
});

test("labelFilterMatches: a truly reduced payload (no label set anywhere) only matches the attributed label", () => {
  // Neither a top-level nor a nested label set — the degenerate case. The
  // directly-attributed label still matches; an unrelated label finds no set to
  // recover from and does not crash. (Real Events-API PR events are NOT this
  // shape — they carry payload.labels; see incidentPrLabeled below.)
  const reduced = { type: "PullRequestEvent", payload: { action: "labeled", label: { name: "x" }, pull_request: { number: 7 } } };
  assert.equal(labelFilterMatches(reduced, "x"), true);
  assert.equal(labelFilterMatches(reduced, "y"), false);
});

// ── labelFilterMatches (real Events-API payloads, #1376) ──────────────────────
// Verbatim captured Events-API entries; assert the top-level `payload.labels`
// set is what drives the match — the nested webhook arrays are wrong here.

test("labelFilterMatches: (real) incident PR event 12860294824 matches the base wake label", () => {
  // Regression test for #1376: payload.label is the ':completed' claim marker,
  // but the base wake label 'florian-03:ready-for-review' is in payload.labels.
  const ev = realEvents.incidentPrLabeled;
  assert.equal(ev.id, "12860294824");
  assert.equal(ev.payload.label.name, "florian-03:ready-for-review:completed");
  assert.equal(Object.prototype.hasOwnProperty.call(ev.payload.pull_request, "labels"), false);
  assert.equal(labelFilterMatches(ev, "florian-03:ready-for-review"), true);
});

test("labelFilterMatches: (real) base wake fires on a PR carrying :wip / :completed claim markers", () => {
  // The multi-round review/rework case: the base label coexists with claim
  // markers; each such PR labeled event still wakes the base-label listener.
  const ev = realEvents.incidentPrLabeled;
  assert.equal(labelFilterMatches(ev, "florian-03:ready-for-review"), true);
  assert.equal(labelFilterMatches(ev, "florian-03:ready-for-review:completed"), true);
});

test("labelFilterMatches: (real) IssuesEvent uses event-time payload.labels, not the late-bound issue.labels snapshot", () => {
  // Event 12842942084: payload.labels = ['florian-03:ready'] (event time), while
  // payload.issue.labels = ['florian-03:ready:completed'] (a snapshot read 7 min
  // later). The wake label must match; the late-bound-only label must NOT.
  const ev = realEvents.lateBoundIssueLabeled;
  assert.equal(ev.id, "12842942084");
  assert.deepEqual(ev.payload.labels.map((l) => l.name), ["florian-03:ready"]);
  assert.deepEqual(ev.payload.issue.labels.map((l) => l.name), ["florian-03:ready:completed"]);
  assert.equal(labelFilterMatches(ev, "florian-03:ready"), true);
  assert.equal(labelFilterMatches(ev, "florian-03:ready:completed"), false);
});

test("labelFilterMatches: (real) top-level labels wins even though the direct label also matches", () => {
  // Sanity: the attributed-label short-circuit doesn't hide the payload.labels
  // path — matching the directly-named label still works on a real event.
  const ev = realEvents.lateBoundIssueLabeled;
  assert.equal(labelFilterMatches(ev, "florian-03:ready"), true);
});

test("labelFilterMatches: (fixture) genuinely webhook-shaped payload still recovers via nested labels", () => {
  // No top-level payload.labels → nested fallback must keep working so the e2e
  // fake-github path does not regress.
  const ev = realEvents.webhookShapedIssueLabeled;
  assert.equal(Object.prototype.hasOwnProperty.call(ev.payload, "labels"), false);
  assert.equal(labelFilterMatches(ev, "team-x:ready"), true);
  assert.equal(labelFilterMatches(ev, "bug"), true);
  assert.equal(labelFilterMatches(ev, "absent"), false);
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

// ── closesIssues enrichment (#1833 item 3) ──────────────────────────────────
test("_enrichPullRequestPayload: derives closesIssues from the fetched body (#1833)", async () => {
  const poller = new GitHubPoller();
  poller._fetchJson = async () => ({ title: "Fix it", body: "Some work.\n\nCloses #1796 and fixes #1797." });
  const out = await poller._enrichPullRequestPayload(
    "pull_request.opened", LIVE_SHAPED_PR_PAYLOAD, "tok",
  );
  assert.deepEqual(out.pull_request.closesIssues, [1796, 1797]);
  assert.equal(out.pull_request.title, "Fix it");
  assert.equal(out.pull_request.html_url, "https://github.com/o/r/pull/500");
});

test("_enrichPullRequestPayload: derives closesIssues from the head branch name without a body (#1833)", async () => {
  const poller = new GitHubPoller();
  poller._fetchJson = async () => ({ title: "Fix it" }); // no body in the detail
  const payload = {
    pull_request: {
      url: "https://api.github.com/repos/o/r/pulls/500", number: 500,
      head: { ref: "feat/issue-1833-thing" },
    },
  };
  const out = await poller._enrichPullRequestPayload("pull_request.opened", payload, "tok");
  assert.deepEqual(out.pull_request.closesIssues, [1833]);
});

test("_enrichPullRequestPayload: no closesIssues key when nothing is parseable (#1833)", async () => {
  const poller = new GitHubPoller();
  poller._fetchJson = async () => ({ title: "Fix it", body: "Just a change, no keywords." });
  const out = await poller._enrichPullRequestPayload(
    "pull_request.opened", LIVE_SHAPED_PR_PAYLOAD, "tok",
  );
  assert.equal("closesIssues" in out.pull_request, false);
});

test("_enrichPullRequestPayload: a fetch failure still parses closes from the branch (#1833)", async () => {
  const poller = new GitHubPoller();
  poller._fetchJson = async () => { throw new Error("HTTP 502"); };
  const payload = {
    pull_request: {
      url: "https://api.github.com/repos/o/r/pulls/500", number: 500,
      head: { ref: "fix/issue-42" },
    },
  };
  const out = await poller._enrichPullRequestPayload("pull_request.opened", payload, "tok");
  assert.deepEqual(out.pull_request.closesIssues, [42]);
  assert.equal(out.pull_request.html_url, "https://github.com/o/r/pull/500");
});

// ── pollerSubscribes (#1173): internal-channel triggers never enter the plan ─
//
// The exclusion below is the SINGLE dedup mechanism of the internal-channels
// design: /internal/flow-emit mirrors the label onto GitHub after delivering
// the wake through the queue, and that stamp may never wake the listener a
// second time via the poller (docs/internal-channels-concept.md §4.3).

const subscribable = (over = {}) => ({
  id: "t1", type: "github-event", repo: "org/repo",
  events: ["issues.labeled"], labelFilter: "ready",
  ...over,
});

test("pollerSubscribes: a plain github-event trigger subscribes", () => {
  assert.equal(pollerSubscribes(subscribable()), true);
  assert.equal(pollerSubscribes(subscribable({ transport: "github" })), true);
});

test("pollerSubscribes: transport 'internal' is excluded — the label mirror cannot double-deliver", () => {
  assert.equal(pollerSubscribes(subscribable({ transport: "internal" })), false);
});

test("pollerSubscribes: disabled, wrong-type and malformed triggers are excluded", () => {
  assert.equal(pollerSubscribes(subscribable({ enabled: false })), false);
  assert.equal(pollerSubscribes(subscribable({ type: "cron" })), false);
  assert.equal(pollerSubscribes(subscribable({ repo: undefined })), false);
  assert.equal(pollerSubscribes(subscribable({ events: [] })), false);
  assert.equal(pollerSubscribes(null), false);
});

// ── _fanOutBatch: wakeLabel attribution (#1846) ──────────────────────────────
//
// AC8: a collapsed issues.labeled event where payload.label.name='ux' (the
// arbitrarily-named single label the Events API surfaces) but payload.labels
// includes 'ready'. A subscriber on labelFilter:'ready' must see wakeLabel:'ready'
// in the recorded outcome, not 'ux'. This reproduces the reported case.

const githubEventLog = require("./github-event-log");

test("_fanOutBatch: wakeLabel on outcome = subscriber's labelFilter, not collapsed payload.label.name (AC8)", async () => {
  // Capture event-log records without touching the filesystem.
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const poller = new GitHubPoller();
    // Suppress file I/O side-effects irrelevant to this test.
    poller._enqueuePending = () => {};

    // Collapsed event: the Events API named 'ux' as payload.label, but both
    // 'ux' and 'ready' were added in one action and appear in payload.labels.
    const ghEvent = {
      id: "ac8-collapsed-1",
      actor: { login: "thorsten" },
      created_at: new Date().toISOString(),
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "ux" },
        labels: [{ name: "ux" }, { name: "ready" }],
        issue: { number: 1846, title: "Test", html_url: "https://github.com/org/repo/issues/1846" },
      },
    };

    const subscribers = [{
      agentId: "developer",
      triggerId: "trigger-ready",
      events: new Set(["issues.labeled"]),
      labelFilter: "ready",
      horizon: null,
    }];

    await poller._fanOutBatch("org/repo", [ghEvent], subscribers, "tok");

    assert.equal(recorded.length, 1, "one event should be recorded");
    const entry = recorded[0];
    // Event-level label stays as the raw collapsed value — unchanged.
    assert.equal(entry.label, "ux");
    // The single outcome was delivered and attributed to the matched filter.
    assert.equal(entry.outcomes.length, 1);
    assert.equal(entry.outcomes[0].status, "delivered");
    assert.equal(entry.outcomes[0].wakeLabel, "ready",
      "wakeLabel must be the subscriber's labelFilter, not the collapsed payload.label.name");
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch: a dispatch the WIP lane HOLDS is recorded 'held', not 'delivered' (label-fix)", async () => {
  // The event-log used to record 'delivered' unconditionally, even when
  // admission control held the dispatch behind a full wipLimit — so the log
  // claimed a session ran when none did, and the chip dead-ended on "no
  // session". The poller now reads the admission verdict from the enqueue
  // decision and records the TRUE outcome.
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const poller = new GitHubPoller();
    // Simulate the orchestrator's enqueuePending holding this dispatch: it fills
    // the decision out-parameter exactly as the real one does on a full lane.
    poller._enqueuePending = (agentId, entry, decision) => {
      if (decision) { decision.held = true; decision.reason = 'wip'; decision.wipLimit = 3; decision.ticketKey = 'org/repo#1846'; }
    };

    const ghEvent = {
      id: "held-1",
      actor: { login: "thorsten" },
      created_at: new Date().toISOString(),
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "ready" },
        issue: { number: 1846, title: "Test", html_url: "https://github.com/org/repo/issues/1846" },
      },
    };
    const subscribers = [{
      agentId: "developer",
      triggerId: "trigger-ready",
      events: new Set(["issues.labeled"]),
      labelFilter: "ready",
      horizon: null,
    }];

    await poller._fanOutBatch("org/repo", [ghEvent], subscribers, "tok");

    assert.equal(recorded.length, 1);
    const [o] = recorded[0].outcomes;
    assert.equal(o.status, "held", "a held dispatch must record status 'held', never 'delivered'");
    assert.equal(o.reason, "wip");
    assert.equal(o.wipLimit, 3, "the flow's wipLimit rides on the outcome so the chip reads 'held (WIP 3)'");
  } finally {
    githubEventLog.record = origRecord;
  }
});

// ── #2151: the pending entry itself carries the stamp, not just the event-log
// outcome — this is what the trigger-fired notice and the Pending queue read.
test("_fanOutBatch: the pending entry is stamped with the matched wakeLabel, not the collapsed payload.label.name (#2151)", async () => {
  const origRecord = githubEventLog.record;
  githubEventLog.record = () => {};
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    const ghEvent = {
      id: "2151-collapsed-1",
      actor: { login: "thorsten" },
      created_at: new Date().toISOString(),
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "flow-control" },
        labels: [{ name: "flow-control" }, { name: "ready" }],
        issue: { number: 2151, title: "Test", html_url: "https://github.com/org/repo/issues/2151" },
      },
    };

    const subscribers = [{
      agentId: "developer",
      triggerId: "trigger-ready",
      events: new Set(["issues.labeled"]),
      labelFilter: "ready",
      horizon: null,
    }];

    await poller._fanOutBatch("org/repo", [ghEvent], subscribers, "tok");

    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].agentId, "developer");
    assert.equal(enqueued[0].entry.wakeLabel, "ready",
      "the queued entry's wakeLabel must be the matched labelFilter, not payload.label.name ('flow-control')");
    assert.equal(enqueued[0].entry.github.payload.label.name, "flow-control",
      "the raw payload is carried unchanged alongside the stamp");
  } finally {
    githubEventLog.record = origRecord;
  }
});

// ── #2152: edge-triggered wake dedup — a full-set match fires only on the
// rising edge, so unrelated label churn and the agent's own claim swap don't
// re-wake it while the wake label merely persists.

function labeledIssueEvent(id, attributedLabel, fullSet, number = 2152) {
  return {
    id,
    actor: { login: "thorsten" },
    created_at: new Date().toISOString(),
    type: "IssuesEvent",
    repo: { name: "org/repo" },
    payload: {
      action: "labeled",
      label: { name: attributedLabel },
      labels: fullSet.map((name) => ({ name })),
      issue: { number, title: "Repo attach dialog", html_url: `https://github.com/org/repo/issues/${number}` },
    },
  };
}

function unlabeledIssueEvent(id, removedLabel, fullSet, number = 2152) {
  return {
    id,
    actor: { login: "thorsten" },
    created_at: new Date().toISOString(),
    type: "IssuesEvent",
    repo: { name: "org/repo" },
    payload: {
      action: "unlabeled",
      label: { name: removedLabel },
      labels: fullSet.map((name) => ({ name })),
      issue: { number, title: "Repo attach dialog", html_url: `https://github.com/org/repo/issues/${number}` },
    },
  };
}

const readyDeveloperSub = () => [{
  agentId: "developer",
  triggerId: "t1785499525109689",
  events: new Set(["issues.labeled"]),
  labelFilter: "ready",
  horizon: null,
}];

test("_fanOutBatch (#2152): the agent's own claim swap does not re-wake it — second labeled event dropped 'wake-already-armed'", async () => {
  const origRecord = githubEventLog.record;
  const recorded = [];
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    // Event 1: the genuine human wake. `ready` present in the full set.
    const ev1 = labeledIssueEvent("2152-a", "ready", ["next-wave", "ready"]);
    // Event 2: the developer's OWN claim swap adds `ready:wip`; the event-time
    // snapshot still carries `ready`, and the Events API mis-attributes the
    // event's own label as `next-wave` (so the self-claim-label guard, which
    // keys on payload.label.name, cannot catch it — the real #2152 signature).
    const ev2 = labeledIssueEvent("2152-b", "next-wave", ["next-wave", "ready", "ready:wip"]);

    await poller._fanOutBatch("org/repo", [ev1, ev2], readyDeveloperSub(), "tok");

    assert.equal(enqueued.length, 1, "only the first (rising-edge) wake is delivered");
    assert.equal(enqueued[0].entry.github.eventId, "2152-a");

    const outcomes = recorded.flatMap((e) => e.outcomes || []).filter((o) => o.agentId === "developer");
    const delivered = outcomes.filter((o) => o.status === "delivered");
    const dropped = outcomes.filter((o) => o.status === "dropped");
    assert.equal(delivered.length, 1);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].reason, "wake-already-armed");
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch (#2152): a genuine remove -> re-add re-fires (disarm reopens the edge)", async () => {
  const origRecord = githubEventLog.record;
  githubEventLog.record = () => {};
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    const ev1 = labeledIssueEvent("2152-x1", "ready", ["ready"]);          // deliver + arm
    const ev2 = unlabeledIssueEvent("2152-x2", "ready", []);               // human removes `ready` -> disarm
    const ev3 = labeledIssueEvent("2152-x3", "ready", ["ready"]);          // human re-adds -> fires again

    await poller._fanOutBatch("org/repo", [ev1, ev2, ev3], readyDeveloperSub(), "tok");

    assert.equal(enqueued.length, 2, "the re-add after a real removal must fire again");
    assert.deepEqual(enqueued.map((e) => e.entry.github.eventId), ["2152-x1", "2152-x3"]);
  } finally {
    githubEventLog.record = origRecord;
  }
});

const reviewerSub = () => [{
  agentId: "code-reviewer",
  triggerId: "code-reviewer-on-pr-ready-for-review",
  events: new Set(["issues.labeled"]),
  labelFilter: "ready-for-review",
  claimAdd: "ready-for-review:wip",
  horizon: null,
}];

test("_fanOutBatch (#2152 follow-up): the collapsed claim swap disarms the wake, so a later re-hand-off re-fires", async () => {
  const origRecord = githubEventLog.record;
  githubEventLog.record = () => {};
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    // 1. the genuine upstream wake — arm + fire.
    const ev1 = labeledIssueEvent("csw-1", "ready-for-review", ["ready-for-review"], 2187);
    // 2. the agent's OWN claim swap: `gh issue edit --remove ready-for-review
    //    --add ready-for-review:wip` is ONE action, which the Events API
    //    collapses to a single labeled(ready-for-review:wip). No standalone
    //    unlabeled(ready-for-review) ever arrives, so this claim-label add is the
    //    only disarm signal there is. Its event-time snapshot still carries
    //    `ready-for-review` (the paired remove is not atomic).
    const ev2 = labeledIssueEvent(
      "csw-2", "ready-for-review:wip",
      ["ready-for-review", "ready-for-review:wip"], 2187,
    );
    // 3. the reworker delegates back by re-adding `ready-for-review` (a bare
    //    --add-label; on GitHub the label has been absent since the swap). Before
    //    this fix the stale arm dropped it as 'wake-already-armed'; now it fires.
    const ev3 = labeledIssueEvent("csw-3", "ready-for-review", ["ready-for-review"], 2187);

    await poller._fanOutBatch("org/repo", [ev1, ev2, ev3], reviewerSub(), "tok");

    assert.deepEqual(
      enqueued.map((e) => e.entry.github.eventId),
      ["csw-1", "csw-3"],
      "the rising-edge wake AND the post-swap re-hand-off both fire",
    );
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch (#2152 follow-up): the disarm does not re-open the double-fire (unrelated churn after the swap stays dropped)", async () => {
  const origRecord = githubEventLog.record;
  githubEventLog.record = () => {};
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    const ev1 = labeledIssueEvent("csw2-1", "ready-for-review", ["ready-for-review"], 2190);
    // claim swap disarms `ready-for-review`; on GitHub the label is now gone.
    const ev2 = labeledIssueEvent(
      "csw2-2", "ready-for-review:wip",
      ["ready-for-review", "ready-for-review:wip"], 2190,
    );
    // unrelated churn AFTER the swap — a current snapshot no longer carries
    // `ready-for-review`, so full-set matching must not re-fire the reviewer.
    const ev3 = labeledIssueEvent("csw2-3", "bug", ["ready-for-review:wip", "bug"], 2190);

    await poller._fanOutBatch("org/repo", [ev1, ev2, ev3], reviewerSub(), "tok");

    assert.deepEqual(
      enqueued.map((e) => e.entry.github.eventId),
      ["csw2-1"],
      "only the rising-edge wake fires; post-swap churn without the wake label does not",
    );
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch (#2152 follow-up): presence-based disarm re-opens the edge with NO unlabeled and NO claim swap (human web-UI removal)", async () => {
  const origRecord = githubEventLog.record;
  githubEventLog.record = () => {};
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    // 1. wake — arm `ready`.
    const ev1 = labeledIssueEvent("pd-1", "ready", ["ready"], 2153);
    // 2. `ready` is gone from the object's full set (a human removed it in the
    //    web UI — no unlabeled event ever reaches the poller). An unrelated label
    //    add is the next thing the poller sees; its snapshot no longer lists
    //    `ready`, so the presence-based disarm clears the stale arm.
    const ev2 = labeledIssueEvent("pd-2", "other", ["other"], 2153);
    // 3. `ready` re-added → not armed → fires again.
    const ev3 = labeledIssueEvent("pd-3", "ready", ["ready", "other"], 2153);

    await poller._fanOutBatch("org/repo", [ev1, ev2, ev3], readyDeveloperSub(), "tok");

    assert.deepEqual(
      enqueued.map((e) => e.entry.github.eventId),
      ["pd-1", "pd-3"],
      "the wake re-fires once the label is observed absent, without any removal event",
    );
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch (#2152 follow-up): presence-based disarm does NOT fire while the wake label persists", async () => {
  const origRecord = githubEventLog.record;
  githubEventLog.record = () => {};
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    const ev1 = labeledIssueEvent("pp-1", "ready", ["next-wave", "ready"], 2154);
    // unrelated churn while `ready` is STILL on the object — the snapshot lists
    // it, so presence-based disarm must keep the arm and the churn stays dropped.
    const ev2 = labeledIssueEvent("pp-2", "next-wave", ["next-wave", "ready"], 2154);

    await poller._fanOutBatch("org/repo", [ev1, ev2], readyDeveloperSub(), "tok");

    assert.deepEqual(
      enqueued.map((e) => e.entry.github.eventId),
      ["pp-1"],
      "only the rising-edge wake fires; churn while the label persists does not",
    );
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch (#2152): the #1376 collapsed multi-add still fires (rising edge, not a regression)", async () => {
  const origRecord = githubEventLog.record;
  githubEventLog.record = () => {};
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    // One action adds `bug`+`ready`; the Events API surfaces it attributed to
    // `bug`. The full-set recovery must still fire the `ready` listener.
    const ev = labeledIssueEvent("2152-collapse", "bug", ["bug", "ready"], 2160);
    await poller._fanOutBatch("org/repo", [ev], readyDeveloperSub(), "tok");
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].entry.wakeLabel, "ready");
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch (#2152): kill-switch AEE_WAKE_EDGE_DEDUP=0 restores the double-fire", async () => {
  const origRecord = githubEventLog.record;
  githubEventLog.record = () => {};
  const prev = process.env.AEE_WAKE_EDGE_DEDUP;
  process.env.AEE_WAKE_EDGE_DEDUP = "0";
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    const ev1 = labeledIssueEvent("2152-k1", "ready", ["next-wave", "ready"]);
    const ev2 = labeledIssueEvent("2152-k2", "next-wave", ["next-wave", "ready", "ready:wip"]);
    await poller._fanOutBatch("org/repo", [ev1, ev2], readyDeveloperSub(), "tok");

    assert.equal(enqueued.length, 2, "with the kill-switch off, the pre-#2152 full-set match still double-fires");
  } finally {
    githubEventLog.record = origRecord;
    if (prev === undefined) delete process.env.AEE_WAKE_EDGE_DEDUP;
    else process.env.AEE_WAKE_EDGE_DEDUP = prev;
  }
});

// ── #2151: an any-label listener's pending entry stamps wakeLabel null —
// matching the event-log outcome convention, so the entrypoint's ladder
// falls through to payload.label.name for exactly the case that is correct.
test("_fanOutBatch: an any-label listener's pending entry stamps wakeLabel null (#2151)", async () => {
  const origRecord = githubEventLog.record;
  githubEventLog.record = () => {};
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    const ghEvent = {
      id: "2151-any-label-1",
      actor: { login: "user" },
      created_at: new Date().toISOString(),
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "ux" },
        labels: [{ name: "ux" }],
        issue: { number: 5, title: "Any-label", html_url: "https://github.com/org/repo/issues/5" },
      },
    };

    const subscribers = [
      { agentId: "any-listener", triggerId: "t-any", events: new Set(["issues.labeled"]), labelFilter: null, horizon: null },
    ];

    await poller._fanOutBatch("org/repo", [ghEvent], subscribers, "tok");

    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].entry.wakeLabel, null);
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch: each of two subscribers on different labelFilters gets its own wakeLabel (AC2)", async () => {
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const poller = new GitHubPoller();
    poller._enqueuePending = () => {};

    const ghEvent = {
      id: "ac2-collapsed-1",
      actor: { login: "user" },
      created_at: new Date().toISOString(),
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "ux" },
        labels: [{ name: "ux" }, { name: "ready" }, { name: "ready-2" }],
        issue: { number: 2, title: "Two subscribers", html_url: "https://github.com/org/repo/issues/2" },
      },
    };

    const subscribers = [
      { agentId: "developer-1", triggerId: "t-ready",   events: new Set(["issues.labeled"]), labelFilter: "ready",   horizon: null },
      { agentId: "developer-2", triggerId: "t-ready-2", events: new Set(["issues.labeled"]), labelFilter: "ready-2", horizon: null },
    ];

    await poller._fanOutBatch("org/repo", [ghEvent], subscribers, "tok");

    assert.equal(recorded.length, 1);
    const entry = recorded[0];
    assert.equal(entry.outcomes.length, 2);
    const by = Object.fromEntries(entry.outcomes.map((o) => [o.agentId, o]));
    assert.equal(by["developer-1"].wakeLabel, "ready");
    assert.equal(by["developer-2"].wakeLabel, "ready-2");
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch: any-label listener (no labelFilter) gets wakeLabel null, not the collapsed label (AC3)", async () => {
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const poller = new GitHubPoller();
    poller._enqueuePending = () => {};

    const ghEvent = {
      id: "ac3-any-label-1",
      actor: { login: "user" },
      created_at: new Date().toISOString(),
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "ux" },
        labels: [{ name: "ux" }],
        issue: { number: 3, title: "Any-label", html_url: "https://github.com/org/repo/issues/3" },
      },
    };

    const subscribers = [
      { agentId: "any-listener", triggerId: "t-any", events: new Set(["issues.labeled"]), labelFilter: null, horizon: null },
    ];

    await poller._fanOutBatch("org/repo", [ghEvent], subscribers, "tok");

    assert.equal(recorded.length, 1);
    const entry = recorded[0];
    assert.equal(entry.outcomes.length, 1);
    assert.equal(entry.outcomes[0].status, "delivered");
    assert.equal(entry.outcomes[0].wakeLabel, null,
      "any-label listener must have wakeLabel null, not the collapsed label name");
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch: label-filter-dropped outcome carries no wakeLabel", async () => {
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const poller = new GitHubPoller();
    poller._enqueuePending = () => {};

    const ghEvent = {
      id: "ac-drop-1",
      actor: { login: "user" },
      created_at: new Date().toISOString(),
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "ux" },
        labels: [{ name: "ux" }],
        issue: { number: 4, title: "Drop test", html_url: "https://github.com/org/repo/issues/4" },
      },
    };

    const subscribers = [
      { agentId: "developer", triggerId: "t1", events: new Set(["issues.labeled"]), labelFilter: "ready", horizon: null },
    ];

    await poller._fanOutBatch("org/repo", [ghEvent], subscribers, "tok");

    assert.equal(recorded.length, 1);
    const entry = recorded[0];
    assert.equal(entry.outcomes.length, 1);
    assert.equal(entry.outcomes[0].status, "dropped");
    assert.equal(entry.outcomes[0].reason, "label-filter");
    // No wakeLabel on a label-filter drop — the label did not match.
    assert.equal(entry.outcomes[0].wakeLabel, undefined);
  } finally {
    githubEventLog.record = origRecord;
  }
});

// ── _fanOutBatch: internal fast-path dedup (#1858) ───────────────────────────
//
// When a human-applied label was already delivered internally (Admin Console →
// /internal/github-label-applied wrote a dedup marker), the later Events-API
// delivery of the SAME label must be dropped (reason: 'internal-dedup') instead
// of waking the agent a second time — and recorded as such in the event log.

const { LabelDedupMarkers } = require("./label-dedup-markers");

test("_fanOutBatch: drops a labeled event already delivered internally (AC3)", async () => {
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const markers = new LabelDedupMarkers();
    const poller = new GitHubPoller({ labelMarkers: markers });
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    const createdAt = new Date().toISOString();
    // The internal path delivered this exact wake and armed a marker.
    markers.add({
      agentId: "developer", triggerId: "t-ready",
      repo: "org/repo", kind: "issue", number: 1858, label: "ready",
      appliedAt: createdAt,
    });

    const ghEvent = {
      id: "dedup-1",
      actor: { login: "thorsten" },
      created_at: createdAt,
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "ready" },
        issue: { number: 1858, title: "Test", html_url: "https://github.com/org/repo/issues/1858" },
      },
    };
    const subscribers = [{
      agentId: "developer", triggerId: "t-ready",
      events: new Set(["issues.labeled"]), labelFilter: "ready", horizon: null,
    }];

    await poller._fanOutBatch("org/repo", [ghEvent], subscribers, "tok");

    assert.equal(enqueued.length, 0, "the duplicate poller event must NOT be enqueued");
    assert.equal(recorded.length, 1);
    const outcome = recorded[0].outcomes[0];
    assert.equal(outcome.status, "dropped");
    assert.equal(outcome.reason, "internal-dedup");
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch: a legitimate later re-label still fires (marker outside window / consumed) (AC4)", async () => {
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const markers = new LabelDedupMarkers();
    const poller = new GitHubPoller({ labelMarkers: markers });
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    // The first apply was delivered internally an hour ago.
    const firstApply = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    markers.add({
      agentId: "developer", triggerId: "t-ready",
      repo: "org/repo", kind: "issue", number: 1858, label: "ready",
      appliedAt: firstApply,
    });

    // A poller event for a fresh re-label now (remove → re-add) — newer
    // created_at, outside the marker's match window → must deliver.
    const ghEvent = {
      id: "relabel-1",
      actor: { login: "thorsten" },
      created_at: new Date().toISOString(),
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "ready" },
        issue: { number: 1858, title: "Test", html_url: "https://github.com/org/repo/issues/1858" },
      },
    };
    const subscribers = [{
      agentId: "developer", triggerId: "t-ready",
      events: new Set(["issues.labeled"]), labelFilter: "ready", horizon: null,
    }];

    await poller._fanOutBatch("org/repo", [ghEvent], subscribers, "tok");

    assert.equal(enqueued.length, 1, "the legitimate re-label must be enqueued");
    assert.equal(recorded[0].outcomes[0].status, "delivered");
  } finally {
    githubEventLog.record = origRecord;
  }
});

// ── _fanOutBatch: double-fire regressions (self-claim-label + window dedup) ───
//
// Two live double-fires this hardens against, both rooted in labelFilterMatches
// firing off the event-time label SET (the #1376 collapsed-multi-add recovery):
//
//  (A) 2026-09-06 #1960: a human applied `ready` once. The claim swap then added
//      `ready:wip`, whose own issues.labeled event still carried `ready` in its
//      snapshot → matched the `ready` filter → the agent fired a SECOND time on
//      its own status label. Fix: drop an event whose directly-added label is the
//      trigger's own claim label (reason: 'self-claim-label').
//
//  (B) 2026-09-07 #2026: a human applied `ready` (delivered internally) then a
//      second label `ux` seconds later; the Events API surfaced TWO `ux` events
//      that both still carried `ready`. Consume-once deduped only the first; the
//      second double-woke the agent. Fix: the dedup window drops EVERY echo of
//      one apply, not just the first.

test("_fanOutBatch: the claim swap's own <wake>:wip add is dropped, not re-fired (#1960 regression)", async () => {
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    // issues.labeled(ready:wip) whose event-time set STILL carries `ready`
    // (the paired remove of `ready` hadn't propagated into the snapshot).
    const ghEvent = {
      id: "selfclaim-1",
      actor: { login: "thorsten" },
      created_at: new Date().toISOString(),
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "ready:wip" },
        labels: [{ name: "ready:wip" }, { name: "ready" }],
        issue: { number: 1960, title: "Test", html_url: "https://github.com/org/repo/issues/1960" },
      },
    };
    const subscribers = [{
      agentId: "developer", triggerId: "t-ready",
      events: new Set(["issues.labeled"]),
      labelFilter: "ready", claimAdd: "ready:wip", horizon: null,
    }];

    await poller._fanOutBatch("org/repo", [ghEvent], subscribers, "tok");

    assert.equal(enqueued.length, 0, "the self-caused claim-label event must NOT wake the agent");
    const outcome = recorded[0].outcomes[0];
    assert.equal(outcome.status, "dropped");
    assert.equal(outcome.reason, "self-claim-label");
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch: a genuine human re-add of the wake label still fires even when the trigger declares a claim", async () => {
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const poller = new GitHubPoller();
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    // The directly-added label IS the wake label — a real human wake, not the
    // agent's `ready:wip` decoration. The self-claim gate must not touch it.
    const ghEvent = {
      id: "genuine-1",
      actor: { login: "thorsten" },
      created_at: new Date().toISOString(),
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "ready" },
        labels: [{ name: "ready" }],
        issue: { number: 1961, title: "Test", html_url: "https://github.com/org/repo/issues/1961" },
      },
    };
    const subscribers = [{
      agentId: "developer", triggerId: "t-ready",
      events: new Set(["issues.labeled"]),
      labelFilter: "ready", claimAdd: "ready:wip", horizon: null,
    }];

    await poller._fanOutBatch("org/repo", [ghEvent], subscribers, "tok");

    assert.equal(enqueued.length, 1, "a genuine ready re-add must still wake the agent");
    assert.equal(recorded[0].outcomes[0].status, "delivered");
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("_fanOutBatch: window dedup drops EVERY echo of one apply, not just the first (#2026 regression)", async () => {
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const markers = new LabelDedupMarkers();
    const poller = new GitHubPoller({ labelMarkers: markers });
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    const base = Date.now();
    // The internal path delivered the `ready` apply and armed a marker.
    markers.add({
      agentId: "developer", triggerId: "t-ready",
      repo: "org/repo", kind: "issue", number: 2026, label: "ready",
      appliedAt: new Date(base).toISOString(),
    });

    // Two collapsed `ux` events seconds apart, both still carrying `ready` in
    // their snapshot → both match the `ready` filter via the full set. Both are
    // within the marker window; consume-once would have let the second through.
    const uxEvent = (id, offsetMs) => ({
      id,
      actor: { login: "thorsten" },
      created_at: new Date(base + offsetMs).toISOString(),
      type: "IssuesEvent",
      repo: { name: "org/repo" },
      payload: {
        action: "labeled",
        label: { name: "ux" },
        labels: [{ name: "ux" }, { name: "ready" }],
        issue: { number: 2026, title: "Test", html_url: "https://github.com/org/repo/issues/2026" },
      },
    });
    const subscribers = [{
      agentId: "developer", triggerId: "t-ready",
      events: new Set(["issues.labeled"]),
      labelFilter: "ready", horizon: null,
    }];

    await poller._fanOutBatch(
      "org/repo",
      [uxEvent("ux-echo-1", 3_000), uxEvent("ux-echo-2", 33_000)],
      subscribers, "tok",
    );

    assert.equal(enqueued.length, 0, "no echo of the same apply may wake the agent");
    assert.equal(recorded.length, 2);
    for (const entry of recorded) {
      assert.equal(entry.outcomes[0].status, "dropped");
      assert.equal(entry.outcomes[0].reason, "internal-dedup");
    }
  } finally {
    githubEventLog.record = origRecord;
  }
});

// ── #2529: the branch-creating first push reaches `['push']` via pull_request.opened ─
//
// The Events API emits no PushEvent for the push that creates a branch; the PR
// opened from it is the only signal. The poller synthesises a push-class event
// from it and de-dups push wakes per (ref, head sha).

const {
  synthesizePrOpenPush,
  expandPrOpenPushes,
  pushHeadKey,
  gcPushHeads,
  PUSH_HEADS_MAX,
} = require("./github-poller");

// The Events API's real (slimmed) PullRequestEvent shape (#2529 review B1):
// `repo.name` is `owner/name`, but `head.repo` / `base.repo` are
// `{ id, name: <SHORT name>, url }` — no `full_name`.
const REPO_ID = 1001;
const REPO_API_URL = "https://api.github.com/repos/org/repo";
const sameRepo = { id: REPO_ID, name: "repo", url: REPO_API_URL };

function prOpenedEvent(id, { action = "opened", number = 42, ref = "feat/x", sha = "abc1234def", headRepo = sameRepo, createdAt } = {}) {
  return {
    id,
    actor: { login: "dev" },
    created_at: createdAt || new Date().toISOString(),
    type: "PullRequestEvent",
    repo: { id: REPO_ID, name: "org/repo", url: REPO_API_URL },
    payload: {
      action,
      number,
      pull_request: {
        number,
        url: `https://api.github.com/repos/org/repo/pulls/${number}`,
        head: { ref, sha, repo: headRepo || undefined },
        base: { ref: "main", sha: "base000", repo: sameRepo },
      },
    },
  };
}

// Captured verbatim from the live Events API (this PR's own
// `pull_request.opened`, #2530) — pins the production shape end to end.
const REAL_PR_OPENED = {
  id: "15937106102",
  type: "PullRequestEvent",
  actor: { id: 1, login: "thorsten-a-maier_accent" },
  repo: {
    id: 1225674781,
    name: "AccentureCodeFoundry/314092_agent-execution-environment",
    url: "https://api.github.com/repos/AccentureCodeFoundry/314092_agent-execution-environment",
  },
  payload: {
    action: "opened",
    number: 2530,
    pull_request: {
      id: 4666725854,
      number: 2530,
      url: "https://api.github.com/repos/AccentureCodeFoundry/314092_agent-execution-environment/pulls/2530",
      head: {
        ref: "feat/2529-pr-open-push-wake",
        sha: "4f1f84aee1c61a2e8f22ac49a155a4bc5be42294",
        repo: {
          id: 1225674781,
          name: "314092_agent-execution-environment",
          url: "https://api.github.com/repos/AccentureCodeFoundry/314092_agent-execution-environment",
        },
      },
      base: {
        ref: "main",
        sha: "2fc34a8dfe19208ffd420ab0843cbdd3ced2f517",
        repo: {
          id: 1225674781,
          name: "314092_agent-execution-environment",
          url: "https://api.github.com/repos/AccentureCodeFoundry/314092_agent-execution-environment",
        },
      },
    },
  },
  public: false,
  created_at: "2026-09-28T16:51:59Z",
};

function pushEvent(id, { ref = "refs/heads/feat/x", head = "abc1234def", createdAt } = {}) {
  return {
    id,
    actor: { login: "dev" },
    created_at: createdAt || new Date().toISOString(),
    type: "PushEvent",
    repo: { name: "org/repo" },
    payload: { ref, head, before: "0000000" },
  };
}

const pushSub = (over = {}) => ({
  agentId: "builder", triggerId: "t-push",
  events: new Set(["push"]), labelFilter: null, horizon: null,
  ...over,
});

async function runBatch(poller, batches, subscribers) {
  const recorded = [];
  const enqueued = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });
  poller._enrichPullRequestPayload = async (_k, payload) => payload;
  poller._checkAndIncThrottle = () => ({ drop: false });
  poller._saveThrottleState = () => {};
  try {
    for (const batch of batches) await poller._fanOutBatch("org/repo", batch, subscribers, "tok");
  } finally {
    githubEventLog.record = origRecord;
  }
  return { recorded, enqueued };
}

test("synthesizePrOpenPush: opened/reopened map to a push carrying head ref/sha and the PR", () => {
  for (const action of ["opened", "reopened"]) {
    const s = synthesizePrOpenPush(prOpenedEvent("pr-1", { action }));
    assert.equal(s.id, "prpush:pr-1");
    assert.equal(s.type, "PushEvent");
    assert.equal(s.payload.ref, "refs/heads/feat/x");
    assert.equal(s.payload.head, "abc1234def");
    assert.equal(s.payload.synthesizedFrom, `pull_request.${action}`);
    assert.equal(s.payload.pull_request.number, 42);
    assert.equal(s.payload.pull_request.html_url, "https://github.com/org/repo/pull/42");
  }
});

test("synthesizePrOpenPush: other PR actions, non-PR events, fork heads and missing heads yield null", () => {
  assert.equal(synthesizePrOpenPush(prOpenedEvent("a", { action: "closed" })), null);
  assert.equal(synthesizePrOpenPush(prOpenedEvent("b", { action: "labeled" })), null);
  assert.equal(synthesizePrOpenPush(pushEvent("c")), null);
  assert.equal(synthesizePrOpenPush(prOpenedEvent("d", {
    headRepo: { id: 2002, name: "fork", url: "https://api.github.com/repos/someone/fork" } })), null);
  assert.equal(synthesizePrOpenPush(prOpenedEvent("e", { sha: "" })), null);
  assert.equal(synthesizePrOpenPush(null), null);
  // A reduced head without repo info is treated as same-repo.
  assert.ok(synthesizePrOpenPush(prOpenedEvent("f", { headRepo: null })));
});

test("synthesizePrOpenPush (review B1): a same-repo head whose SHORT name differs from repo.name still synthesizes", () => {
  const ev = prOpenedEvent("g");
  assert.notEqual(ev.payload.pull_request.head.repo.name, ev.repo.name); // "repo" vs "org/repo"
  assert.ok(synthesizePrOpenPush(ev));
  // …and the captured live event does too.
  const s = synthesizePrOpenPush(REAL_PR_OPENED);
  assert.ok(s, "the real Events API payload must synthesize a push");
  assert.equal(s.payload.ref, "refs/heads/feat/2529-pr-open-push-wake");
  assert.equal(s.payload.head, "4f1f84aee1c61a2e8f22ac49a155a4bc5be42294");
});

test("synthesizePrOpenPush (review B1): a fork with the SAME short name but another id yields null", () => {
  const fork = { id: 2002, name: "repo", url: "https://api.github.com/repos/someone/repo" };
  assert.equal(synthesizePrOpenPush(prOpenedEvent("h", { headRepo: fork })), null);
  // Id beats url: same id is same repo even if the url differs (renamed repo).
  assert.ok(synthesizePrOpenPush(prOpenedEvent("i", { headRepo: { ...sameRepo, url: "https://api.github.com/repos/org/renamed" } })));
  // Url fallback when ids are missing on either side.
  assert.ok(synthesizePrOpenPush(prOpenedEvent("j", { headRepo: { name: "repo", url: REPO_API_URL } })));
  assert.equal(synthesizePrOpenPush(prOpenedEvent("k", { headRepo: { name: "repo", url: fork.url } })), null);
});

test("expandPrOpenPushes: inserts the synthetic push right after its PR event", () => {
  const out = expandPrOpenPushes([pushEvent("p0", { head: "zzz" }), prOpenedEvent("pr-1"), pushEvent("p2", { head: "yyy" })]);
  assert.deepEqual(out.map((e) => e.id), ["p0", "pr-1", "prpush:pr-1", "p2"]);
});

test("pushHeadKey / gcPushHeads: keyed on ref+sha; TTL and cap bound the memory", () => {
  assert.equal(pushHeadKey(pushEvent("p")), "refs/heads/feat/x@abc1234def");
  assert.equal(pushHeadKey({ payload: { ref: "refs/heads/x" } }), null);
  const now = Date.now();
  const heads = { old: now - 8 * 24 * 60 * 60 * 1000, fresh: now, junk: "x" };
  gcPushHeads(heads, now);
  assert.deepEqual(Object.keys(heads), ["fresh"]);
  const many = {};
  for (let i = 0; i < PUSH_HEADS_MAX + 5; i++) many[`k${i}`] = now - (PUSH_HEADS_MAX + 5 - i);
  gcPushHeads(many, now);
  assert.equal(Object.keys(many).length, PUSH_HEADS_MAX);
  assert.ok(!("k0" in many) && `k${PUSH_HEADS_MAX + 4}` in many, "the oldest are evicted first");
});

test("_fanOutBatch (#2529 AC1): a PR-opening push fires a ['push'] trigger once, logged as a delivered push row", async () => {
  const poller = new GitHubPoller();
  const { recorded, enqueued } = await runBatch(poller, [[prOpenedEvent("pr-1")]], [pushSub()]);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].entry.github.event, "push");
  assert.equal(enqueued[0].entry.github.eventId, "prpush:pr-1");
  assert.equal(enqueued[0].entry.github.payload.ref, "refs/heads/feat/x");
  assert.equal(enqueued[0].entry.github.payload.head, "abc1234def");

  const pushRow = recorded.find((r) => r.event === "push");
  assert.equal(pushRow.ref, "refs/heads/feat/x");
  assert.equal(pushRow.outcomes.length, 1);
  assert.equal(pushRow.outcomes[0].status, "delivered");
  // The original PR row is still logged (nobody listening to it here).
  const prRow = recorded.find((r) => r.event === "pull_request.opened");
  assert.equal(prRow.noMatchingTrigger, true);
});

test("_fanOutBatch (#2529 AC1, review B1): the captured live pull_request.opened fires a ['push'] trigger", async () => {
  const poller = new GitHubPoller();
  const { recorded, enqueued } = await runBatch(poller, [[REAL_PR_OPENED]], [pushSub()]);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].entry.github.event, "push");
  assert.equal(enqueued[0].entry.github.eventId, "prpush:15937106102");
  assert.equal(enqueued[0].entry.github.payload.ref, "refs/heads/feat/2529-pr-open-push-wake");
  const pushRow = recorded.find((r) => r.event === "push");
  assert.equal(pushRow.outcomes[0].status, "delivered");
});

test("_fanOutBatch (#2529 AC2): a later real PushEvent for the same head is dropped as a duplicate — across batches", async () => {
  const poller = new GitHubPoller();
  const { recorded, enqueued } = await runBatch(poller, [[prOpenedEvent("pr-1")], [pushEvent("real-1")]], [pushSub()]);
  assert.equal(enqueued.length, 1, "only the PR-opening push wakes the trigger");
  const realRow = recorded.find((r) => r.eventId === "real-1");
  assert.equal(realRow.outcomes[0].status, "dropped");
  assert.equal(realRow.outcomes[0].reason, "push-duplicate");
});

test("_fanOutBatch (#2529 AC2): a PR opened on a head a real push already delivered does not re-fire", async () => {
  const poller = new GitHubPoller();
  const { enqueued, recorded } = await runBatch(poller, [[pushEvent("real-1"), prOpenedEvent("pr-1")]], [pushSub()]);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].entry.github.eventId, "real-1");
  assert.equal(recorded.find((r) => r.eventId === "prpush:pr-1").outcomes[0].reason, "push-duplicate");
});

test("_fanOutBatch (#2529 AC3): subsequent pushes with new heads to the existing branch keep firing", async () => {
  const poller = new GitHubPoller();
  const { enqueued } = await runBatch(poller, [
    [prOpenedEvent("pr-1")],
    [pushEvent("real-2", { head: "second" })],
    [pushEvent("real-3", { head: "third" })],
  ], [pushSub()]);
  assert.deepEqual(enqueued.map((e) => e.entry.github.eventId), ["prpush:pr-1", "real-2", "real-3"]);
});

test("_fanOutBatch (#2529 AC4): a pull_request.opened trigger fires once on the PR event, never on the synthetic push", async () => {
  const poller = new GitHubPoller();
  const prSub = { agentId: "reviewer", triggerId: "t-pr", events: new Set(["pull_request.opened"]), labelFilter: null, horizon: null };
  // A single trigger listening to both keys is already woken by the PR event.
  const bothSub = { agentId: "both", triggerId: "t-both", events: new Set(["push", "pull_request.opened"]), labelFilter: null, horizon: null };
  const { enqueued, recorded } = await runBatch(poller, [[prOpenedEvent("pr-1")]], [prSub, pushSub(), bothSub]);

  const wakes = enqueued.map((e) => `${e.agentId}:${e.entry.github.event}`).sort();
  assert.deepEqual(wakes, ["both:pull_request.opened", "builder:push", "reviewer:pull_request.opened"]);
  assert.deepEqual(recorded.find((r) => r.event === "push").outcomes.map((o) => o.agentId), ["builder"]);
});

test("_fanOutBatch (#2529 AC5): the synthetic push still honours the history horizon", async () => {
  const poller = new GitHubPoller();
  const sub = pushSub({ horizon: new Date().toISOString() });
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { enqueued, recorded } = await runBatch(poller, [[prOpenedEvent("pr-old", { createdAt: old })]], [sub]);
  assert.equal(enqueued.length, 0, "a pre-existing PR must not wake a brand-new push trigger");
  assert.equal(recorded.find((r) => r.event === "push").outcomes[0].reason, "history-horizon");
});

test("_fanOutBatch (#2529 AC5): the synthetic push goes through the throttle and burst digest", async () => {
  const throttled = new GitHubPoller();
  const r1 = await runBatch(throttled, [[]], [pushSub()]);
  assert.equal(r1.enqueued.length, 0);
  throttled._checkAndIncThrottle = () => ({ drop: true, count: 6, threshold: 5, windowEndsAt: "x" });
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    await throttled._fanOutBatch("org/repo", [prOpenedEvent("pr-t")], [pushSub()], "tok");
  } finally {
    githubEventLog.record = origRecord;
  }
  assert.equal(recorded.find((r) => r.event === "push").outcomes[0].reason, "throttle");

  const burst = new GitHubPoller();
  const prs = [];
  for (let i = 0; i < BURST_CAP + 1; i++) {
    prs.push(prOpenedEvent(`pr-b${i}`, { number: 7, ref: "feat/burst", sha: `sha${i}`, action: i % 2 ? "reopened" : "opened" }));
  }
  const { enqueued } = await runBatch(burst, [prs], [pushSub()]);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].entry.kind, "github-digest");
});

// ── #2525: the manual "Fire again" re-arms the wake key from outside a poll, so
// the protections still hold afterwards (AC10).

test("armWake (#2525): a re-fired wake stays armed — the next duplicate label event is dropped 'wake-already-armed'", async () => {
  const origRecord = githubEventLog.record;
  const recorded = [];
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const poller = new GitHubPoller();
    poller._saveState = () => {};
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });

    const armed = poller.armWake({
      repo: "org/repo", triggerId: "t1785499525109689", kind: "issue", number: 2525, label: "ready",
    });
    assert.equal(armed, true);

    const dup = labeledIssueEvent("2525-dup", "next-wave", ["next-wave", "ready"], 2525);
    await poller._fanOutBatch("org/repo", [dup], readyDeveloperSub(), "tok");

    assert.equal(enqueued.length, 0, "the duplicate is not delivered after a re-fire");
    const outcome = recorded.flatMap((e) => e.outcomes || []).find((o) => o.agentId === "developer");
    assert.equal(outcome.status, "dropped");
    assert.equal(outcome.reason, "wake-already-armed");
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("armWake (#2525): a later genuine remove -> re-add still fires (the re-fire does not pin the arm)", async () => {
  const origRecord = githubEventLog.record;
  githubEventLog.record = () => {};
  try {
    const poller = new GitHubPoller();
    poller._saveState = () => {};
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });
    poller.armWake({ repo: "org/repo", triggerId: "t1785499525109689", kind: "issue", number: 2526, label: "ready" });

    const removed = unlabeledIssueEvent("2526-rm", "ready", ["next-wave"], 2526);
    const readded = labeledIssueEvent("2526-add", "ready", ["next-wave", "ready"], 2526);
    await poller._fanOutBatch("org/repo", [removed, readded], readyDeveloperSub(), "tok");

    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].entry.github.eventId, "2526-add");
  } finally {
    githubEventLog.record = origRecord;
  }
});

test("armWake (#2525): no-op without a wake label or with the edge dedup switched off", () => {
  const poller = new GitHubPoller();
  poller._saveState = () => { throw new Error("must not save"); };
  assert.equal(poller.armWake({ repo: "org/repo", triggerId: "t", kind: "issue", number: 1, label: null }), false);
  poller._wakeEdgeDedup = false;
  assert.equal(poller.armWake({ repo: "org/repo", triggerId: "t", kind: "issue", number: 1, label: "ready" }), false);
});
