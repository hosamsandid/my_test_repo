"use strict";

// #2536: the Events API reports a submitted PR review as
// `pull_request_review.created`; triggers subscribe to the webhook name
// `pull_request_review.submitted`. These tests pin that every matcher treats
// the two as one key — using a real Events-API payload, not a hand-written one.

const test = require("node:test");
const assert = require("node:assert/strict");

const { EVENT_KEY_ALIASES, canonicalEventKey, listensTo } = require("./event-key-aliases");
const { GitHubPoller, eventKey, pollerSubscribes, selectFreshEvents } = require("./github-poller");
const githubEventLog = require("./github-event-log");
const { matchInternalListeners } = require("./flow-emit");
const { matchPollerListeners } = require("./github-label-fastpath");
const { triggerAccepts } = require("./pending-reassign");

const { reviewCreated } = require("./github-poller-review-event.fixture.json");
const REPO = reviewCreated.repo.name;

// ── the pure helper ─────────────────────────────────────────────────────────

test("canonicalEventKey: the Events-API review key maps to the editor's key; everything else is unchanged", () => {
  assert.equal(canonicalEventKey("pull_request_review.created"), "pull_request_review.submitted");
  assert.equal(canonicalEventKey("pull_request_review.submitted"), "pull_request_review.submitted");
  for (const k of ["push", "pull_request.merged", "pull_request_review_comment.created", "issue_comment.created", "issues.labeled"]) {
    assert.equal(canonicalEventKey(k), k);
  }
  assert.equal(canonicalEventKey(null), null);
  // Inherited Object keys are not aliases.
  assert.equal(canonicalEventKey("toString"), "toString");
});

test("listensTo: either form matches either form, for arrays and Sets", () => {
  for (const stored of ["pull_request_review.submitted", "pull_request_review.created"]) {
    for (const incoming of ["pull_request_review.submitted", "pull_request_review.created"]) {
      assert.equal(listensTo([stored], incoming), true, `${stored} ⇐ ${incoming}`);
      assert.equal(listensTo(new Set([stored]), incoming), true);
    }
  }
  assert.equal(listensTo(["issues.labeled"], "pull_request_review.submitted"), false);
  assert.equal(listensTo(["pull_request_review.submitted"], "pull_request_review_comment.created"), false);
  assert.equal(listensTo(null, "push"), false);
  assert.equal(listensTo("push", "push"), false, "a bare string is not an event list");
  assert.equal(listensTo(["push"], null), false);
});

test("every alias target is a key the trigger editor offers", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "admin-console", "src", "pages", "agent-chat", "trigger-summary.js"), "utf8");
  const block = src.slice(src.indexOf("GITHUB_EVENT_OPTIONS = ["), src.indexOf("];", src.indexOf("GITHUB_EVENT_OPTIONS = [")));
  const offered = new Set([...block.matchAll(/value:\s*'([^']+)'/g)].map(m => m[1]));
  assert.ok(offered.size > 0);
  for (const target of Object.values(EVENT_KEY_ALIASES)) assert.ok(offered.has(target), target);
  for (const alias of Object.keys(EVENT_KEY_ALIASES)) assert.ok(!offered.has(alias), alias);
});

// ── poller (AC1–AC3) ────────────────────────────────────────────────────────

test("eventKey: a real Events-API PullRequestReviewEvent (action 'created') is keyed pull_request_review.submitted", () => {
  assert.equal(reviewCreated.type, "PullRequestReviewEvent");
  assert.equal(reviewCreated.payload.action, "created");
  assert.equal(eventKey(reviewCreated), "pull_request_review.submitted");
});

// Runs one real review event through `_fanOutBatch` and returns what was queued
// and logged. PR enrichment is stubbed (it would call GitHub for the title).
async function fanOut(subscribers, events = [reviewCreated]) {
  const recorded = [];
  const origRecord = githubEventLog.record;
  githubEventLog.record = (entry) => recorded.push(entry);
  try {
    const poller = new GitHubPoller();
    poller._wakeEdgeDedup = false;
    poller._enrichPullRequestPayload = async (_key, payload) => payload;
    poller._saveThrottleState = () => {};
    poller.throttleBuckets = {};
    const enqueued = [];
    poller._enqueuePending = (agentId, entry) => enqueued.push({ agentId, entry });
    await poller._fanOutBatch(REPO, events, subscribers, "tok", {});
    return { enqueued, recorded };
  } finally {
    githubEventLog.record = origRecord;
  }
}

const sub = (events, extra = {}) => ({
  agentId: "reworker", triggerId: "rework-on-review", events: new Set(events), labelFilter: null, horizon: null, ...extra,
});

test("_fanOutBatch: the real review wakes a trigger stored with pull_request_review.submitted (AC1, AC3)", async () => {
  const { enqueued, recorded } = await fanOut([sub(["pull_request_review.submitted"])]);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].entry.triggerId, "rework-on-review");
  assert.equal(enqueued[0].entry.github.event, "pull_request_review.submitted");
  assert.equal(enqueued[0].entry.github.eventId, reviewCreated.id);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].outcomes.map(o => o.status), ["delivered"]);
});

test("_fanOutBatch: a trigger hand-stored with the Events-API form still fires", async () => {
  const { enqueued } = await fanOut([sub(["pull_request_review.created"])]);
  assert.equal(enqueued.length, 1);
});

test("_fanOutBatch: a trigger listing both forms is woken once, with one outcome (AC2)", async () => {
  const { enqueued, recorded } = await fanOut([sub(["pull_request_review.submitted", "pull_request_review.created"])]);
  assert.equal(enqueued.length, 1);
  assert.equal(recorded[0].outcomes.length, 1);
});

