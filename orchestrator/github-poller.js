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
// at SEEN_MAX), `lastPolledAt`.
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const githubEventLog = require('./github-event-log');
const { parseCloses } = require('./pr-events-log');
const { resolveGithubApiTarget, githubApiBase, DEFAULT_GITHUB_API_BASE } = require('./github-api-base');

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

function eventKey(ev) {
  const base = TYPE_KEY[ev.type] || (ev.type || '').replace(/Event$/, '').toLowerCase();
  if (!base) return null;
  const action = ev.payload?.action;
  return action ? `${base}.${action}` : base;
}

// Conversation key for the Layer-3 throttle: groups events that belong to
// the same logical thread (one PR, one issue, one branch, …). The throttle
// counts events per (agent, conversationKey), not raw events — so legitimate
// activity across many PRs doesn't trip the limit, but a back-and-forth on
// a single PR does.
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
  const fresh = list.filter(e => e && e.id != null && !seen.has(String(e.id)));

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
  constructor({ loadEnvironment, listEnvironmentIds, enqueuePending, triggersPath, onMergedPr } = {}) {
    this.loadEnvironment = loadEnvironment;
    this.listEnvironmentIds = listEnvironmentIds;
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
      }
    } catch (err) {
      console.error(`[GH-Poller] Tick error: ${err.message}`);
    } finally {
      // Only the newest tick may release the guard.
      if (this.tickGeneration === generation) {
        this.running = false;
      }
    }
  }

  // Walks environments → (repo → tokenId), then agents → subscribers per repo.
  // Repos referenced by environments without a (valid) token are skipped —
  // we have no way to authenticate the poll.
  _buildPollPlan() {
    const repoToToken = new Map();
    const envIds = this.listEnvironmentIds();
    for (const envId of envIds) {
      const env = this.loadEnvironment(envId);
      if (!env || !env.githubTokenId) continue;
      if (!isValidTokenId(env.githubTokenId)) {
        console.error(`[GH-Poller] env=${env.id} has invalid githubTokenId '${env.githubTokenId}' — skipping its repos`);
        continue;
      }
      const repos = Array.isArray(env.repositories) ? env.repositories : [];
      const allowNonGithubHost = usingNonDefaultApiBase();
      for (const r of repos) {
        const fullName = parseRepoFullName(r?.url, { allowNonGithubHost });
        if (!fullName) continue;
        if (!repoToToken.has(fullName)) repoToToken.set(fullName, env.githubTokenId);
      }
    }

    const plan = new Map();
    if (!fs.existsSync(AGENTS_DIR)) return plan;
    for (const agentId of fs.readdirSync(AGENTS_DIR)) {
      // Skip disabled agents — do not enqueue events for them. The agent's
      // process may have been stopped; enqueueing would only accumulate a
      // backlog that fires in a burst on re-enable.
      try {
        const agentCfg = JSON.parse(
          fs.readFileSync(path.join(AGENTS_DIR, agentId, 'config.json'), 'utf8'),
        );
        if (agentCfg?.enabled === false) continue;
      } catch { /* no config.json = new/stub agent, allow through */ }

      const triggersPath = this.triggersPath(agentId);
      if (!fs.existsSync(triggersPath)) continue;
      let triggers;
      let triggersMtime = null;
      try {
        triggers = JSON.parse(fs.readFileSync(triggersPath, 'utf8'));
        // mtime is the legacy fallback for the per-trigger history horizon
        // (see `createdAt` below) — pre-existing triggers from before the
        // horizon was introduced have no stamp, but the file's mtime is a
        // reasonable proxy for "when this agent's triggers landed".
        triggersMtime = fs.statSync(triggersPath).mtime.toISOString();
      } catch {
        continue;
      }
      if (!Array.isArray(triggers)) continue;

      for (const t of triggers) {
        if (!pollerSubscribes(t)) continue;
        const tokenId = repoToToken.get(t.repo);
        if (!tokenId) continue;

        let bucket = plan.get(t.repo);
        if (!bucket) {
          bucket = { tokenId, subscribers: [] };
          plan.set(t.repo, bucket);
        }
        bucket.subscribers.push({
          agentId,
          triggerId: t.id,
          events: new Set(t.events),
          // Per-subscriber history horizon: events older than this stamp (minus
          // a grace window, see GRACE_MS) are dropped before any other layer
          // fires, so a freshly-added or just-reactivated agent never reacts to
          // activity that predates it (e.g. PRs already open when the team was
          // set up, or the backlog that accrued while a trigger was disabled).
          // Prefers activatedAt → createdAt → triggers.json mtime (legacy).
          horizon: effectiveHorizon(t, triggersMtime),
          // Optional exact-match filter on payload.label.name for *.labeled
          // and *.unlabeled events. Empty / null / undefined = no filter
          // (legacy behavior — fire on any label change). When set, the
          // poller drops events whose label name doesn't match before they
          // ever wake the agent — saves a Claude invocation per unrelated
          // label change.
          labelFilter: (typeof t.labelFilter === 'string' && t.labelFilter.trim()) || null,
        });
      }
    }
    return plan;
  }

  async _pollRepo(repoFullName, { tokenId, subscribers }) {
    const repoState = this.state[repoFullName] || {};

    // Honor a previously set backoff: skip silently until skipUntil passes.
    if (repoState.skipUntil && new Date(repoState.skipUntil).getTime() > Date.now()) {
      return;
    }

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
      // GitHub returns newest-first; process oldest-first so triggers fire
      // in causal order. Events without a timestamp sort last (stable).
      fresh.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
      await this._fanOutBatch(repoFullName, fresh, subscribers, token);
      await this._handleMergedPrs(repoFullName, fresh);
    }

    this.state[repoFullName] = repoState;
    this._saveState();
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

  async _fanOutBatch(repoFullName, ghEvents, subscribers, token) {
    // Phase 1 — per-event delivery gates (history horizon, label filter).
    // Everything that survives becomes a "deliverable" tagged with its
    // subscriber + conversation, to be grouped in phase 2. Events arrive
    // oldest-first (caller sorted), so per-group order stays causal.
    //
    // There is deliberately NO source/origin filtering here: a trigger fires on
    // any matching event regardless of who caused it (human, another agent, or
    // the subscriber itself). The only backstop against a self-triggering loop
    // is the frequency-based Layer-3 throttle + burst digest in phase 2.
    //
    // `eventLogEntries` (#469) accumulates one entry per event for the
    // event-transparency log, keyed by event id — populated here with the
    // per-subscriber gate outcomes, then finalised with phase 2's digest/
    // throttle/delivered outcomes below, and written out once at the end.
    // A subscriber that doesn't listen to this event type at all (`!sub.events.has(key)`)
    // is NOT recorded as an outcome — that's the "no one is listening" case
    // (AC #4), distinct from "someone listened but a gate dropped it" (AC #3).
    const deliverables = [];
    const eventLogEntries = new Map();
    for (const ghEvent of ghEvents) {
      const key = eventKey(ghEvent);
      const logEntry = { ghEvent, key, outcomes: [] };
      eventLogEntries.set(ghEvent.id, logEntry);
      if (!key) continue;
      const convKey = conversationKey(ghEvent);

      for (const sub of subscribers) {
        if (!sub.events.has(key)) continue;

        const outcome = { agentId: sub.agentId, triggerId: sub.triggerId, status: 'pending', reason: null, digest: false };
        logEntry.outcomes.push(outcome);

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

        this._enqueue(it.agentId, it.triggerId, it.key, ghEvent);
        it.outcome.status = 'delivered';
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
          outcomes: entry.outcomes.map(({ agentId, triggerId, status, reason, digest }) => ({
            agentId, triggerId, status, reason, digest,
          })),
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
  _enqueuePending(agentId, entry) {
    if (this.enqueuePending) { this.enqueuePending(agentId, entry); return; }
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

  _enqueue(agentId, triggerId, key, ghEvent) {
    this._enqueuePending(agentId, {
      triggerId,
      github: {
        event: key,
        eventId: ghEvent.id,
        repo: ghEvent.repo?.name,
        actor: ghEvent.actor?.login,
        createdAt: ghEvent.created_at,
        payload: ghEvent.payload,
      },
    });
    console.log(`[GH-Poller] Queued ${key} (${ghEvent.id}) → agent=${agentId} trigger=${triggerId}`);
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
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
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
// gates from the plan builder, plus the internal-channel exclusion (#1173):
// a `transport: 'internal'` listener is delivered by POST /internal/flow-emit,
// never by the poller. Keeping it out of the plan is the SINGLE dedup
// mechanism of the internal-channels design — the mirror-stamped label the
// emit leaves on GitHub is decoration only precisely because no subscriber
// here can react to it (docs/internal-channels-concept.md §4.3).
function pollerSubscribes(t) {
  if (!t || t.type !== 'github-event' || t.enabled === false) return false;
  if (t.transport === 'internal') return false;
  if (!t.repo || !Array.isArray(t.events) || t.events.length === 0) return false;
  return true;
}

module.exports = {
  GitHubPoller,
  pollerSubscribes,
  parseRepoFullName,
  prApiUrlToHtmlUrl,
  eventKey,
  conversationKey,
  labelFilterMatches,
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
