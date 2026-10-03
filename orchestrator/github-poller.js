'use strict';

// ============================================================
// GitHub event poller
// ------------------------------------------------------------
// Polls the GitHub Events API for every repo referenced by any working
// environment that has a `githubTokenId` attached. On each tick:
//
//   1. Builds a poll plan: dedup repos across environments, pick a token,
//      collect agent subscribers (triggers.json entries with
//      type=github-event, matching repo).
//   2. For each repo in the plan, issues a conditional GET with
//      If-None-Match (so 304 responses don't decrement the rate limit).
//   3. Selects fresh events by id membership against a per-repo sliding
//      seen-id set (#320 — not a created_at high-water-mark, since GitHub
//      neither orders events nor delivers them promptly), then gates each
//      subscriber by its history horizon (activatedAt/createdAt/mtime, with
//      a grace window) before fanning them out by writing to each
//      subscriber's pending-triggers.json — same queue HTTP triggers use,
//      so the agent-runner picks them up via its existing 5s drain.
//
// State (`state.json`) holds per-repo `etag`, `seen` (event-id set, capped
// at SEEN_MAX), `lastPolledAt` (last successful poll), and — for the
// repository status view (#2537) — `lastEventAt`, `lastError`/`lastErrorAt`,
// `failingSince`, and the `tokenId`/`tokenEnvId` the repo is polled with.
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const githubEventLog = require('./github-event-log');
const { parseCloses } = require('./pr-events-log');
const { resolveGithubApiTarget, githubApiBase, DEFAULT_GITHUB_API_BASE } = require('./github-api-base');
const wakeArmory = require('./wake-armory');
const { canonicalEventKey, listensTo } = require('./event-key-aliases');
const pushAttribution = require('./push-attribution');
const { parseBranchFilter, pushBranch, branchFilterMatches } = require('./branch-filter');
const { knowledgeBranchesByRepo, isKnowledgeBranchPush } = require('./knowledge-branch-exclusion');
const prReadiness = require('./pr-readiness');
const handoffGate = require('./handoff-gate');