test("_fanOutBatch: review states commented / approved / changes_requested all wake the trigger", async () => {
  for (const state of ["commented", "approved", "changes_requested"]) {
    const ev = { ...reviewCreated, id: `${reviewCreated.id}-${state}`,
      payload: { ...reviewCreated.payload, review: { ...reviewCreated.payload.review, state } } };
    const { enqueued } = await fanOut([sub(["pull_request_review.submitted"], { triggerId: state })], [ev]);
    assert.equal(enqueued.length, 1, state);
  }
});

test("_fanOutBatch: an unrelated trigger on the same PR is not woken by the review", async () => {
  const { enqueued, recorded } = await fanOut([sub(["pull_request.labeled", "pull_request_review_comment.created"])]);
  assert.equal(enqueued.length, 0);
  assert.equal(recorded[0].outcomes.length, 0);
});

test("selectFreshEvents: the same review listed twice in one fetch is fresh once (AC2)", () => {
  const { fresh } = selectFreshEvents([reviewCreated, { ...reviewCreated }], [], 100);
  assert.equal(fresh.length, 1);
  assert.equal(selectFreshEvents([reviewCreated], [String(reviewCreated.id)], 100).fresh.length, 0);
});

// ── shipped templates (AC5) ─────────────────────────────────────────────────

function reviewTriggers(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "github-event" && Array.isArray(node.events)
    && node.events.some(e => e.startsWith("pull_request_review."))) out.push(node);
  for (const v of Object.values(node)) reviewTriggers(v, out);
  return out;
}

for (const file of ["skill-pool/process-templates/extended-sdlc.json", "skill-pool/agent-templates/legal-approver.json"]) {
  test(`shipped template ${file}: every review trigger is woken by the real review event (AC5)`, async () => {
    const triggers = reviewTriggers(require(`./${file}`));
    assert.ok(triggers.length > 0, "template still ships a review trigger");
    for (const t of triggers) {
      // Materialisation binds the trigger to the team repo; the plan builder
      // then turns it into a subscriber exactly like this.
      const live = { ...t, repo: REPO };
      assert.equal(pollerSubscribes(live), true, t.id);
      const { enqueued } = await fanOut([{
        agentId: "template-role", triggerId: t.id, events: new Set(live.events),
        labelFilter: (typeof live.labelFilter === "string" && live.labelFilter.trim()) || null, horizon: null,
      }]);
      assert.equal(enqueued.length, 1, `${t.id} is woken by a submitted review`);
    }
  });
}

// ── the other matchers (AC4) ────────────────────────────────────────────────

test("pending-reassign: a queued review entry with either key form is accepted by a submitted-review trigger", () => {
  const trigger = { id: "t", type: "github-event", repo: REPO, events: ["pull_request_review.submitted"] };
  for (const eventKey of ["pull_request_review.submitted", "pull_request_review.created"]) {
    const v = triggerAccepts(trigger, { eventKey, ghEvent: reviewCreated, repo: REPO, triggersMtime: null });
    assert.equal(v.ok, true, eventKey);
  }
  const legacy = { ...trigger, events: ["pull_request_review.created"] };
  assert.equal(triggerAccepts(legacy, { eventKey: eventKey(reviewCreated), ghEvent: reviewCreated, repo: REPO }).ok, true);
  const other = { ...trigger, events: ["issues.labeled"] };
  assert.equal(triggerAccepts(other, { eventKey: "pull_request_review.submitted", ghEvent: reviewCreated, repo: REPO }).reason,
    "event-not-subscribed");
});

// Flow emit and the label fast-path only ever deliver `*.labeled` keys, so a
// review key cannot reach them; what they must share with the poller is the
// matcher — pinned below by triggers that mix label and review keys (matched
// once) and the drift guard that every matcher goes through `listensTo`.
test("flow-emit matchInternalListeners: matches through the shared helper, once per trigger", () => {
  const agents = [{ agentId: "a", triggers: [
    { id: "t1", type: "github-event", transport: "internal", repo: REPO, events: ["pull_request.labeled", "pull_request_review.created"] },
    { id: "t2", type: "github-event", transport: "internal", repo: REPO, events: ["pull_request_review.submitted"] },
  ] }];
  assert.deepEqual(matchInternalListeners({ repo: REPO, label: "x", kind: "pr" }, agents), [{ agentId: "a", triggerId: "t1" }]);
});

test("label fast-path matchPollerListeners: matches through the shared helper, once per trigger", () => {
  const agents = [{ agentId: "a", triggers: [
    { id: "t1", type: "github-event", repo: REPO, events: ["issues.labeled", "pull_request_review.submitted"] },
    { id: "t2", type: "github-event", repo: REPO, events: ["pull_request_review.created"] },
  ] }];
  assert.deepEqual(matchPollerListeners({ repo: REPO, label: "x", kind: "issue" }, agents), [{ agentId: "a", triggerId: "t1" }]);
});

test("flow-emit / label fast-path / pending-reassign / poller all match through listensTo (drift guard)", () => {
  const fs = require("fs");
  const path = require("path");
  for (const f of ["flow-emit.js", "github-label-fastpath.js", "pending-reassign.js", "github-poller.js"]) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    assert.match(src, /listensTo\(/, f);
    assert.doesNotMatch(src, /\.events\.(includes|has)\(/, `${f} must not compare event keys verbatim`);
  }
});
