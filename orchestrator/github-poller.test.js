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