// Poll cadence. Fixed 30s in production; overridable via
// AEE_GITHUB_POLL_INTERVAL_MS (#711) so the E2E stack can tighten it — the
// label-chain journey (issue.labeled→Developer→PR.labeled→Reviewer) crosses two
// poll boundaries and must complete inside the Playwright per-test budget. A
// non-numeric / non-positive value falls back to the production default.
const POLL_INTERVAL_MS = (() => {
  const raw = Number(process.env.AEE_GITHUB_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();
const STATE_DIR = '/workspace/github-poller';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const THROTTLE_STATE_FILE = path.join(STATE_DIR, 'throttle-state.json');
const AGENTS_DIR = '/workspace/agents';
const ENVIRONMENTS_DIR = '/workspace/environments';
const GH_TOKENS_DIR = path.join(ENVIRONMENTS_DIR, '_tokens');

// Layer-3 loop protection: per (agent, conversation-key) sliding window.
// If an agent has reacted more than THROTTLE_THRESHOLD times to the same
// PR/issue within THROTTLE_WINDOW_MS, further events are dropped until the
// window resets, and a one-shot warning is posted to the agent's DM.
//
// Defaults err on the side of "loud rather than silent": 5 reactions / hour
// per conversation is generous for normal review cycles but cheap to trip
// on a real loop.
const THROTTLE_WINDOW_MS = 60 * 60_000;
const THROTTLE_THRESHOLD = 5;

// Backoff bounds for repos that consistently fail (e.g. expired token,
// repo deleted, network outage). Capped at 30m so a once-flaky token
// recovers within at most one work-break.
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

// #320-B: safety look-back applied to the per-subscriber history horizon. The
// GitHub Events API delivers events out of order and up to hours late, so an
// event that legitimately belongs to a subscriber can carry a `created_at`
// slightly older than the subscriber's activation stamp. Widening the horizon
// by GRACE_MS catches those border cases without letting a real backlog in.
const GRACE_MS = 5 * 60_000;

// #320-F: upper bound on the sliding set of processed event ids kept per repo.
// One page of the Events API is <=100 events; retaining several polls' worth
// means a delayed/re-observed event is still recognised as already-seen. Tiny
// on disk; oldest ids beyond this bound are pruned.
const SEEN_MAX = 500;

// #449-C: burst cap for the fan-out. When MORE than BURST_CAP fresh events for
// the same (agent, conversationKey) arrive in a SINGLE poll, they collapse into
// one lossless `github-digest` queue entry instead of BURST_CAP+ individual
// agent wake-ups. This is the poll-scoped sibling of the Layer-3 throttle
// (THROTTLE_*, hour-scoped): the throttle silently *drops* beyond its threshold,
// the digest *bundles* without losing any event.
const BURST_CAP = 3;

// #449: Events-API pagination. The API returns newest-first, one page at a time.
// A burst of more than PER_PAGE events between two polls pushes the older-but-
// still-unseen events onto later pages; reading only page 1 would silently lose
// them. We page backwards until we reach already-seen territory. MAX_PAGES caps
// the work (GitHub serves at most ~3 pages / 300 events on this endpoint anyway).
const PER_PAGE = 100;
const MAX_PAGES = 10;

// Poller-wedge fix: hard wall-clock deadline per HTTP request, and the no-progress window
// after which a stranded tick guard is forced open. Both exist because the
// `timeout` option on http.request is NOT a request deadline — it is a
// socket-inactivity timer that is only armed once a socket has been assigned.
// A DNS lookup that never returns therefore never trips it, and a response that
// dies mid-body emits on `res` (which we now listen to) rather than firing
// `end`. Either way the fetch promise used to stay pending forever, which
// stranded `_tick`'s re-entrancy guard at `true` and killed the poller silently
// until the next orchestrator restart — it did not recover when the network did.
//
// The deadline sits above the 15s socket timeout so the socket timer normally
// wins and produces the more specific 'timeout' message; the deadline is only
// the backstop for the phases that timer cannot see.
// Overridable via AEE_GITHUB_REQUEST_DEADLINE_MS, same shape as
// POLL_INTERVAL_MS above: the regression tests need a deadline they can hit in
// milliseconds, and an operator on a genuinely slow link may want more headroom.
const REQUEST_DEADLINE_MS = (() => {
  const raw = Number(process.env.AEE_GITHUB_REQUEST_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

// Deliberately measured against *progress*, not against tick start: a legitimate
// tick is slow-but-alive (repos × (1 + MAX_PAGES) requests, sequentially — tens
// of minutes in the worst case), so any fixed cap on total duration would
// force the guard open mid-poll and cause the exact overlap the guard prevents.
// With every request now deadline-bounded, a gap this long with nothing settling
// is unambiguous evidence of a stuck await rather than of slowness.
const TICK_STALL_MS = 5 * 60_000;

// #496: the GitHub Events API's PullRequestEvent/PullRequestReviewEvent
// payload carries a *reduced* `pull_request` object — `id`/`number`/`url`/
// `base`/`head`, but (unlike the full webhook payload the docs describe and
// the #470/#475 synthetic tests assumed) no `title` and no `html_url`. This
// derives the web URL from the always-present API `url` field without a
// network round-trip. Returns null for anything that doesn't match the
// expected shape (defensive — caller falls back to no enrichment).
function prApiUrlToHtmlUrl(apiUrl) {
  if (typeof apiUrl !== 'string') return null;
  const m = apiUrl.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
}

// tokenId is operator-supplied via the Working Environment config, but a
// rogue or typo'd value like "../../etc/passwd" would otherwise resolve
// outside GH_TOKENS_DIR via path.join. Restrict to the same character set
// used elsewhere for ids in this codebase.
function isValidTokenId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length < 64
    && /^[a-zA-Z0-9_.-]+$/.test(id);
}

// Map GitHub event API type+action to a stable trigger key.
// e.g. PullRequestEvent + action=opened → "pull_request.opened"
//      PushEvent (no action)            → "push"
const TYPE_KEY = {
  PushEvent: 'push',
  PullRequestEvent: 'pull_request',
  PullRequestReviewEvent: 'pull_request_review',
  PullRequestReviewCommentEvent: 'pull_request_review_comment',
  IssueCommentEvent: 'issue_comment',
  IssuesEvent: 'issues',
  CreateEvent: 'create',
  DeleteEvent: 'delete',
  ReleaseEvent: 'release',
  ForkEvent: 'fork',
  WatchEvent: 'watch',
  CommitCommentEvent: 'commit_comment',
};

// The key is canonicalised (#2536): an Events-API action whose webhook name
// differs (PullRequestReviewEvent `created` → `submitted`) reports the name the
// trigger editor offers. See event-key-aliases.js.
function eventKey(ev) {
  const base = TYPE_KEY[ev.type] || (ev.type || '').replace(/Event$/, '').toLowerCase();
  if (!base) return null;
  const action = ev.payload?.action;
  return canonicalEventKey(action ? `${base}.${action}` : base);
}

// Conversation key for the Layer-3 throttle: groups events that belong to
// the same logical thread (one PR, one issue, one branch, …). The throttle
// counts events per (agent, conversationKey), not raw events — so legitimate
// activity across many PRs doesn't trip the limit, but a back-and-forth on
// a single PR does.
// The PR/issue number an event happened on, or null (#1858 — used by the
// internal-fast-path dedup to key a marker to its work item). Mirrors the
// synthetic-event shape the fast-path builds (payload.issue.number /
// payload.pull_request.number).
function workItemNumber(ghEvent) {
  const p = ghEvent?.payload || {};
  const n = p.issue?.number ?? p.pull_request?.number;
  return Number.isInteger(n) ? n : null;
}

function conversationKey(ghEvent) {
  const p = ghEvent?.payload || {};
  if (p.pull_request?.number != null) return `pr:${p.pull_request.number}`;
  // issue_comment on a PR carries `payload.issue` with `pull_request` set —
  // treat it as PR scope so it shares a bucket with the PR's own events.
  if (p.issue?.pull_request) return `pr:${p.issue.number}`;
  if (p.issue?.number != null) return `issue:${p.issue.number}`;
  if (ghEvent?.type === 'PushEvent' && p.ref) return `push:${p.ref}`;
  if (p.check_run?.name) return `check:${p.check_run.name}`;
  if (p.release?.id != null) return `release:${p.release.id}`;
  // Fallback — coarse but bounded; events without a natural thread (fork,
  // watch, …) don't realistically loop, so the imprecision is acceptable.
  return ghEvent?.type || 'misc';
}

// #2529: the Events API emits NO `PushEvent` (and often no `CreateEvent`) for
// the push that creates a branch — only later pushes to the now-existing branch
// surface as `push`. The PR opened from that branch DOES arrive, carrying the
// head ref/sha, so it is the only reliable carrier for "the first push landed".
// Synthesise a push-class event from it so `['push']` subscribers wake for the
// PR-opening push like for any later one. Same-repo heads only: a fork PR's
// head was pushed to the fork, not to this repo. Returns null when the event is
// not a PR open/reopen or lacks a usable head ref/sha.
const PR_PUSH_ACTIONS = new Set(['opened', 'reopened']);

// Is the PR's head in this repo (not a fork)? Decided by repo **id**, never by
// name: the Events API's slimmed payload gives `head.repo.name` as the SHORT
// name (`repo`) while `ghEvent.repo.name` is `owner/repo`, and a fork usually
// keeps the same short name. Compared against `base.repo.id` (else the event's
// own `repo.id`), falling back to the API `url` when an id is missing. A head
// with no repo identity at all (reduced payload) is treated as same-repo; one
// whose identity cannot be compared with anything is not.
function prHeadIsSameRepo(ghEvent, pr) {
  const head = pr?.head?.repo;
  if (!head || (head.id == null && !head.url)) return true;
  const baseId = pr?.base?.repo?.id ?? ghEvent?.repo?.id;
  if (head.id != null && baseId != null) return head.id === baseId;
  const baseUrl = pr?.base?.repo?.url || ghEvent?.repo?.url;
  if (head.url && baseUrl) return head.url === baseUrl;
  return false;
}

function synthesizePrOpenPush(ghEvent) {
  if (!ghEvent || ghEvent.type !== 'PullRequestEvent') return null;
  const p = ghEvent.payload || {};
  if (!PR_PUSH_ACTIONS.has(p.action)) return null;
  const pr = p.pull_request || {};
  const head = pr.head || {};
  if (typeof head.ref !== 'string' || !head.ref || typeof head.sha !== 'string' || !head.sha) return null;
  if (!prHeadIsSameRepo(ghEvent, pr)) return null;
  return {
    id: `prpush:${ghEvent.id}`,
    type: 'PushEvent',
    actor: ghEvent.actor,
    repo: ghEvent.repo,
    created_at: ghEvent.created_at,
    payload: {
      ref: `refs/heads/${head.ref}`,
      head: head.sha,
      synthesizedFrom: `pull_request.${p.action}`,
      pull_request: {
        number: pr.number,
        url: pr.url,
        ...(pr.html_url || prApiUrlToHtmlUrl(pr.url) ? { html_url: pr.html_url || prApiUrlToHtmlUrl(pr.url) } : {}),
      },
    },
  };
}

// Oldest-first batch → the same batch with a synthetic push placed right after
// each PR open/reopen it was derived from (causal order preserved).
function expandPrOpenPushes(ghEvents) {
  const out = [];
  for (const ev of Array.isArray(ghEvents) ? ghEvents : []) {
    out.push(ev);
    const synth = synthesizePrOpenPush(ev);
    if (synth) out.push(synth);
  }
  return out;
}

// De-dup key for a push-class delivery (#2529 AC2): the same head landing on the
// same branch — once via the synthetic PR-open push, once via a real (possibly
// late) `PushEvent` — must wake a subscriber only once.
function pushHeadKey(ghEvent) {
  const p = ghEvent?.payload || {};
  if (typeof p.ref !== 'string' || !p.ref || typeof p.head !== 'string' || !p.head) return null;
  return `${p.ref}@${p.head}`;
}

// Bounded per-repo memory of push heads already seen (TTL + cap), persisted in
// state.json alongside `seen`/`armed`. Mutates in place.
const PUSH_HEADS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUSH_HEADS_MAX = 500;

function gcPushHeads(heads, now = Date.now()) {
  for (const [k, ts] of Object.entries(heads)) {
    if (!Number.isFinite(ts) || now - ts > PUSH_HEADS_TTL_MS) delete heads[k];
  }
  const keys = Object.keys(heads);
  if (keys.length > PUSH_HEADS_MAX) {
    keys.sort((a, b) => heads[a] - heads[b]);
    for (const k of keys.slice(0, keys.length - PUSH_HEADS_MAX)) delete heads[k];
  }
}

// #2776: the completion mirror the runner swaps a claimed `<wake>:wip` to on
// normal run completion (#1163). A DOCUMENTED MIRROR of `CLAIM_COMPLETED_SUFFIX`
// in agent-image/scripts/agent-entrypoint.py (and `COMPLETED_SUFFIX` in
// flow-anomaly-detector.js) — keep in sync.
const CLAIM_COMPLETED_SUFFIX = ':completed';

// Whether `labelName` is one of the status labels the platform's own claim
// lifecycle puts on the object for this subscriber: the claim label
// (`sub.claimAdd`, `<wake>:wip`) or its completion mirror (`<wake>:completed`).
// Only for a trigger that declares a claim — without one the runner never
// swaps anything, so a `<wake>:completed` add is not ours to interpret.
function isSelfClaimLabel(sub, labelName) {
  if (!sub || !sub.claimAdd || typeof labelName !== 'string' || !labelName) return false;
  if (labelName === sub.claimAdd) return true;
  return !!sub.labelFilter && labelName === `${sub.labelFilter}${CLAIM_COMPLETED_SUFFIX}`;
}

// Does a `*.labeled`/`*.unlabeled` event satisfy a subscriber's `labelFilter`?
//
// The naive check — `payload.label.name === wanted` — is INSUFFICIENT on the
// Events API. Unlike webhooks (one `labeled` event per label), the Events API
// COLLAPSES a multi-label change made in one action into a single `IssuesEvent`
// whose `payload.label` names only ONE of the changed labels. So adding
// `bug`+`ux`+`ready` at once surfaces e.g. `labeled(ux)` and the `ready` add is
// never delivered as its own event — a `labelFilter: 'ready'` listener would
// silently miss the wake (the reported bug: "reagiert nur auf das letzte Label").
//
// Fix: for a `labeled` event, ALSO honour the object's full label set. The
// Events API carries that set at the payload TOP level (`payload.labels`), for
// BOTH IssuesEvent and PullRequestEvent (verified against real events — see
// `github-poller-events.fixture.json` / #1376). If the wake label is in that
// set, the collapsed add included it — so fire. This is scoped to `labeled`
// deliberately: on `unlabeled`, a removed label is (correctly) absent from the
// set, so we can only honour the directly-named `payload.label` there. Collapsed
// *removals* are unrecoverable from the Events API (no signal survives) — a
// known limitation; wakes are near-always on adds.
//
// The webhook-shaped nested arrays are NOT usable on the Events API:
// `pull_request.labels` never exists on a PR event (the reduced payload carries
// only base/head/id/number/url), and `issue.labels` is late-bound — a snapshot
// at read time, not at event time — so it both misses the wake label and
// spuriously matches labels added later. Prefer the top-level set whenever the
// key is PRESENT (keying off presence, not emptiness — a genuinely empty
// top-level set must not fall through to a stale nested snapshot); fall back to
// the nested arrays only for genuinely webhook-shaped payloads (the e2e
// fake-github, and any future webhook ingress).
function labelFilterMatches(ghEvent, wanted) {
  if (!wanted) return true; // no filter → fire on any label change (legacy)
  const p = ghEvent?.payload || {};
  if (p.label?.name === wanted) return true; // the directly-attributed label
  if (p.action === 'labeled') {
    const nested = p.issue || p.pull_request || {};
    const labels = Array.isArray(p.labels)
      ? p.labels
      : (Array.isArray(nested.labels) ? nested.labels : []);
    return labels.some((l) => (typeof l === 'string' ? l : l?.name) === wanted);
  }
  return false;
}

// Merged-PR detection for the PR-token-comment feature (#678). A merge is a
// `PullRequestEvent` with `action: 'closed'` AND `pull_request.merged === true`
// — a PR closed WITHOUT merging carries `merged: false` and must be ignored
// (AC edge case "PR closed without merge → no comment"). Pure + unit-tested;
// returns one `{ prNumber, event }` per merged PR (deduped by number, keeping the
// latest by created_at so a re-delivered event resolves to a single post).
function detectMergedPrs(ghEvents) {
  const byNumber = new Map();
  for (const ev of Array.isArray(ghEvents) ? ghEvents : []) {
    if (!ev || ev.type !== 'PullRequestEvent') continue;
    const p = ev.payload || {};
    if (p.action !== 'closed') continue;
    const pr = p.pull_request || {};
    if (pr.merged !== true) continue;
    const prNumber = Number(pr.number);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue;
    const prev = byNumber.get(prNumber);
    if (!prev || String(ev.created_at || '') >= String(prev.event.created_at || '')) {
      byNumber.set(prNumber, { prNumber, event: ev });
    }
  }
  return [...byNumber.values()];
}

// Accepts SSH (`git@github.com:owner/repo.git`) and HTTPS
// (`https://github.com/owner/repo[.git]`) — anything else returns null and
// is silently ignored (non-GitHub remotes can't be polled).
function parseRepoFullName(url, { allowNonGithubHost = false } = {}) {
  if (!url) return null;
  let m = String(url).match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = String(url).match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return `${m[1]}/${m[2]}`;
  if (allowNonGithubHost) {
    // #711: when the poller targets a non-github API base (the E2E fake-github),
    // recognise the in-stack git-remote fixture repo by its last two path
    // segments — mirroring deriveRepoIdentity (#667), so the same `owner/repo`
    // key the fake-github events carry is derived from the env's repo URL.
    // NEVER applied against real api.github.com (gated on a non-default base),
    // so production repo discovery is byte-identical.
    m = String(url).match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

// True when the poller is pointed at a non-production GitHub API base (the E2E
// fake-github). Used to relax repo-URL parsing to the in-stack fixture host
// without ever loosening production behaviour.
function usingNonDefaultApiBase() {
  return githubApiBase() !== DEFAULT_GITHUB_API_BASE;
}

// #320-A: the per-subscriber history horizon. Prefer the trigger's activation
// stamp (set on create and refreshed on re-enable), then its creation stamp,
// then the triggers.json mtime as the legacy fallback for triggers authored
// before the stamps existed. Returns an ISO string or null (no horizon known).
function effectiveHorizon(trigger, triggersMtime) {
  return (trigger && (trigger.activatedAt || trigger.createdAt)) || triggersMtime || null;
}

// #525: one-time history-horizon backfill for legacy github-event triggers. A
// trigger authored before the #320/#446 activation stamps has neither `createdAt`
// nor `activatedAt`, so `effectiveHorizon` falls back to the triggers.json mtime —
// a volatile value that any unrelated rewrite (member rebuild, reconcile, edit)
// bumps to "now", silently dropping events that arrived just before the rewrite.
// Stamping both fields once with a STABLE value (the caller passes the file's
// current mtime, which is exactly what the horizon resolves to right now, so no
// backlog is replayed) pins the horizon so a later rewrite can no longer move it.
// Pure and idempotent: only github-event triggers that lack `createdAt` are
// touched; an already-stamped set returns `changed: false` so re-runs write nothing.
function backfillHorizonStamps(triggers, stampIso) {
  if (!Array.isArray(triggers) || !stampIso) return { triggers, changed: false };
  let changed = false;
  const out = triggers.map((t) => {
    if (!t || t.type !== 'github-event' || t.createdAt) return t;
    changed = true;
    return { ...t, createdAt: stampIso, activatedAt: t.activatedAt || stampIso };
  });
  return { triggers: changed ? out : triggers, changed };
}

// #320-B: is `eventCreatedAt` recent enough to reach a subscriber whose horizon
// is `horizonIso`? The horizon is widened by `graceMs` to absorb late/out-of-
// order delivery. Missing horizon or timestamp fails open (deliver) — the same
// posture the code had before a horizon existed.
function passesHorizon(eventCreatedAt, horizonIso, graceMs) {
  if (!horizonIso || !eventCreatedAt) return true;
  const cutoff = Date.parse(horizonIso) - (graceMs || 0);
  const ts = Date.parse(eventCreatedAt);
  if (Number.isNaN(cutoff) || Number.isNaN(ts)) return true;
  return ts >= cutoff;
}

// #320-F: split a freshly fetched event list into the events not yet processed
// (`fresh`) and the next sliding id set (`nextSeen`), given the previous set.
// Membership is by event id, so GitHub's lack of ordering and delayed delivery
// no longer matter: an event with an older `created_at` but an unseen id is
// still fresh, and a re-observed id is never re-delivered. `nextSeen` prepends
// every currently visible id (so ids still in the API window stay remembered),
// dedups preserving newest-first order, and caps at `seenMax`.
function selectFreshEvents(events, seenArr, seenMax) {
  const list = Array.isArray(events) ? events : [];
  const seen = new Set(Array.isArray(seenArr) ? seenArr : []);
  // #2536: an id listed twice in one fetch (a burst shifting an event across
  // the page boundary during backfill) is still ONE event — deliver it once.
  const freshIds = new Set();
  const fresh = list.filter((e) => {
    if (!e || e.id == null) return false;
    const s = String(e.id);
    if (seen.has(s) || freshIds.has(s)) return false;
    freshIds.add(s);
    return true;
  });

  const nextSeen = [];
  const added = new Set();
  const push = (id) => {
    if (id == null) return;
    const s = String(id);
    if (added.has(s)) return;
    added.add(s);
    nextSeen.push(s);
  };
  for (const e of list) push(e && e.id);
  for (const id of (Array.isArray(seenArr) ? seenArr : [])) push(id);
  return { fresh, nextSeen: nextSeen.slice(0, seenMax || SEEN_MAX) };
}

// #449-C (pure core, unit-tested). Given the events that passed every delivery
// gate in one poll — each tagged as { agentId, triggerId, convKey, key, ghEvent }
// — group them by (agentId, convKey) and decide per group how to hand off:
//   mode 'digest'     when a group has MORE than `cap` events (the burst case
//                     AK2 collapses into one lossless notification), else
//   mode 'individual' (normal volume — the caller enqueues each event and applies
//                     the Layer-3 throttle unchanged).
// Group insertion order and per-group event order (caller passes oldest-first)
// are preserved. Pure — no I/O.
// #449 (pure): should the poller fetch the NEXT Events-API page? We only page to
// recover events a burst pushed off page 1. Continue while the page just read was
// FULL (so more may exist), we're under the page cap, and it contained NO
// already-seen id — a seen id means we've reached previously-processed territory,
// so everything older is already known and we stop. `pageIndex` is 1-based (the
// page we just read). A partial/empty page is always the last one.
function shouldFetchNextPage(pageEvents, seenArr, pageIndex, { perPage = PER_PAGE, maxPages = MAX_PAGES } = {}) {
  const list = Array.isArray(pageEvents) ? pageEvents : [];
  if (list.length < perPage) return false;
  if (pageIndex >= maxPages) return false;
  const seen = new Set((Array.isArray(seenArr) ? seenArr : []).map(String));
  const reachedKnown = list.some(e => e && e.id != null && seen.has(String(e.id)));
  return !reachedKnown;
}

function planBurstHandoffs(deliverables, cap) {
  const CAP = Number.isInteger(cap) && cap >= 0 ? cap : BURST_CAP;
  const groups = new Map();
  const order = [];
  for (const d of Array.isArray(deliverables) ? deliverables : []) {
    if (!d || !d.agentId) continue;
    const convKey = d.convKey ?? null;
    const gkey = `${d.agentId} ${convKey ?? ''}`;
    let g = groups.get(gkey);
    if (!g) {
      g = { agentId: d.agentId, convKey, items: [] };
      groups.set(gkey, g);
      order.push(gkey);
    }
    g.items.push(d);
  }
  return order.map((k) => {
    const g = groups.get(k);
    return {
      agentId: g.agentId,
      convKey: g.convKey,
      mode: g.items.length > CAP ? 'digest' : 'individual',
      items: g.items,
    };
  });
}

// Poller-wedge fix: run an HTTP request under a guarantee that its promise settles exactly
// once, no matter which phase stalls. `makeRequest` receives the single-settle
// `resolve`/`reject` and must return the ClientRequest so the deadline can
// destroy it (releasing the socket, if one was ever assigned).
//
// Callers still wire their own `req.on('error')` / socket `timeout` — those give
// better messages and settle sooner. This wrapper only guarantees that *some*
// settle always happens, which is the property the tick guard depends on.
function requestWithDeadline(makeRequest, { deadlineMs = REQUEST_DEADLINE_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const timer = setTimeout(() => {
      // Destroy first so a stuck socket is released, then settle. The settle is
      // independent of destroy() emitting anything — that is the whole point.
      try { if (req) req.destroy(new Error('deadline exceeded')); } catch { /* already gone */ }
      finish(reject, new Error(`request deadline exceeded after ${deadlineMs}ms`));
    }, deadlineMs);
    // Never let a pending poll deadline hold the process open on shutdown.
    if (typeof timer.unref === 'function') timer.unref();

    function finish(settle, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    }

    try {
      req = makeRequest({
        resolve: v => finish(resolve, v),
        reject: e => finish(reject, e),
      });
    } catch (err) {
      // A synchronous throw while building the request (bad URL, bad option)
      // must reject rather than escape into the caller's stack.
      finish(reject, err);
    }
  });
}

class GitHubPoller {
  constructor({ loadEnvironment, listEnvironmentIds, enqueuePending, triggersPath, onMergedPr, labelMarkers, lookupPushProducer, listKnowledgeLocations, ciGraceMs } = {}) {
    this.loadEnvironment = loadEnvironment;
    // #2794: how long a PR head commit may carry no check before its CI verdict
    // is `none` (see pr-readiness.js). AEE_PR_READINESS_CI_GRACE_MS, default 3m.
    this.ciGraceMs = Number.isFinite(ciGraceMs) && ciGraceMs >= 0 ? ciGraceMs : prReadiness.ciGraceMs();
    this.listEnvironmentIds = listEnvironmentIds;
    // #2571: who pushed a (repo, ref, head)? The orchestrator records every
    // push it makes for an agent (push-attribution.js); a trigger with a
    // `pushedBy` producer filter only fires on a push attributed to one of the
    // named agents. Absent in unit tests → every push is "producer unknown",
    // which only matters to triggers that set a filter.
    this.lookupPushProducer = typeof lookupPushProducer === 'function' ? lookupPushProducer : () => null;
    // #2602: where every team's knowledge base is pushed (`[{ url, branch }]`,
    // see knowledge-branch-exclusion.js). A push to one of those branches never
    // wakes a push trigger. Absent in unit tests → no KB branches → no exclusion.
    this.listKnowledgeLocations = typeof listKnowledgeLocations === 'function' ? listKnowledgeLocations : () => [];
    // #1858: shared dedup-marker store for the internal label fast-path. When a
    // human-applied label was already delivered internally (via the Admin
    // Console → /internal/github-label-applied), the later Events-API delivery
    // of the same label is dropped here as `internal-dedup`. Absent in unit
    // tests → no dedup (the poller behaves exactly as before).
    this.labelMarkers = labelMarkers || null;
    // #2152: edge-triggered wake de-duplication. When on (default), a `*.labeled`
    // event whose wake label is already ARMED for the object (delivered and still
    // present) is dropped as `wake-already-armed` instead of re-firing — the fix
    // for the developer being woken a second time by its own claim swap and by
    // unrelated label churn. Kill-switch `AEE_WAKE_EDGE_DEDUP=0` restores the
    // pre-#2152 behaviour (fire on every full-set match). See wake-armory.js.
    this._wakeEdgeDedup = !['0', 'false', 'off'].includes(
      String(process.env.AEE_WAKE_EDGE_DEDUP || '').toLowerCase(),
    );
    // #678: best-effort callback fired once per merged PR seen in a poll, so the
    // orchestrator can post the work item's token summary. Independent of
    // subscriber fan-out (a merge is a human action nobody need subscribe to).
    // Absent in unit tests → merge detection is a no-op.
    this.onMergedPr = typeof onMergedPr === 'function' ? onMergedPr : null;
    // #185 Phase 2: the orchestrator owns the pending queue (it writes to the
    // control plane when the agent's volume is isolated). When not injected
    // (unit tests), we fall back to writing the agent's pool file directly.
    this.enqueuePending = enqueuePending || null;
    // Canonical triggers.json location resolver (control plane when isolated).
    // Falls back to the pool subpath when not injected (unit tests).
    this.triggersPath = triggersPath || ((agentId) => path.join(AGENTS_DIR, agentId, 'triggers.json'));
    this.state = this._loadState();
    // In-memory throttle buckets, hydrated from disk at startup. Saved
    // back to disk after each fan-out tick (cheap — file is tiny).
    this.throttleBuckets = this._loadThrottleState();
    this.timer = null;
    this.running = false;
    // #2537: when the last tick finished (null until the first one has).
    this.lastTickAt = null;
    // Stall-watchdog bookkeeping for the `running` guard above.
    this.tickProgressAt = 0;
    this.tickGeneration = 0;
    // Rolling retention (#469) only needs to run about once a day; tracking
    // the last day it ran avoids a readdir/stat pass every 30s tick.
    this._lastEventLogCleanupDay = null;
  }

  start() {
    if (this.timer) return;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    console.log('[GH-Poller] Starting (interval=30s)');
    this._tick();
    this.timer = setInterval(() => this._tick(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Called whenever anything inside a tick settles. The stall watchdog
  // measures against this, so "slow but advancing" is never mistaken for stuck.
  _markTickProgress() {
    this.tickProgressAt = Date.now();
  }

  async _tick() {
    // The guard keeps two polls from overlapping (they would race on the
    // per-repo seen-set and could double-deliver). It used to be a plain
    // boolean, which made it a single point of silent failure: one await that
    // never settled stranded it at `true`, every later tick returned here, and
    // the poller stayed dead — no log line, no recovery when the network came
    // back — until the orchestrator was restarted. Per-request deadlines are the
    // primary fix; this watchdog bounds the damage of any *future* stuck await.
    if (this.running) {
      const stalledMs = Date.now() - (this.tickProgressAt || 0);
      if (stalledMs < TICK_STALL_MS) return;
      console.error(
        `[GH-Poller] Previous tick made no progress for ${Math.round(stalledMs / 1000)}s ` +
        '— forcing the poll guard open and starting a fresh tick. ' +
        'This means a request never settled; if it repeats, that is a bug worth chasing.',
      );
      // Fall through. The stranded tick is abandoned, not cancelled: should it
      // ever settle, the generation check below stops it from clearing the new
      // tick's guard (which would permit the overlap the guard exists to avoid).
    }
    this.running = true;
    this._markTickProgress();
    const generation = ++this.tickGeneration;
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (this._lastEventLogCleanupDay !== today) {
        githubEventLog.cleanupOldEntries();
        this._lastEventLogCleanupDay = today;
      }
      const plan = this._buildPollPlan();
      if (plan.size === 0) return;
      for (const [repoFullName, entry] of plan) {
        await this._pollRepo(repoFullName, entry);
        this._markTickProgress();
        // #2794: CI / merge-conflict readiness of open PRs — not on the Events
        // API, so read separately (also when the events poll returned 304).
        await this._pollReadiness(repoFullName, entry);
        this._markTickProgress();
      }
    } catch (err) {
      console.error(`[GH-Poller] Tick error: ${err.message}`);
    } finally {
      // Only the newest tick may release the guard.
      if (this.tickGeneration === generation) {
        this.running = false;
        // #2537: until the first tick has run, the status view says "waiting
        // for first poll" instead of trusting state carried over from before.
        this.lastTickAt = new Date().toISOString();
      }
    }
  }

  // Walks environments → (repo → tokenId), then agents → subscribers per repo.
  // Repos referenced by environments without a (valid) token are skipped —
  // we have no way to authenticate the poll. The decision itself is the pure
  // `computePollPlan` below (#2537): the repository status view builds its
  // "is this repo polled?" answer from the very same function, so the two can
  // never disagree.
  _buildPollPlan() {
    return computePollPlan(this._readPlanInputs(), {
      onInvalidTokenId: (env) => console.error(`[GH-Poller] env=${env.id} has invalid githubTokenId '${env.githubTokenId}' — skipping its repos`),
    });
  }

  // The fs half of the poll plan: every environment record, and every agent
  // directory with its config and triggers.json (null when missing/unreadable).
  // Disabled agents are included (with `enabled: false`) — the plan skips them,
  // the status view explains that it did.
  _readPlanInputs() {
    const environments = [];
    for (const envId of this.listEnvironmentIds()) {
      const env = this.loadEnvironment(envId);
      if (env) environments.push(env);
    }
    const agents = [];
    if (fs.existsSync(AGENTS_DIR)) {
      for (const agentId of fs.readdirSync(AGENTS_DIR)) {
        let config = null;
        try {
          config = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, agentId, 'config.json'), 'utf8'));
        } catch { /* no config.json = new/stub agent, allow through */ }
        let triggers = null;
        let triggersMtime = null;
        const triggersPath = this.triggersPath(agentId);
        try {
          if (fs.existsSync(triggersPath)) {
            triggers = JSON.parse(fs.readFileSync(triggersPath, 'utf8'));
            // mtime is the legacy fallback for the per-trigger history horizon
            // (see `effectiveHorizon`) — pre-existing triggers from before the
            // horizon was introduced have no stamp, but the file's mtime is a
            // reasonable proxy for "when this agent's triggers landed".
            triggersMtime = fs.statSync(triggersPath).mtime.toISOString();
          }
        } catch {
          triggers = null;
          triggersMtime = null;
        }
        agents.push({ id: agentId, config, triggers, triggersMtime });
      }
    }
    // #2602: re-read every tick, so a KB branch renamed by configuration is
    // evaluated against the set configured when the event is fanned out.
    let knowledgeLocations = [];
    try {
      knowledgeLocations = this.listKnowledgeLocations() || [];
    } catch (err) {
      console.error(`[GH-Poller] cannot list knowledge-base branches: ${err.message}`);
    }
    return { environments, agents, knowledgeLocations, allowNonGithubHost: usingNonDefaultApiBase() };
  }

  // #2537: the per-repository status the GitHub Event Log shows — built from the
  // same inputs and the same `computePollPlan` as a tick, plus the live
  // per-repo runtime state. Read-only; issues no GitHub request.
  repoStatusSnapshot() {
    const { buildRepoStatusView } = require('./github-repo-status');
    const inputs = this._readPlanInputs();
    const plan = computePollPlan(inputs);
    return {
      generatedAt: new Date().toISOString(),
      pollIntervalMs: POLL_INTERVAL_MS,
      lastTickAt: this.lastTickAt || null,
      repos: buildRepoStatusView({
        ...inputs,
        plan,
        state: this.state,
        firstTickDone: !!this.lastTickAt,
        tokenReadable: tokenFileReadable,
        now: Date.now(),
      }),
    };
  }

  async _pollRepo(repoFullName, { tokenId, envId, subscribers, knowledgeBranches }) {
    const repoState = this.state[repoFullName] || {};

    // Honor a previously set backoff: skip silently until skipUntil passes.
    if (repoState.skipUntil && new Date(repoState.skipUntil).getTime() > Date.now()) {
      return;
    }

    // #2537: which environment's token this repo is polled with.
    repoState.tokenId = tokenId;
    repoState.tokenEnvId = envId || null;

    if (!isValidTokenId(tokenId)) {
      console.error(`[GH-Poller] ${repoFullName}: invalid tokenId '${tokenId}' — skipping`);
      return;
    }
    const tokenPath = path.join(GH_TOKENS_DIR, tokenId);
    let token;
    try {
      token = fs.readFileSync(tokenPath, 'utf8').trim();
    } catch (err) {
      console.error(`[GH-Poller] Cannot read token ${tokenId}: ${err.message}`);
      return;
    }
    if (!token) return;

    let result;
    try {
      result = await this._fetchEvents(repoFullName, token, repoState.etag, 1);
    } catch (err) {
      // Track consecutive failures and back off exponentially (1m, 2m, 4m,
      // ...) up to 30m. Auth failures (revoked PAT) otherwise spam the log
      // forever; a 30m cap keeps recovery quick once the operator fixes it.
      const failures = (repoState.consecutiveFailures || 0) + 1;
      const delayMs = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, failures - 1),
        BACKOFF_MAX_MS,
      );
      repoState.consecutiveFailures = failures;
      repoState.skipUntil = new Date(Date.now() + delayMs).toISOString();
      // #2537: keep the last error (and when the failure streak began) so the
      // repository status view can show it — not only the console.
      const nowIso = new Date().toISOString();
      repoState.lastError = describePollError(err);
      repoState.lastErrorAt = nowIso;
      if (!repoState.failingSince) repoState.failingSince = nowIso;
      this.state[repoFullName] = repoState;
      this._saveState();
      const minutes = Math.round(delayMs / 60_000);
      console.error(
        `[GH-Poller] ${repoFullName}: ${err.message} (consecutive failures: ${failures}, next poll in ~${minutes}m)`,
      );
      return;
    }

    // Recovery — clear failure tracking and announce so operators see the
    // outage end in the logs.
    if (repoState.consecutiveFailures) {
      console.log(
        `[GH-Poller] ${repoFullName}: recovered after ${repoState.consecutiveFailures} consecutive failure(s)`,
      );
      delete repoState.consecutiveFailures;
      delete repoState.skipUntil;
    }
    delete repoState.failingSince;

    repoState.lastPolledAt = new Date().toISOString();

    if (result.status === 304) {
      this.state[repoFullName] = repoState;
      return;
    }

    if (result.etag) repoState.etag = result.etag;

    // Cursor is a sliding set of processed event ids (#320-F), not a
    // `created_at` high-water-mark. GitHub guarantees no ordering and delivers
    // events up to hours late; a high-water-mark silently drops any event that
    // arrives with a `created_at` behind the cursor. Set membership is immune
    // to ordering: an unseen id is fresh regardless of its timestamp, and a
    // re-observed id is never re-delivered. (Ids need not be monotonic — we
    // only test membership, never compare magnitudes.)
    //
    // First poll (or a legacy state file with `lastCreatedAt`) only records a
    // baseline so startup / upgrade doesn't replay history. The per-subscriber
    // horizon (#320-A/B) is the guard against reacting to pre-activation
    // activity — the cursor's only job is "have I processed this id before?".
    if (!Array.isArray(repoState.seen)) {
      // Baseline reads page 1 only — we're recording, not firing, so there's no
      // backlog to backfill.
      repoState.seen = selectFreshEvents(result.events, [], SEEN_MAX).nextSeen;
      delete repoState.lastCreatedAt;
      delete repoState.lastEventId;
      this.state[repoFullName] = repoState;
      this._saveState();
      console.log(`[GH-Poller] ${repoFullName}: baseline established (${repoState.seen.length} event id(s) seen)`);
      return;
    }

    // #449 pagination: page 1 is the newest PER_PAGE events. A burst since the
    // last poll can push older-but-unseen events onto later pages, which reading
    // only page 1 would silently drop. Page backwards until we reach already-seen
    // territory, a partial page, or the cap. Backfill pages are unconditional
    // GETs (the ETag is page 1's); a transient failure on a later page just stops
    // paging — page 1 is never lost and the next poll retries.
    let allEvents = Array.isArray(result.events) ? result.events.slice() : [];
    let pageEvents = allEvents;
    let page = 1;
    while (shouldFetchNextPage(pageEvents, repoState.seen, page, { perPage: PER_PAGE, maxPages: MAX_PAGES })) {
      page += 1;
      let next;
      try {
        next = await this._fetchEvents(repoFullName, token, null, page);
      } catch (err) {
        console.error(`[GH-Poller] ${repoFullName}: page ${page} fetch failed (${err.message}) — proceeding with ${allEvents.length} event(s)`);
        break;
      }
      if (next.status !== 200) break;
      pageEvents = Array.isArray(next.events) ? next.events : [];
      if (pageEvents.length === 0) break;
      allEvents = allEvents.concat(pageEvents);
    }
    if (page > 1) {
      console.log(`[GH-Poller] ${repoFullName}: burst backfill — read ${page} event pages (${allEvents.length} events)`);
    }

    const { fresh, nextSeen } = selectFreshEvents(allEvents, repoState.seen, SEEN_MAX);
    repoState.seen = nextSeen;

    if (fresh.length > 0) {
      repoState.lastEventAt = new Date().toISOString(); // #2537: last event received
      // GitHub returns newest-first; process oldest-first so triggers fire
      // in causal order. Events without a timestamp sort last (stable).
      fresh.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
      await this._fanOutBatch(repoFullName, fresh, subscribers, token, repoState, knowledgeBranches);
      await this._handleMergedPrs(repoFullName, fresh);
    }

    this.state[repoFullName] = repoState;
    this._saveState();
  }

  // #2794: evaluate the CI and merge readiness of the repo's open PRs and fan
  // out a synthetic `pull_request.checks_passed` / `checks_failed` /
  // `merge_conflict` event for every (PR, head commit, verdict) reached for the
  // first time. Only for a repo with a subscriber to one of those keys; the
  // verdict rules and the API budget are documented in pr-readiness.js. Any
  // GitHub failure leaves the verdicts as they were (pending is never guessed).
  async _pollReadiness(repoFullName, { tokenId, subscribers, knowledgeBranches } = {}) {
    const listeners = (subscribers || []).filter(
      (s) => prReadiness.READINESS_EVENT_KEYS.some((k) => listensTo(s.events, k)),
    );
    const repoState = this.state[repoFullName] || {};
    // #2795: a gated PR hand-off (or a hold still open) needs the same
    // verdicts, even when nobody listens to the readiness events themselves.
    const holds = repoState.holds && typeof repoState.holds === 'object' ? repoState.holds : null;
    const gated = (subscribers || []).some((s) => s.readinessGate) || (holds && Object.keys(holds).length > 0);
    if (listeners.length === 0 && !gated) {
      // Nobody listens (any more): forget the state, so a later subscriber
      // starts from a baseline instead of from stale verdicts.
      if (repoState.readiness) {
        delete repoState.readiness;
        this._saveState();
      }
      return;
    }
    // The events poll is backing off (GitHub unreachable, token revoked, …).
    if (repoState.skipUntil && new Date(repoState.skipUntil).getTime() > Date.now()) return;
    const token = this._readToken(tokenId);
    if (!token) return;
    const [owner, name] = repoFullName.split('/');

    let open;
    try {
      open = prReadiness.parseOpenPrs(await this._graphql(prReadiness.OPEN_PRS_QUERY, { owner, name }, token));
    } catch (err) {
      console.error(`[GH-Poller] ${repoFullName}: PR readiness — open PRs not readable (${err.message}); verdicts unchanged`);
      return;
    }

    let checks = null;
    const shas = prReadiness.shasToRead(repoState.readiness, open.prs);
    if (shas.length > 0) {
      const q = prReadiness.buildChecksQuery(owner, name, shas);
      try {
        checks = prReadiness.parseChecks(await this._graphql(q.query, q.variables, token), q.shas);
      } catch (err) {
        console.error(`[GH-Poller] ${repoFullName}: PR readiness — checks not readable (${err.message}); CI verdicts unchanged`);
      }
    }

    const now = Date.now();
    const result = prReadiness.evaluateReadiness({
      state: repoState.readiness,
      prs: open.prs,
      truncated: open.truncated,
      checks,
      now,
      graceMs: this.ciGraceMs,
    });
    repoState.readiness = result.state;
    this.state[repoFullName] = repoState;
    if (result.baseline) {
      console.log(`[GH-Poller] ${repoFullName}: PR readiness baseline (${open.prs.length} open PR(s)) — current verdicts recorded, none delivered`);
    }
    if (result.emits.length > 0 && listeners.length > 0) {
      const events = result.emits.map((e) => prReadiness.readinessEvent(repoFullName, e, now));
      await this._fanOutBatch(repoFullName, events, subscribers, token, repoState, knowledgeBranches);
    }
    if (holds && Object.keys(holds).length > 0) {
      await this._processHolds(repoFullName, { repoState, open, token, subscribers, now });
    }
    this._saveState();
  }

  // #2795: decide every held hand-off on this repo from the verdicts just
  // evaluated (handoff-gate.js evaluateHold) and act on the decision:
  //   release → wake the consumer now (the held event, enriched as usual);
  //   fail    → remove the wake label, set the failure label, comment;
  //   timeout → remove the wake label, set `needs-human`, comment;
  //   cancel  → forget the hold (PR closed/merged, or the wake label is gone).
  // Every resolution is logged in the GitHub Event Log against the held event.
  // A hold survives restarts in state.json; a release forgets the hold and
  // saves BEFORE it enqueues (never delivered twice), and a fail/timeout records
  // each GitHub write as it succeeds, so a retry never repeats one.
  async _processHolds(repoFullName, { repoState, open, token, subscribers = [], now = Date.now() }) {
    const holds = repoState.holds;
    const prs = new Map((open && Array.isArray(open.prs) ? open.prs : []).map((p) => [p.number, p]));
    const entries = (repoState.readiness && repoState.readiness.prs) || {};
    const live = new Set((subscribers || []).filter((s) => s.readinessGate).map((s) => s.triggerId));
    // Comments posted this pass, so two holds failing the same PR for the same
    // reason (fan-in, several gated hand-offs) comment once.
    const commented = new Set();

    for (const [hk, hold] of Object.entries(holds)) {
      if (!hold || typeof hold !== 'object' || !Number.isInteger(hold.number)) {
        delete holds[hk];
        continue;
      }
      // The gated trigger is gone (deleted, gate switched off, agent disabled):
      // nothing is waiting for this hold any more.
      let decision = live.has(hold.triggerId)
        ? handoffGate.evaluateHold(hold, {
          pr: prs.get(hold.number) || null,
          listComplete: !(open && open.truncated),
          entry: entries[hold.number] || null,
          now,
        })
        : { action: 'cancel', reason: 'trigger-removed' };
      if (hold.resolution) decision = hold.resolution.decision; // finish what was started

      if (decision.action === 'wait') continue;
      if (decision.action === 'cancel') {
        delete holds[hk];
        console.log(`[GH-Poller] readiness-gate: ${repoFullName}#${hold.number} → ${hold.agentId} cancelled (${decision.reason})`);
        this._logHoldOutcome(repoFullName, hold, {
          status: 'dropped', reason: 'gate-cancelled', cancelReason: decision.reason,
        });
        continue;
      }
      if (decision.action === 'release') {
        delete holds[hk];
        this._saveState();
        const stored = hold.event || {};
        const payload = await this._enrichPullRequestPayload(hold.key, stored.payload, token);
        const ghEvent = { ...stored, payload };
        const d = this._enqueue(hold.agentId, hold.triggerId, hold.key, ghEvent, hold.wakeLabel);
        console.log(`[GH-Poller] readiness-gate: ${repoFullName}#${hold.number} → ${hold.agentId} released (head ${String(decision.sha || '').slice(0, 7)})`);
        const outcome = { status: 'delivered', reason: 'gate-released', gates: handoffGate.enabledGates(hold.gate) };
        if (d && d.held) {
          outcome.status = 'held';
          outcome.reason = d.reason || 'wip';
          if (d.wipLimit != null) outcome.wipLimit = d.wipLimit;
        } else if (d && d.instanceId) {
          outcome.instanceId = d.instanceId;
        }
        this._logHoldOutcome(repoFullName, hold, outcome, ghEvent);
        continue;
      }
      // fail / timeout: three GitHub writes, each recorded once done.
      if (!hold.resolution) hold.resolution = { decision, done: {} };
      const ok = await this._resolveHold(repoFullName, hold, token, commented);
      if (!ok) continue; // retried on the next pass; the hold keeps waking nobody
      delete holds[hk];
      // The wake label is gone: a later genuine re-add must wake again.
      if (hold.wakeLabel && repoState.armed) {
        wakeArmory.disarmLabel(repoState.armed, { kind: 'pr', number: hold.number, label: hold.wakeLabel });
      }
      const failed = decision.action === 'fail';
      console.log(
        `[GH-Poller] readiness-gate: ${repoFullName}#${hold.number} → ${hold.agentId} not woken ` +
        `(${failed ? `${decision.gate} failed` : `timed out waiting for ${handoffGate.gatesText(decision.pending)}`})`,
      );
      this._logHoldOutcome(repoFullName, hold, {
        status: 'dropped',
        reason: failed ? 'gate-failed' : 'gate-timeout',
        gates: failed ? [decision.gate] : (decision.pending || handoffGate.enabledGates(hold.gate)),
      });
    }
  }

  // #2795: the GitHub writes of a failed / timed-out hold, in order: remove the
  // wake label, set the failure (or `needs-human`) label, post the comment.
  // True once all are done. A step that fails stops here; the done-flags
  // persisted in the hold make the next pass resume after the last success.
  async _resolveHold(repoFullName, hold, token, commented) {
    const { decision, done } = hold.resolution;
    const gate = handoffGate.normalizeGate(hold.gate) || {};
    const setLabel = decision.action === 'fail' ? gate.failureLabel : handoffGate.TIMEOUT_LABEL;
    const base = `/repos/${repoFullName}/issues/${hold.number}`;
    try {
      if (!done.removed) {
        if (hold.wakeLabel) {
          await this._githubWrite('DELETE', `${base}/labels/${encodeURIComponent(hold.wakeLabel)}`, null, token, { okStatus: [404] });
        }
        done.removed = true;
        this._saveState();
      }
      if (!done.labelled) {
        await this._githubWrite('POST', `${base}/labels`, { labels: [setLabel] }, token);
        done.labelled = true;
        this._saveState();
      }
      if (!done.commented) {
        const ck = `${hold.number}\u0000${decision.action}\u0000${decision.gate || ''}\u0000${hold.wakeLabel || ''}`;
        if (!commented.has(ck)) {
          const body = decision.action === 'fail'
            ? handoffGate.failureComment({ decision, hold, consumer: hold.agentId })
            : handoffGate.timeoutComment({ decision, hold, consumer: hold.agentId });
          await this._githubWrite('POST', `${base}/comments`, { body }, token);
          commented.add(ck);
        }
        done.commented = true;
        this._saveState();
      }
      return true;
    } catch (err) {
      console.error(`[GH-Poller] readiness-gate: ${repoFullName}#${hold.number} — GitHub write failed (${err.message}); retried next pass`);
      return false;
    }
  }

  // #2795: one GitHub Event Log row for a hold's resolution, against the held
  // event (its id suffixed, so the row is distinct from the original "held").
  _logHoldOutcome(repoFullName, hold, fields, ghEventArg = null) {
    const stored = ghEventArg || hold.event || {};
    const action = String(fields.reason || 'gate').replace(/^gate-/, '');
    const outcome = {
      agentId: hold.agentId, triggerId: hold.triggerId, digest: false,
      wakeLabel: hold.wakeLabel || null,
      ...fields,
    };
    githubEventLog.record(githubEventLog.buildEventEntry({
      ghEvent: { ...stored, id: `${stored.id}:gate-${action}` },
      repoFullName,
      key: hold.key,
      outcomes: [outcome],
    }));
  }

  // #2795: the holds the poller is keeping, for the Flow Control board:
  // `[{ repo, number, agentId, triggerId, wakeLabel, gates, waitingFor, heldAt }]`.
  // `waitingFor` = the enabled gates the current head has not yet satisfied.
  gateHolds() {
    const out = [];
    for (const [repo, repoState] of Object.entries(this.state || {})) {
      const holds = repoState && repoState.holds;
      if (!holds || typeof holds !== 'object') continue;
      const entries = (repoState.readiness && repoState.readiness.prs) || {};
      for (const hold of Object.values(holds)) {
        const gate = hold && handoffGate.normalizeGate(hold.gate);
        if (!gate) continue;
        out.push({
          repo,
          number: hold.number,
          agentId: hold.agentId,
          triggerId: hold.triggerId,
          wakeLabel: hold.wakeLabel || null,
          gates: handoffGate.enabledGates(gate),
          waitingFor: handoffGate.pendingGates(gate, entries[hold.number] || null),
          heldAt: hold.heldAt,
        });
      }
    }
    return out;
  }

  // #2795: a GitHub REST write (label add/remove, comment) under the poller's
  // request deadline. Resolves the parsed body (or null); rejects on any status
  // outside 2xx and `okStatus` (e.g. 404 for removing a label already gone).
  _githubWrite(method, apiPath, body, token, { okStatus = [] } = {}) {
    return requestWithDeadline(({ resolve, reject }) => {
      const api = resolveGithubApiTarget();
      const data = body == null ? null : JSON.stringify(body);
      const headers = {
        'User-Agent': 'agent-studio-poller',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (data != null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      const req = api.transport.request({
        hostname: api.hostname,
        port: api.port,
        path: `${api.basePath}${apiPath}`,
        method,
        headers,
        timeout: 15_000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        // See _fetchEvents — same two handlers, same reason.
        res.on('aborted', () => reject(new Error('response aborted before end')));
        res.on('error', reject);
        res.on('end', () => {
          const ok = (res.statusCode >= 200 && res.statusCode < 300) || okStatus.includes(res.statusCode);
          if (!ok) {
            reject(new Error(`${method} ${apiPath}: HTTP ${res.statusCode}`));
            return;
          }
          try {
            const text = Buffer.concat(chunks).toString();
            resolve(text ? JSON.parse(text) : null);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.end(data == null ? undefined : data);
      return req;
    });
  }

  // #2794: the poll token for `tokenId` (null when unusable). A method so the
  // readiness tests can stand in for the token store.
  _readToken(tokenId) {
    return readTokenFile(tokenId);
  }

  // #2794: a GitHub GraphQL POST under the same request deadline as every other
  // poller request. `/api/v3` (GHE) maps to `/api/graphql`, api.github.com to
  // `/graphql`. Resolves `data`; a partial result (GraphQL `errors` beside
  // `data`, e.g. a commit GitHub no longer has) still resolves — the parsers
  // skip what is missing.
  _graphql(query, variables, token) {
    return requestWithDeadline(({ resolve, reject }) => {
      const api = resolveGithubApiTarget();
      const gqlPath = /\/v3$/.test(api.basePath) ? api.basePath.replace(/\/v3$/, '/graphql') : `${api.basePath}/graphql`;
      const body = JSON.stringify({ query, variables });
      const req = api.transport.request({
        hostname: api.hostname,
        port: api.port,
        path: gqlPath,
        method: 'POST',
        headers: {
          'User-Agent': 'agent-studio-poller',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${token}`,
        },
        timeout: 15_000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        // See _fetchEvents — same two handlers, same reason.
        res.on('aborted', () => reject(new Error('response aborted before end')));
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`graphql HTTP ${res.statusCode}`));
            return;
          }
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            if (!json || !json.data) {
              const msg = json && Array.isArray(json.errors) && json.errors[0] && json.errors[0].message;
              reject(new Error(`graphql: ${msg || 'no data'}`));
              return;
            }
            resolve(json.data);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.end(body);
      return req;
    });
  }

  // #678: fire the merge callback for every merged PR in this batch. Fully
  // best-effort and isolated per PR — a token-comment failure must never break
  // event delivery or poller state. The callback (orchestrator side) owns the
  // opt-in gate, work-item resolution, idempotency and posting; the poller only
  // detects the merge and hands off (thin shell, AC8).
  async _handleMergedPrs(repoFullName, ghEvents) {
    if (!this.onMergedPr) return;
    for (const { prNumber, event } of detectMergedPrs(ghEvents)) {
      try {
        await this.onMergedPr(repoFullName, prNumber, event);
      } catch (err) {
        console.error(`[GH-Poller] ${repoFullName}#${prNumber}: merge callback failed: ${err.message}`);
      }
    }
  }

  async _fanOutBatch(repoFullName, ghEvents, subscribers, token, repoStateArg, knowledgeBranches = []) {
    // Phase 1 — per-event delivery gates (history horizon, label filter).
    // Everything that survives becomes a "deliverable" tagged with its
    // subscriber + conversation, to be grouped in phase 2. Events arrive
    // oldest-first (caller sorted), so per-group order stays causal.
    //
    // There is NO source/origin filtering here unless a push trigger opts into
    // a producer filter (`pushedBy`, #2571): otherwise a trigger fires on any
    // matching event regardless of who caused it (human, another agent, or the
    // subscriber itself). The only backstop against a self-triggering loop is
    // the frequency-based Layer-3 throttle + burst digest in phase 2. The one
    // built-in exception is a push to a knowledge-base branch (#2602), which
    // never wakes a push trigger (`knowledgeBranches`, the repo's KB branches).
    //
    // `eventLogEntries` (#469) accumulates one entry per event for the
    // event-transparency log, keyed by event id — populated here with the
    // per-subscriber gate outcomes, then finalised with phase 2's digest/
    // throttle/delivered outcomes below, and written out once at the end.
    // A subscriber that doesn't listen to this event type at all (`!listensTo(sub.events, key)`)
    // is NOT recorded as an outcome — that's the "no one is listening" case
    // (AC #4), distinct from "someone listened but a gate dropped it" (AC #3).
    const deliverables = [];
    const eventLogEntries = new Map();

    // #2152: the per-repo armed-wake set, persisted in state.json by the caller's
    // _saveState() after this batch. GC'd once per batch (TTL + cap). Absent /
    // malformed -> a fresh object, so an upgraded stack self-heals.
    const repoState = repoStateArg || this.state[repoFullName] || (this.state[repoFullName] = {});
    if (!repoState.armed || typeof repoState.armed !== 'object') repoState.armed = {};
    const armed = repoState.armed;
    if (this._wakeEdgeDedup) wakeArmory.gcArmed(armed);

    // #2529: push heads already seen on this repo, for the synthetic-vs-real
    // push de-dup below. Same persistence/self-heal contract as `armed`.
    if (!repoState.pushHeads || typeof repoState.pushHeads !== 'object') repoState.pushHeads = {};
    const pushHeads = repoState.pushHeads;
    gcPushHeads(pushHeads);

    for (const ghEvent of expandPrOpenPushes(ghEvents)) {
      const key = eventKey(ghEvent);
      const logEntry = { ghEvent, key, outcomes: [] };
      eventLogEntries.set(ghEvent.id, logEntry);
      if (!key) continue;
      const convKey = conversationKey(ghEvent);
      // #2602: a push to any team's knowledge-base branch on this repo (incl. a
      // #2529 synthetic PR-open push whose head is that branch).
      const knowledgePush = key === 'push' && isKnowledgeBranchPush(ghEvent, knowledgeBranches);

      // #2529: first push-class event for a (branch, head sha) wins; a later one
      // — the real PushEvent after the PR-open synthetic, or a PR (re)open whose
      // head a real push already delivered — is a duplicate. Recorded
      // subscription-independently so the order of arrival never matters.
      const synthesizedFrom = key === 'push' ? ghEvent.payload?.synthesizedFrom : null;
      let pushDuplicate = false;
      // #2571: the producer of this push, looked up lazily — only a subscriber
      // with a `pushedBy` filter needs it. `undefined` = not looked up yet.
      let pushProducer;
      if (key === 'push') {
        const hk = pushHeadKey(ghEvent);
        if (hk) {
          if (pushHeads[hk] != null) pushDuplicate = true;
          else pushHeads[hk] = Date.now();
        }
      }

      // #2152: disarm on removal/close, subscription-independent and BEFORE this
      // event's subscriber arm-check. Events are oldest-first, so a same-batch
      // remove -> re-add ends armed+delivered, while a batch's own labeled fires
      // before a later unlabeled clears it. A wake label removed (its own claim
      // swap does this too) or a closed object re-arms, so a genuine later
      // re-label fires again.
      if (this._wakeEdgeDedup && typeof key === 'string') {
        const num = workItemNumber(ghEvent);
        if (num != null) {
          const kind = key.startsWith('pull_request') ? 'pr' : 'issue';
          const removed = ghEvent.payload?.label?.name;
          if (key.endsWith('.unlabeled') && removed) {
            wakeArmory.disarmLabel(armed, { kind, number: num, label: removed });
          } else if (key.endsWith('.closed')) {
            wakeArmory.disarmObject(armed, { kind, number: num });
          } else if (key.endsWith('.labeled')) {
            // Presence-based disarm (#2152 follow-up): the Events API never
            // delivers a standalone `unlabeled(<wake>)` for a PR (the removal is
            // collapsed with the paired claim-swap add, or dropped entirely), so
            // the `unlabeled` branch above never fires for the dominant flow and
            // an arm set on the first wake is otherwise never cleared. Every
            // `labeled` event, however, carries the object's CURRENT full label
            // set — so any wake armed on an earlier event but no longer present
            // has been removed by SOME means (the agent's claim swap, a human
            // web-UI removal, CI) and is disarmed here, without ever needing to
            // observe the removal itself. Guarded on the full set being present:
            // a synthetic fast-path event carries none, and absence must never be
            // read as "all removed". The non-atomic `<wake>:wip` snapshot that
            // still lists `<wake>` correctly does NOT disarm here — it re-checks
            // on the next event, whose snapshot is current.
            const labelsArr = Array.isArray(ghEvent.payload?.labels) ? ghEvent.payload.labels : null;
            if (labelsArr) {
              const present = new Set(
                labelsArr.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
              );
              wakeArmory.disarmAbsent(armed, { kind, number: num, presentLabels: present });
            }
          }
        }
      }

      for (const sub of subscribers) {
        // #2536: alias-aware — a trigger stored with either form of the review
        // key matches, and one listing both still yields a single outcome.
        if (!listensTo(sub.events, key)) continue;
        // #2529: a trigger that also listens to the originating PR event is
        // already woken by it — the synthetic push would wake it twice for the
        // same moment. Not an outcome: the real PR event row records its wake.
        if (synthesizedFrom && listensTo(sub.events, synthesizedFrom)) continue;

        const outcome = { agentId: sub.agentId, triggerId: sub.triggerId, status: 'pending', reason: null, digest: false };
        logEntry.outcomes.push(outcome);

        // Knowledge-base branch (#2602): a KB sync push never wakes a push
        // trigger — built in, not configurable, regardless of the trigger's
        // `branchFilter` (even one listing the KB branch or `**`) or `pushedBy`.
        // First gate, so a KB push never reaches the wake dedup / burst /
        // throttle layers and never feeds an "Event burst clamped" digest.
        if (knowledgePush) {
          console.log(
            `[GH-Poller] knowledge-branch: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
            `(ref='${ghEvent.payload?.ref ?? '?'}' is a knowledge-base branch)`,
          );
          outcome.status = 'dropped';
          outcome.reason = 'knowledge-branch';
          continue;
        }

        // History horizon (#320-A/B): skip events older than the subscriber's
        // horizon, widened by GRACE_MS to absorb late/out-of-order delivery.
        // Cheapest check, runs before everything else — a brand-new or just-
        // reactivated agent never reads (let alone reacts to) activity that
        // pre-dates it, even when the per-repo cursor is stale (e.g. another
        // agent already advanced it past those events).
        if (!passesHorizon(ghEvent.created_at, sub.horizon, GRACE_MS)) {
          console.log(
            `[GH-Poller] history-horizon: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
            `(event=${ghEvent.created_at}, sub-since=${sub.horizon}, grace=${GRACE_MS}ms)`,
          );
          outcome.status = 'dropped';
          outcome.reason = 'history-horizon';
          continue;
        }

        if (pushDuplicate) {
          console.log(
            `[GH-Poller] push-dedup: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
            `(${pushHeadKey(ghEvent)} already seen)`,
          );
          outcome.status = 'dropped';
          outcome.reason = 'push-duplicate';
          continue;
        }

        // Producer filter (#2571): a push trigger naming `pushedBy` agents fires
        // only on a push the platform recorded as made by one of them (or a pool
        // instance of one), from the subscriber's own Agent Team. A human push,
        // a raw `git push`, a knowledge-base sync or a branch deletion carries no
        // record — "producer unknown" — and is dropped too.
        if (key === 'push' && sub.pushedBy) {
          if (pushProducer === undefined) {
            try {
              pushProducer = this.lookupPushProducer({
                repo: repoFullName,
                ref: ghEvent.payload?.ref,
                head: ghEvent.payload?.head,
              }) || null;
            } catch { pushProducer = null; }
          }
          const verdict = pushAttribution.producerFilterVerdict(sub.pushedBy, sub.teamId, pushProducer);
          if (!verdict.ok) {
            console.log(
              `[GH-Poller] producer-filter: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
              `(pushed by ${verdict.producer || 'unknown'}, filter [${sub.pushedBy.join(', ')}])`,
            );
            outcome.status = 'dropped';
            outcome.reason = 'producer-filter';
            outcome.producer = verdict.producer;
            continue;
          }
        }

        // Self-caused claim label (#1376 follow-up): after this trigger fires,
        // the claim swap ADDS its own `<wake>:wip` label (sub.claimAdd) and
        // removes `<wake>`. Adding `<wake>:wip` emits its own `*.labeled` event
        // whose event-time `payload.labels` snapshot can STILL carry `<wake>`
        // (the paired remove is not atomic with the add), so `labelFilterMatches`
        // below would fire the trigger a SECOND time on the agent's OWN status
        // decoration. The directly-attributed label being our claim label is
        // never a human wake — drop it before the label-filter match. Keyed on
        // the exact `payload.label.name` (not the full set), so a genuine human
        // re-add of the wake label — whose attributed label IS the wake label —
        // is unaffected. Scoped to `*.labeled`.
        //
        // #2776: the same holds for the runner's completion swap (#1163,
        // `<wake>:wip` → `<wake>:completed`). When the Events API collapses the
        // claim swap away, this `<wake>:completed` add can be the ONLY event the
        // poller sees from the run — and its stale snapshot may still name
        // `<wake>`. Treat it like the claim label: drop it and disarm, so a
        // later genuine human re-add of `<wake>` wakes the trigger again.
        if (
          typeof key === 'string' && key.endsWith('.labeled') &&
          isSelfClaimLabel(sub, ghEvent.payload?.label?.name)
        ) {
          // #2152 follow-up: the wake label's DISARM (wake-armory) keys on a
          // standalone `*.unlabeled(<wake>)` event — but the claim swap removes
          // `<wake>` and adds `<wake>:wip` in ONE `gh issue edit` action, which
          // the Events API collapses to a single `labeled(<wake>:wip)` event: the
          // `unlabeled(<wake>)` signal never arrives, so the arm set on the first
          // wake is NEVER cleared, and a legitimate later re-hand-off that re-adds
          // `<wake>` (e.g. reworker → code-reviewer) is silently dropped as
          // `wake-already-armed`. Seeing THIS claim-label add is a reliable proxy
          // for that lost removal (the swap's contract is remove-`<wake>` +
          // add-`<wake>:wip`, and this event the poller DOES observe), so disarm
          // `<wake>` here. Object-scoped (across all triggers), like the
          // `unlabeled` disarm. Safe against re-opening the #2152 double-fire: any
          // later churn event carries a current snapshot with `<wake>` gone, so
          // full-set matching can no longer re-fire it — only a genuine fresh
          // `labeled(<wake>)` will, which is exactly the wake we want restored.
          if (this._wakeEdgeDedup && sub.labelFilter) {
            const num = workItemNumber(ghEvent);
            if (num != null) {
              wakeArmory.disarmLabel(armed, {
                kind: key.startsWith('pull_request') ? 'pr' : 'issue',
                number: num,
                label: sub.labelFilter,
              });
            }
          }
          console.log(
            `[GH-Poller] self-claim-label: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
            `(claim label '${ghEvent.payload.label.name}' is agent-set, never a wake; disarmed '${sub.labelFilter}')`,
          );
          outcome.status = 'dropped';
          outcome.reason = 'self-claim-label';
          continue;
        }

        // Label-name filter for *.labeled / *.unlabeled events. Content routing
        // (WHICH label), not a source filter — how label hand-offs (incl.
        // human-approval gates) are wired. Matches the directly-attributed
        // `payload.label.name` OR, for a `labeled` event, any label in the
        // object's current set — the latter recovers wakes the Events API loses
        // when it collapses a multi-label change (see labelFilterMatches).
        // No-op for non-label events.
        if (sub.labelFilter) {
          if (!labelFilterMatches(ghEvent, sub.labelFilter)) {
            const labelName = ghEvent.payload?.label?.name;
            console.log(
              `[GH-Poller] label-filter: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
              `(label='${labelName ?? '?'}', want='${sub.labelFilter}')`,
            );
            outcome.status = 'dropped';
            outcome.reason = 'label-filter';
            continue;
          }
        }

        // Branch filter for `push` events (#2570). Content routing like the
        // label filter: a push to a branch the trigger does not list is dropped
        // here, before any wake. Scoped to `push` only — a trigger that also
        // listens to other events is unaffected for those (AC9). A tag push has
        // no branch, so a non-empty filter never matches it. The log entry's
        // `ref` already names the branch, so the outcome needs no copy of it.
        if (key === 'push' && sub.branchFilter) {
          const branch = pushBranch(ghEvent);
          if (!branchFilterMatches(branch, sub.branchFilter)) {
            console.log(
              `[GH-Poller] branch-filter: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
              `(ref='${ghEvent.payload?.ref ?? '?'}', want='${sub.branchFilter.join(', ')}')`,
            );
            outcome.status = 'dropped';
            outcome.reason = 'branch-filter';
            continue;
          }
        }

        // Record the matched wake label per-outcome (#1846). This is the label
        // that actually satisfied this subscriber's filter — which may differ
        // from payload.label.name when the Events API collapses a multi-label
        // change (e.g. payload.label.name='ux' but the subscriber matched
        // 'ready' from the full payload.labels set). null for any-label
        // listeners (no labelFilter). Not set for history-horizon or
        // label-filter drops, which continue before reaching this point.
        outcome.wakeLabel = sub.labelFilter || null;

        // #2152: the wake-edge armed key for this (trigger, object, wake label),
        // computed once and shared by the internal-dedup drop path (which arms it
        // so a later claim swap OUTSIDE the plugin window is still caught) and the
        // rising-edge check below. Only for `*.labeled` with a real wake label;
        // any-label listeners (null filter) have nothing to arm on.
        let wakeArmKey = null;
        if (this._wakeEdgeDedup && sub.labelFilter && typeof key === 'string' && key.endsWith('.labeled')) {
          const num = workItemNumber(ghEvent);
          if (num != null) {
            wakeArmKey = wakeArmory.armedKey({
              triggerId: sub.triggerId,
              kind: key.startsWith('pull_request') ? 'pr' : 'issue',
              number: num, label: sub.labelFilter,
            });
          }
        }

        // Internal fast-path dedup (#1858): if this (agent, trigger, repo,
        // number, wakeLabel) wake was already delivered internally by the plugin
        // path within the match window, drop this later Events-API event. Scoped
        // to `*.labeled` — the only events the fast-path delivers. Window-scoped,
        // not consume-once: a single apply churns up several matching events (the
        // real `<wake>` delivery, the claim swap's `<wake>:wip` add, a co-added
        // label) and ALL within the window are dropped; a legitimate later
        // re-label (created_at outside the window) still fires normally. Runs
        // BEFORE the wake-edge check so its more-specific reason wins for an
        // in-window echo — but still ARMS the wake-edge key, so a claim swap that
        // lands after the window is caught by wake-already-armed rather than
        // re-firing.
        if (this.labelMarkers && typeof key === 'string' && key.endsWith('.labeled')) {
          const wl = sub.labelFilter || ghEvent.payload?.label?.name || null;
          const num = workItemNumber(ghEvent);
          if (wl && num != null) {
            const dropped = this.labelMarkers.shouldDrop({
              agentId: sub.agentId, triggerId: sub.triggerId,
              repo: repoFullName,
              kind: key.startsWith('pull_request') ? 'pr' : 'issue',
              number: num, label: wl,
              eventCreatedAt: ghEvent.created_at,
            });
            if (dropped) {
              console.log(
                `[GH-Poller] internal-dedup: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
                `(already delivered internally, ${repoFullName}#${num} +${wl})`,
              );
              if (wakeArmKey) wakeArmory.arm(armed, wakeArmKey, Date.now());
              outcome.status = 'dropped';
              outcome.reason = 'internal-dedup';
              continue;
            }
          }
        }

        // Edge-triggered wake dedup (#2152): fire a full-set label match only on
        // the RISING edge. A wake label already armed for the object — delivered
        // on an earlier event and still present — means this is a re-fire from
        // unrelated label churn or the agent's OWN claim swap (whose `<wake>:wip`
        // add carries an event-time snapshot that still names `<wake>`, and whose
        // attributed label the Events API may mis-report, defeating the
        // self-claim-label guard). Drop it; otherwise arm the rising edge. Disarm
        // happens in the outer loop on the label's removal or the object's close.
        if (wakeArmKey) {
          if (wakeArmory.isArmed(armed, wakeArmKey)) {
            console.log(
              `[GH-Poller] wake-already-armed: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
              `(${repoFullName} ${sub.labelFilter} still present on the object, no fresh add)`,
            );
            outcome.status = 'dropped';
            outcome.reason = 'wake-already-armed';
            continue;
          }
          wakeArmory.arm(armed, wakeArmKey, Date.now());
        }

        // #2795: a gated PR hand-off is HELD until the PR's current head is
        // green / conflict-free; `_pollReadiness` releases, fails, times out or
        // cancels it (see handoff-gate.js). After the wake-edge arm, so label
        // churn on the PR while held is still deduplicated.
        if (handoffGate.gateApplies(sub.readinessGate, key)) {
          const num = workItemNumber(ghEvent);
          if (num != null) {
            if (!repoState.holds || typeof repoState.holds !== 'object') repoState.holds = {};
            const hk = handoffGate.holdKey(sub.triggerId, num);
            if (!repoState.holds[hk]) {
              repoState.holds[hk] = handoffGate.newHold({
                sub, key, ghEvent, number: num,
                wakeLabel: key.endsWith('.labeled') ? sub.labelFilter : null,
              });
            }
            console.log(
              `[GH-Poller] readiness-gate: ${key} (${ghEvent.id}) → ${sub.agentId} held ` +
              `(${repoFullName}#${num} waiting for ${handoffGate.gatesText(handoffGate.enabledGates(sub.readinessGate))})`,
            );
            outcome.status = 'held';
            outcome.reason = 'readiness-gate';
            outcome.gates = handoffGate.enabledGates(sub.readinessGate);
            continue;
          }
        }

        deliverables.push({
          agentId: sub.agentId,
          triggerId: sub.triggerId,
          convKey,
          key,
          ghEvent,
          outcome,
        });
      }
    }

    // Phase 2 — group by (agent, conversation) and hand off (#449-C). A group
    // larger than BURST_CAP collapses into ONE lossless digest; smaller groups
    // go out individually, each still gated by the Layer-3 throttle exactly as
    // before (the throttle is deliberately NOT applied to a digest — see
    // _enqueueDigest).
    const plans = planBurstHandoffs(deliverables, BURST_CAP);
    let throttleStateDirty = false;
    // #496: cache the enrichment per event id — a PR event fanning out to
    // several subscribers (e.g. code-reviewer + security-reviewer +
    // test-reviewer all on pull_request.opened) enriches once, not once per
    // subscriber. Keyed by event id since that's what identifies a ghEvent
    // within this batch; value is the (possibly unchanged) payload.
    const enrichedPayloads = new Map();

    for (const plan of plans) {
      if (plan.mode === 'digest') {
        this._enqueueDigest(plan.agentId, plan.convKey, plan.items);
        for (const it of plan.items) {
          it.outcome.status = 'delivered';
          it.outcome.digest = true;
        }
        continue;
      }

      for (const it of plan.items) {
        // Layer-3 throttle: count per (agent, conversation). Drops further
        // reactions once the threshold is exceeded; the very first drop also
        // schedules a one-shot DM warning so the user sees the clamp.
        const t = this._checkAndIncThrottle(it.agentId, it.convKey);
        throttleStateDirty = true;
        if (t.drop) {
          console.log(
            `[GH-Poller] throttle: ${it.key} (${it.ghEvent.id}) → ${it.agentId} dropped ` +
            `(conv=${it.convKey}, count=${t.count}/${t.threshold}/h, window-ends=${t.windowEndsAt})`,
          );
          if (t.justWarned) {
            this._enqueueThrottleWarning(it.agentId, it.convKey, t);
            console.log(
              `[GH-Poller] throttle: warning queued for ${it.agentId} (conv=${it.convKey})`,
            );
          }
          it.outcome.status = 'dropped';
          it.outcome.reason = 'throttle';
          continue;
        }

        if (!enrichedPayloads.has(it.ghEvent.id)) {
          enrichedPayloads.set(
            it.ghEvent.id,
            await this._enrichPullRequestPayload(it.key, it.ghEvent.payload, token),
          );
        }
        const payload = enrichedPayloads.get(it.ghEvent.id);
        const ghEvent = payload === it.ghEvent.payload ? it.ghEvent : { ...it.ghEvent, payload };

        const decision = this._enqueue(it.agentId, it.triggerId, it.key, ghEvent, it.outcome.wakeLabel);
        // The dispatch is durably recorded either way; whether it RAN or is
        // waiting behind a full WIP lane is the difference between "delivered"
        // and "held" — record the true one so the GitHub Event Log never claims
        // a held dispatch was delivered (which then dead-ends on "no session").
        if (decision && decision.held) {
          it.outcome.status = 'held';
          // 'wip' (the flow's lane) unless a pooled role's pause/drain held it
          // ('pool-paused' etc., #2596).
          it.outcome.reason = decision.reason || 'wip';
          if (decision.wipLimit != null) it.outcome.wipLimit = decision.wipLimit;
        } else {
          it.outcome.status = 'delivered';
          // #2596: a pooled role's dispatch ran on its per-ticket instance —
          // record it so the log links that instance, not the role template.
          if (decision && decision.instanceId) it.outcome.instanceId = decision.instanceId;
        }
      }
    }

    if (throttleStateDirty) this._saveThrottleState();

    // #1833 item 2 — enrich EVERY pull_request* event before it is logged,
    // regardless of trigger outcome. Phase 2 only enriches delivered events, so
    // a throttled / digested / no-subscriber PR event otherwise reached the log
    // from the raw payload → bare `#number`, empty title, no PR→issue link.
    // Reuses the SAME per-event-id cache (AC2.3), so a PR already enriched above
    // is not re-fetched; non-PR events return identity from the enricher (no
    // cost). Best-effort — a failed enrich falls back to the raw payload below.
    for (const entry of eventLogEntries.values()) {
      const key = entry.key;
      if (typeof key === 'string' && key.startsWith('pull_request') && !enrichedPayloads.has(entry.ghEvent.id)) {
        enrichedPayloads.set(
          entry.ghEvent.id,
          await this._enrichPullRequestPayload(key, entry.ghEvent.payload, token),
        );
      }
    }

    // #469 — persist the transparency log entry for every fresh event in this
    // batch, whether it was delivered, dropped, digested, or matched no
    // subscriber at all. Best-effort (see github-event-log.js); never throws.
    // #1827 — prefer the enriched payload (title/html_url filled in for PR
    // events) so the log captures the work item; #1833 extends that enrichment
    // to every PR event (loop just above) so throttled/digested/no-subscriber
    // rows also carry the work item + closes link.
    for (const entry of eventLogEntries.values()) {
      const enriched = enrichedPayloads.get(entry.ghEvent.id);
      const ghEventForLog = enriched && enriched !== entry.ghEvent.payload
        ? { ...entry.ghEvent, payload: enriched }
        : entry.ghEvent;
      githubEventLog.record(
        githubEventLog.buildEventEntry({
          ghEvent: ghEventForLog,
          repoFullName,
          key: entry.key,
          outcomes: entry.outcomes.map(({ agentId, triggerId, status, reason, digest, wakeLabel, wipLimit, producer, instanceId, gates }) => {
            const o = { agentId, triggerId, status, reason, digest };
            if (wakeLabel !== undefined) o.wakeLabel = wakeLabel;
            // Held-by-WIP outcomes carry the flow's limit so the log row can read
            // "held (WIP n)" rather than a bare "held".
            if (wipLimit !== undefined) o.wipLimit = wipLimit;
            // A producer-filter drop names who pushed (null = unknown), #2571.
            if (producer !== undefined) o.producer = producer;
            // The pool instance a pooled role's delivery ran on (#2596).
            if (instanceId !== undefined) o.instanceId = instanceId;
            // #2795: the hand-off gates a readiness-gate hold waits for.
            if (gates !== undefined) o.gates = gates;
            return o;
          }),
        }),
      );
    }
  }

  // #449-D: append one `github-digest` entry summarising a burst of events for a
  // single (agent, conversation). Lossless — every event is listed — but NOT run
  // through the Layer-3 throttle: the digest IS the anti-flood response, so it
  // must always reach the agent. The runtime posts it as a plain DM (no LLM
  // call), mirroring the throttle-warning delivery.
  _enqueueDigest(agentId, convKey, items) {
    const events = items.map((it) => ({
      event: it.key,
      eventId: it.ghEvent.id,
      repo: it.ghEvent.repo?.name,
      actor: it.ghEvent.actor?.login,
      createdAt: it.ghEvent.created_at,
    }));
    const triggerIds = [...new Set(items.map((it) => it.triggerId).filter(Boolean))];
    this._enqueuePending(agentId, {
      kind: 'github-digest',
      convKey,
      cap: BURST_CAP,
      count: events.length,
      triggerIds,
      events,
    });
    console.log(
      `[GH-Poller] burst-digest: ${events.length} events → agent=${agentId} ` +
      `(conv=${convKey}, cap=${BURST_CAP})`,
    );
  }

  // Centralised pending-queue writer. Prefers the orchestrator's queue (which
  // routes to the control plane under volume isolation); otherwise writes the
  // agent's pool file directly. enqueuePending stamps receivedAt, so callers
  // pass the entry without it.
  // `decision`, when passed, is an out-parameter the orchestrator's
  // enqueuePending fills with the admission verdict (`held`, `wipLimit`,
  // `ticketKey`) so the caller can log the TRUE outcome — "held (WIP)" vs
  // "delivered" — instead of assuming delivery. The local-file fallback never
  // runs admission control, so a held verdict is impossible there; `decision`
  // is simply left untouched (its `held` reads falsy).
  _enqueuePending(agentId, entry, decision) {
    if (this.enqueuePending) {
      this.enqueuePending(agentId, entry, decision ? { decision } : undefined);
      return;
    }
    const pendingPath = path.join(AGENTS_DIR, agentId, 'pending-triggers.json');
    let pending = [];
    try {
      if (fs.existsSync(pendingPath)) pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      if (!Array.isArray(pending)) pending = [];
    } catch {}
    pending.push({ receivedAt: new Date().toISOString(), ...entry });
    try {
      fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
    } catch (err) {
      console.error(`[GH-Poller] Cannot write pending for ${agentId}: ${err.message}`);
    }
  }

  // #2151: wakeLabel is the label that actually satisfied this subscriber's
  // labelFilter (or null for an any-label listener) — computed once in
  // _fanOutBatch and carried through here so the entry itself, not just the
  // event-log outcome, records what woke the agent. Stamped only when defined
  // so an old poller (pre-fix) build's undefined argument still produces an
  // entry with no wakeLabel key, matching AC5's in-flight-across-deploy case.
  _enqueue(agentId, triggerId, key, ghEvent, wakeLabel) {
    const entry = {
      triggerId,
      github: {
        event: key,
        eventId: ghEvent.id,
        repo: ghEvent.repo?.name,
        actor: ghEvent.actor?.login,
        createdAt: ghEvent.created_at,
        payload: ghEvent.payload,
      },
    };
    if (wakeLabel !== undefined) entry.wakeLabel = wakeLabel;
    const decision = {};
    this._enqueuePending(agentId, entry, decision);
    if (decision.held) {
      console.log(
        `[GH-Poller] Held ${key} (${ghEvent.id}) → agent=${agentId} trigger=${triggerId} ` +
        `(wipLimit ${decision.wipLimit}${decision.ticketKey ? `, ${decision.ticketKey}` : ''})`,
      );
    } else {
      console.log(`[GH-Poller] Queued ${key} (${ghEvent.id}) → agent=${agentId} trigger=${triggerId}`);
    }
    return decision;
  }

  // #496: best-effort GET of an arbitrary GitHub API resource (used to fetch
  // the PR title the Events API omits — see prApiUrlToHtmlUrl above). Kept
  // separate from _fetchEvents (which is list-shaped and ETag-aware).
  _fetchJson(url, token) {
    return requestWithDeadline(({ resolve, reject }) => {
      let u;
      try {
        u = new URL(url);
      } catch (err) {
        reject(err);
        return;
      }
      // #710: follow the URL's own protocol so enrichment GETs work against a
      // fake-github base served over plain HTTP. Production payload URLs are
      // https://api.github.com/... ⇒ https, unchanged.
      const transport = u.protocol === 'http:' ? require('http') : https;
      const req = transport.request({
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'agent-studio-poller',
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        timeout: 15_000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        // See _fetchEvents — same two handlers, same reason.
        res.on('aborted', () => reject(new Error('response aborted before end')));
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.end();
      return req;
    });
  }

  // #496: fills in the `title`/`html_url` the live Events API omits from
  // `payload.pull_request` for pull_request(_review) events, so
  // _github_event_detail (agent-entrypoint.py) can render "PR #<n>: <title>
  // — <url>" instead of silently falling back to the bare event/repo line.
  // `html_url` is derived from the always-present API `url` (no request);
  // `title` needs one best-effort GET per delivered event — never throws,
  // and leaves the payload untouched (identity) when there's nothing to add
  // or the event isn't PR-shaped, so non-PR events and already-complete
  // payloads (webhook-shaped fixtures, future API changes) pay no cost.
  //
  // #1833 item 3: from that SAME best-effort GET we also read the PR body and
  // derive the issue(s) this PR resolves — `closesIssues` — via the shared
  // parseCloses (closes/fixes/resolves #N in the body + `issue-N` in the head
  // branch), so the event log can show PR→issue traceability. No extra request:
  // the body rides on the title fetch; the branch is already on the payload.
  async _enrichPullRequestPayload(key, payload, token) {
    if (typeof key !== 'string' || !key.startsWith('pull_request')) return payload;
    const pr = payload && payload.pull_request;
    if (!pr || typeof pr !== 'object') return payload;

    let title = pr.title || null;
    let body = typeof pr.body === 'string' ? pr.body : null;
    const branch = pr.head && typeof pr.head.ref === 'string' ? pr.head.ref : null;

    // Fetch the PR detail once, only when the title is missing (the #496
    // condition — an already-complete/webhook-shaped payload still pays no
    // cost). We opportunistically read the body from that response for the
    // closes parse below, so no second request is ever issued.
    if (!title && typeof pr.url === 'string') {
      try {
        const detail = await this._fetchJson(pr.url, token);
        if (detail && typeof detail.title === 'string') title = detail.title;
        if (detail && typeof detail.body === 'string') body = detail.body;
      } catch (err) {
        console.error(`[GH-Poller] PR detail fetch failed for ${pr.url}: ${err.message}`);
      }
    }

    const htmlUrl = pr.html_url || prApiUrlToHtmlUrl(pr.url);
    const closesIssues = parseCloses(body, branch);

    // Only build a new payload for fields we actually add — an already-complete
    // payload with nothing new to contribute stays identity (contract kept).
    const additions = {
      ...(htmlUrl && !pr.html_url ? { html_url: htmlUrl } : {}),
      ...(title && !pr.title ? { title } : {}),
      ...(closesIssues.length ? { closesIssues } : {}),
    };
    if (Object.keys(additions).length === 0) return payload;
    return { ...payload, pull_request: { ...pr, ...additions } };
  }

  _fetchEvents(repoFullName, token, etag, page = 1) {
    return requestWithDeadline(({ resolve, reject }) => {
      const [owner, repo] = repoFullName.split('/');
      const headers = {
        'User-Agent': 'agent-studio-poller',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      };
      // The stored ETag is page 1's; the caller passes it only for page 1 and
      // null for backfill pages (#449).
      if (etag) headers['If-None-Match'] = etag;
      // #710: honour GITHUB_API_BASE (default api.github.com). Absent ⇒ the
      // resolved target is https://api.github.com with an empty path prefix,
      // i.e. byte-identical to the previous hardcoded request.
      const api = resolveGithubApiTarget();
      const req = api.transport.request({
        hostname: api.hostname,
        port: api.port,
        path: `${api.basePath}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/events?per_page=${PER_PAGE}&page=${page}`,
        method: 'GET',
        headers,
        timeout: 15_000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        // A response killed mid-body emits here, never 'end'. Without these two
        // the promise hung forever — and an unhandled 'error' on a
        // stream would take the whole orchestrator down.
        res.on('aborted', () => reject(new Error('response aborted before end')));
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode === 304) {
            resolve({ status: 304, etag: res.headers.etag || etag, events: [] });
            return;
          }
          if (res.statusCode !== 200) {
            const body = Buffer.concat(chunks).toString().slice(0, 200);
            const err = new Error(`HTTP ${res.statusCode}: ${body}`);
            // #2537: structured facts for the repository status view.
            err.status = res.statusCode;
            err.rateLimitRemaining = res.headers['x-ratelimit-remaining'];
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString());
              if (parsed && typeof parsed.message === 'string') err.githubMessage = parsed.message;
            } catch { /* non-JSON body — keep the raw text */ }
            reject(err);
            return;
          }
          try {
            const events = JSON.parse(Buffer.concat(chunks).toString());
            resolve({
              status: 200,
              etag: res.headers.etag || null,
              events: Array.isArray(events) ? events : [],
            });
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.end();
      return req;
    });
  }

  // #2525: arm one wake key from OUTSIDE a poll — the manual "Fire again"
  // re-delivers a dropped wake and must leave the edge dedup exactly as a normal
  // delivery would, so a later duplicate of the same label is still dropped as
  // `wake-already-armed` (AC10). Mutates the same per-repo `armed` object a tick
  // holds a reference to, so an in-flight tick's own save keeps it too. No-op
  // when the edge dedup is switched off (AEE_WAKE_EDGE_DEDUP=0).
  armWake({ repo, triggerId, kind, number, label }) {
    if (!this._wakeEdgeDedup || !repo || !triggerId || !label || number == null) return false;
    const repoState = this.state[repo] || (this.state[repo] = {});
    if (!repoState.armed || typeof repoState.armed !== 'object') repoState.armed = {};
    wakeArmory.arm(repoState.armed, wakeArmory.armedKey({ triggerId, kind, number, label }), Date.now());
    this._saveState();
    return true;
  }

  // #2754: clear every armed key for one wake on one object from OUTSIDE a
  // poll — the Flow Control "Release claim" re-applies a wake on GitHub, and on
  // a PR the Events API delivers no standalone `unlabeled(<wake>)`, so the
  // presence-based disarm never sees the removal (the re-add's snapshot names
  // the wake again). Without this the re-add reads as `wake-already-armed` and
  // nothing wakes. Same per-repo `armed` object a tick holds, like `armWake`.
  // Both kinds: issues and PRs share one number space per repo, and a PR's
  // label events may be keyed either way.
  disarmWake({ repo, number, label }) {
    if (!this._wakeEdgeDedup || !repo || !label || number == null) return false;
    const repoState = this.state[repo];
    if (!repoState || !repoState.armed || typeof repoState.armed !== 'object') return false;
    for (const kind of ['issue', 'pr']) wakeArmory.disarmLabel(repoState.armed, { kind, number, label });
    this._saveState();
    return true;
  }

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
    } catch (err) {
      console.error(`[GH-Poller] Cannot load state: ${err.message}`);
    }
    return {};
  }

  _saveState() {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error(`[GH-Poller] Cannot save state: ${err.message}`);
    }
  }

  // ─── Layer-3 throttle ────────────────────────────────────────────────
  // The state file is a flat map of `<agentId>:<convKey>` → bucket. Buckets
  // older than 2× the window are pruned at load time so the file doesn't
  // grow unbounded as old PRs go quiet.
  _loadThrottleState() {
    try {
      if (!fs.existsSync(THROTTLE_STATE_FILE)) return {};
      const raw = JSON.parse(fs.readFileSync(THROTTLE_STATE_FILE, 'utf8')) || {};
      const buckets = raw.buckets || {};
      const now = Date.now();
      const pruned = {};
      for (const [k, b] of Object.entries(buckets)) {
        if (!b?.windowStart) continue;
        const age = now - new Date(b.windowStart).getTime();
        if (age <= 2 * THROTTLE_WINDOW_MS) pruned[k] = b;
      }
      return pruned;
    } catch (err) {
      console.error(`[GH-Poller] Cannot load throttle state: ${err.message}`);
      return {};
    }
  }

  _saveThrottleState() {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(
        THROTTLE_STATE_FILE,
        JSON.stringify({ buckets: this.throttleBuckets }, null, 2),
      );
    } catch (err) {
      console.error(`[GH-Poller] Cannot save throttle state: ${err.message}`);
    }
  }

  // Increments the bucket for (agent, convKey). Returns:
  //   { drop: bool, justWarned: bool, count, threshold, windowEndsAt }
  // `justWarned` is true exactly once per window — when the count first
  // crosses the threshold — so the agent gets one DM, not one per dropped
  // event.
  _checkAndIncThrottle(agentId, convKey) {
    const k = `${agentId}:${convKey}`;
    const now = Date.now();
    let bucket = this.throttleBuckets[k];
    if (!bucket || now - new Date(bucket.windowStart).getTime() > THROTTLE_WINDOW_MS) {
      bucket = { count: 1, windowStart: new Date(now).toISOString(), warned: false };
      this.throttleBuckets[k] = bucket;
      return {
        drop: false,
        justWarned: false,
        count: 1,
        threshold: THROTTLE_THRESHOLD,
        windowEndsAt: new Date(now + THROTTLE_WINDOW_MS).toISOString(),
      };
    }
    bucket.count++;
    let justWarned = false;
    let drop = false;
    if (bucket.count > THROTTLE_THRESHOLD) {
      drop = true;
      if (!bucket.warned) {
        bucket.warned = true;
        justWarned = true;
      }
    }
    const windowEndsAt = new Date(
      new Date(bucket.windowStart).getTime() + THROTTLE_WINDOW_MS,
    ).toISOString();
    return {
      drop,
      justWarned,
      count: bucket.count,
      threshold: THROTTLE_THRESHOLD,
      windowEndsAt,
    };
  }

  // Append a one-shot warning entry to the agent's pending-triggers.json.
  // The agent-runner picks this up in its drain loop and posts a plain
  // (non-Claude) DM so the user sees a loop has been clamped.
  _enqueueThrottleWarning(agentId, convKey, decision) {
    this._enqueuePending(agentId, {
      kind: 'throttle-warning',
      convKey,
      count: decision.count,
      threshold: decision.threshold,
      windowEndsAt: decision.windowEndsAt,
    });
  }
}

// Does this trigger subscribe to the poller at all? The type/enabled/shape
// gates from the plan builder. Every github-event trigger is poller-delivered:
// the internal transport (and its `transport: 'internal'` exclusion) was
// removed in #2578, so a legacy `transport` field on a trigger is ignored.
function pollerSubscribes(t) {
  if (!t || t.type !== 'github-event' || t.enabled === false) return false;
  if (!t.repo || !Array.isArray(t.events) || t.events.length === 0) return false;
  return true;
}

// The poll plan as a pure function of its inputs (#2537) — the one place that
// decides "is this repository polled, with which token, for whom". The poller's
// tick and the repository status view both call it.
//
//   environments — environment records in listEnvironmentIds() order. The FIRST
//                  environment with a valid `githubTokenId` that lists a repo
//                  supplies its token.
//   agents       — [{ id, config, triggers, triggersMtime }]; config null = stub
//                  agent (allowed through), triggers null = none/unreadable.
//   knowledgeLocations — [{ url, branch }], one per team KB (#2602); each
//                  bucket carries its repo's KB branches as `knowledgeBranches`.
//
// Agent-scoped repositories (`config.agentRepositories`, #2067) are token
// sources too (#2528): they carry no credential of their own by design, so —
// exactly like the agent's HTTPS git push (#2464) — they use the agent's
// Working Environment `githubTokenId`. Environment repositories are mapped
// first, so a repo that is also in an environment keeps that environment's
// token (no change for env repos); among agents, the first by id wins.
//
// Returns Map<repoFullName, { tokenId, envId, subscribers, knowledgeBranches }>. A repo is in the
// plan only when it has a token AND at least one subscriber.
function computePollPlan({ environments = [], agents = [], knowledgeLocations = [], allowNonGithubHost = false } = {}, { onInvalidTokenId } = {}) {
  const repoToToken = new Map();
  const envById = new Map();
  for (const env of environments) {
    if (!env) continue;
    if (env.id && !envById.has(env.id)) envById.set(env.id, env);
    if (!env.githubTokenId) continue;
    if (!isValidTokenId(env.githubTokenId)) {
      if (onInvalidTokenId) onInvalidTokenId(env);
      continue;
    }
    const repos = Array.isArray(env.repositories) ? env.repositories : [];
    for (const r of repos) {
      const fullName = parseRepoFullName(r?.url, { allowNonGithubHost });
      if (!fullName) continue;
      if (!repoToToken.has(fullName)) repoToToken.set(fullName, { tokenId: env.githubTokenId, envId: env.id });
    }
  }
  for (const agent of [...agents].sort((a, b) => String(a?.id).localeCompare(String(b?.id)))) {
    const source = agentScopedTokenSource(agent, envById);
    if (!source) continue;
    for (const r of agent.config.agentRepositories) {
      const fullName = parseRepoFullName(r?.url, { allowNonGithubHost });
      if (!fullName) continue;
      if (!repoToToken.has(fullName)) repoToToken.set(fullName, source);
    }
  }

  // #2602: every team's KB branches per repository — the push-trigger exclusion.
  const kbBranches = knowledgeBranchesByRepo(
    knowledgeLocations, (url) => parseRepoFullName(url, { allowNonGithubHost }),
  );

  const plan = new Map();
  for (const agent of agents) {
    // Skip disabled agents — do not enqueue events for them. The agent's
    // process may have been stopped; enqueueing would only accumulate a
    // backlog that fires in a burst on re-enable.
    if (agent?.config?.enabled === false) continue;
    const triggers = agent?.triggers;
    if (!Array.isArray(triggers)) continue;

    for (const t of triggers) {
      if (!pollerSubscribes(t)) continue;
      const source = repoToToken.get(t.repo);
      if (!source) continue;

      const branchFilter = parseBranchFilter(t.branchFilter);
      let bucket = plan.get(t.repo);
      if (!bucket) {
        bucket = {
          tokenId: source.tokenId, envId: source.envId, subscribers: [],
          knowledgeBranches: kbBranches.get(t.repo) || [],
        };
        plan.set(t.repo, bucket);
      }
      bucket.subscribers.push({
        agentId: agent.id,
        triggerId: t.id,
        events: new Set(t.events),
        // Per-subscriber history horizon: events older than this stamp (minus
        // a grace window, see GRACE_MS) are dropped before any other layer
        // fires, so a freshly-added or just-reactivated agent never reacts to
        // activity that predates it (e.g. PRs already open when the team was
        // set up, or the backlog that accrued while a trigger was disabled).
        // Prefers activatedAt → createdAt → triggers.json mtime (legacy).
        horizon: effectiveHorizon(t, agent.triggersMtime || null),
        // Optional exact-match filter on payload.label.name for *.labeled
        // and *.unlabeled events. Empty / null / undefined = no filter
        // (legacy behavior — fire on any label change). When set, the
        // poller drops events whose label name doesn't match before they
        // ever wake the agent — saves a Claude invocation per unrelated
        // label change.
        labelFilter: (typeof t.labelFilter === 'string' && t.labelFilter.trim()) || null,
        // The trigger's own claim label (#957/#958): the `<wake>:wip` label the
        // claim swap ADDS after this trigger fires. Its own `*.labeled` event
        // must never re-wake the trigger — see the self-claim-label drop in
        // `_fanOutBatch`. null when the trigger declares no claim.
        claimAdd: (t.claim && typeof t.claim.add === 'string' && t.claim.add.trim()) || null,
        // #2571: optional "pushed by agent" producer filter on push triggers
        // (null = any push) and the subscriber's Agent Team it is scoped to.
        pushedBy: pushAttribution.normalizePushedBy(t.pushedBy),
        teamId: pushAttribution.teamOf(agent.config),
        // Optional branch filter for `push` events (#2570): the parsed pattern
        // list, or null for no filter (every branch — legacy behaviour).
        branchFilter: branchFilter.length ? branchFilter : null,
        // #2795: the hand-off's CI / merge-conflict gate (null = wake at once).
        readinessGate: handoffGate.normalizeGate(t.readinessGate),
      });
    }
  }
  return plan;
}

// #2528: the token an agent's agent-scoped repositories are polled with — its
// Working Environment's `githubTokenId`, the same fallback its HTTPS git push
// uses. null when the agent has no such repositories, no environment, or the
// environment has no (valid) token id.
function agentScopedTokenSource(agent, envById) {
  const list = agent?.config?.agentRepositories;
  if (!Array.isArray(list) || list.length === 0) return null;
  const env = agent.config.environmentId ? envById.get(agent.config.environmentId) : null;
  if (!env || !env.githubTokenId || !isValidTokenId(env.githubTokenId)) return null;
  return { tokenId: env.githubTokenId, envId: env.id };
}

// The trimmed token stored under `tokenId`, or null when the id is invalid or
// the file is missing/unreadable/empty.
function readTokenFile(tokenId) {
  if (!isValidTokenId(tokenId)) return null;
  try {
    return fs.readFileSync(path.join(GH_TOKENS_DIR, tokenId), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// #2537: can the poller actually use this token? Mirrors the early returns in
// `_pollRepo` (invalid id, unreadable file, empty file) without ever handing the
// value out.
function tokenFileReadable(tokenId) {
  if (!isValidTokenId(tokenId)) return false;
  try {
    return fs.readFileSync(path.join(GH_TOKENS_DIR, tokenId), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

// #2537: the short, persisted description of a failed poll — HTTP status (null
// for a network error), a one-line message, and whether GitHub was rate
// limiting. GitHub's JSON error body carries a `message`; prefer it over the
// raw "HTTP 401: {...}" text.
function describePollError(err) {
  const status = Number.isInteger(err?.status) ? err.status : null;
  let message = err?.githubMessage || null;
  if (!message) message = String(err?.message || 'unknown error');
  message = message.replace(/\s+/g, ' ').trim().slice(0, 160);
  const rateLimited = status === 429
    || (status === 403 && (err?.rateLimitRemaining === '0' || /rate limit/i.test(message)));
  return { status, message, rateLimited };
}

module.exports = {
  GitHubPoller,
  computePollPlan,
  tokenFileReadable,
  describePollError,
  isValidTokenId,
  pollerSubscribes,
  listensTo,
  parseRepoFullName,
  prApiUrlToHtmlUrl,
  eventKey,
  conversationKey,
  synthesizePrOpenPush,
  expandPrOpenPushes,
  pushHeadKey,
  gcPushHeads,
  PUSH_HEADS_MAX,
  workItemNumber,
  labelFilterMatches,
  isSelfClaimLabel,
  detectMergedPrs,
  effectiveHorizon,
  backfillHorizonStamps,
  passesHorizon,
  selectFreshEvents,
  planBurstHandoffs,
  shouldFetchNextPage,
  THROTTLE_THRESHOLD,
  THROTTLE_WINDOW_MS,
  GRACE_MS,
  SEEN_MAX,
  BURST_CAP,
  PER_PAGE,
  MAX_PAGES,
};
