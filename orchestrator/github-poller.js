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

const POLL_INTERVAL_MS = 30_000;
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

// Accepts SSH (`git@github.com:owner/repo.git`) and HTTPS
// (`https://github.com/owner/repo[.git]`) — anything else returns null and
// is silently ignored (non-GitHub remotes can't be polled).
function parseRepoFullName(url) {
  if (!url) return null;
  let m = String(url).match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = String(url).match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

// Loop protection: extract the originating agent id (if any) from an event.
// Agents stamp their actions via the `gh-as-agent` wrapper:
//   - commits get author email `<agentId>@agents.local`
//   - PR / review / comment bodies get an HTML marker `<!-- agent: <id> -->`
// Returns the agent id if any of those signals match, else null.
//
// Edge case — mixed-author push: if a PushEvent contains commits from
// both an agent and a human, this returns the first agent id found and
// the entire push is filtered. This is intentional: filtering more
// aggressively is safer for loop prevention than letting a partial
// agent-push through. Pure human pushes (no agent commits) are
// unaffected.
const AGENT_MARKER_RE = /<!--\s*agent:\s*([a-zA-Z0-9_.-]+)\s*-->/;
const AGENT_EMAIL_RE = /^([a-zA-Z0-9_.-]+)@agents\.local$/;

function extractOriginAgent(ev) {
  const p = ev?.payload || {};
  for (const body of [p.pull_request?.body, p.review?.body, p.comment?.body, p.issue?.body]) {
    if (typeof body === 'string') {
      const m = body.match(AGENT_MARKER_RE);
      if (m) return m[1];
    }
  }
  if (Array.isArray(p.commits)) {
    for (const c of p.commits) {
      const email = c?.author?.email;
      if (typeof email === 'string') {
        const m = email.match(AGENT_EMAIL_RE);
        if (m) return m[1];
      }
    }
  }
  return null;
}

// Apply the trigger's `from` filter to a candidate event. Returns
// `{ deliver, reason }` — `reason` is for logs only, never user-facing.
//
// Self-loops are blocked unconditionally before any spec applies (there is
// no spec value that re-enables self-routing — by design).
//
// Spec values:
//   undefined | null | 'any-except-self' → default. Allow anything except
//     self-loops. This is the existing pre-`from` behavior.
//   'humans' → only events without an agent origin (no <!-- agent: -->,
//     no <id>@agents.local commit author).
//   'agents' → only events with an agent origin.
//   'team'   → events from a human OR an agent in the same team as the
//     subscriber. Origin and subscriber teams come from each agent's
//     config.json `team` field via the `lookupTeam` callback.
//   ['<id>', ...] → explicit allowlist. The string 'humans' is a special
//     token in the array meaning "humans pass too".
//   { exclude: ['<id>', ...] } → blocklist of agent ids. Humans always pass.
//
// Unknown / malformed specs fail-closed (drop) and surface in logs so a
// typo in triggers.json doesn't silently degrade to "everything passes".
function applyFromFilter(originAgentId, subscriberAgentId, fromSpec, lookupTeam) {
  if (originAgentId && originAgentId === subscriberAgentId) {
    return { deliver: false, reason: 'self-loop' };
  }
  if (!fromSpec || fromSpec === 'any-except-self') {
    return { deliver: true, reason: 'any-except-self' };
  }
  if (fromSpec === 'humans') {
    return originAgentId === null
      ? { deliver: true, reason: 'humans-only:human' }
      : { deliver: false, reason: 'humans-only:agent' };
  }
  if (fromSpec === 'agents') {
    return originAgentId !== null
      ? { deliver: true, reason: 'agents-only:agent' }
      : { deliver: false, reason: 'agents-only:human' };
  }
  if (fromSpec === 'team') {
    if (originAgentId === null) return { deliver: true, reason: 'team:human-passes' };
    const subTeam = lookupTeam ? lookupTeam(subscriberAgentId) : null;
    const origTeam = lookupTeam ? lookupTeam(originAgentId) : null;
    if (!subTeam || !origTeam) {
      return { deliver: false, reason: 'team:no-team-info' };
    }
    return subTeam === origTeam
      ? { deliver: true, reason: 'team:match' }
      : { deliver: false, reason: 'team:mismatch' };
  }
  if (Array.isArray(fromSpec)) {
    if (originAgentId === null) {
      return fromSpec.includes('humans')
        ? { deliver: true, reason: 'allowlist:human-token' }
        : { deliver: false, reason: 'allowlist:human-not-listed' };
    }
    return fromSpec.includes(originAgentId)
      ? { deliver: true, reason: 'allowlist:match' }
      : { deliver: false, reason: 'allowlist:no-match' };
  }
  if (fromSpec && typeof fromSpec === 'object' && Array.isArray(fromSpec.exclude)) {
    if (originAgentId === null) return { deliver: true, reason: 'blocklist:human-passes' };
    return fromSpec.exclude.includes(originAgentId)
      ? { deliver: false, reason: 'blocklist:match' }
      : { deliver: true, reason: 'blocklist:no-match' };
  }
  return { deliver: false, reason: `unknown-spec:${JSON.stringify(fromSpec)}` };
}

// #320-A: the per-subscriber history horizon. Prefer the trigger's activation
// stamp (set on create and refreshed on re-enable), then its creation stamp,
// then the triggers.json mtime as the legacy fallback for triggers authored
// before the stamps existed. Returns an ISO string or null (no horizon known).
function effectiveHorizon(trigger, triggersMtime) {
  return (trigger && (trigger.activatedAt || trigger.createdAt)) || triggersMtime || null;
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
function planBurstHandoffs(deliverables, cap) {
  const CAP = Number.isInteger(cap) && cap >= 0 ? cap : BURST_CAP;
  const groups = new Map();
  const order = [];
  for (const d of Array.isArray(deliverables) ? deliverables : []) {
    if (!d || !d.agentId) continue;
    const convKey = d.convKey ?? null;
    const gkey = `${d.agentId} ${convKey ?? ''}`;
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

class GitHubPoller {
  constructor({ loadEnvironment, listEnvironmentIds, enqueuePending, triggersPath } = {}) {
    this.loadEnvironment = loadEnvironment;
    this.listEnvironmentIds = listEnvironmentIds;
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

  async _tick() {
    if (this.running) return;
    this.running = true;
    try {
      const plan = this._buildPollPlan();
      if (plan.size === 0) return;
      for (const [repoFullName, entry] of plan) {
        await this._pollRepo(repoFullName, entry);
      }
    } catch (err) {
      console.error(`[GH-Poller] Tick error: ${err.message}`);
    } finally {
      this.running = false;
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
      for (const r of repos) {
        const fullName = parseRepoFullName(r?.url);
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
        if (t?.type !== 'github-event' || t.enabled === false) continue;
        if (!t.repo || !Array.isArray(t.events) || t.events.length === 0) continue;
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
          // Layer-2 loop protection: the per-trigger `from` filter. Pass it
          // through unchanged — applyFromFilter() understands all spec shapes
          // (string keyword / array allowlist / { exclude } blocklist / null).
          from: t.from || null,
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
      result = await this._fetchEvents(repoFullName, token, repoState.etag);
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
      repoState.seen = selectFreshEvents(result.events, [], SEEN_MAX).nextSeen;
      delete repoState.lastCreatedAt;
      delete repoState.lastEventId;
      this.state[repoFullName] = repoState;
      this._saveState();
      console.log(`[GH-Poller] ${repoFullName}: baseline established (${repoState.seen.length} event id(s) seen)`);
      return;
    }

    const { fresh, nextSeen } = selectFreshEvents(result.events, repoState.seen, SEEN_MAX);
    repoState.seen = nextSeen;

    if (fresh.length > 0) {
      // GitHub returns newest-first; process oldest-first so triggers fire
      // in causal order. Events without a timestamp sort last (stable).
      fresh.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
      this._fanOutBatch(repoFullName, fresh, subscribers);
    }

    this.state[repoFullName] = repoState;
    this._saveState();
  }

  _fanOutBatch(repoFullName, ghEvents, subscribers) {
    // Cache `team` lookups for the duration of this batch. A burst of events to
    // the same subscribers would otherwise re-read the same config.json files
    // repeatedly. Per-batch (one poll, ~30s) so a late team rename is picked up
    // on the next poll rather than being stuck behind stale data.
    const teamCache = new Map();
    const lookupTeam = (agentId) => {
      if (teamCache.has(agentId)) return teamCache.get(agentId);
      let team = null;
      try {
        const cfg = JSON.parse(
          fs.readFileSync(path.join(AGENTS_DIR, agentId, 'config.json'), 'utf8'),
        );
        if (typeof cfg?.team === 'string' && cfg.team) team = cfg.team;
      } catch { /* missing or unreadable config = no team */ }
      teamCache.set(agentId, team);
      return team;
    };

    // Phase 1 — per-event delivery gates (history horizon, label filter, from
    // filter). Everything that survives becomes a "deliverable" tagged with its
    // subscriber + conversation, to be grouped in phase 2. Events arrive
    // oldest-first (caller sorted), so per-group order stays causal.
    const deliverables = [];
    for (const ghEvent of ghEvents) {
      const key = eventKey(ghEvent);
      if (!key) continue;
      const originAgentId = extractOriginAgent(ghEvent);
      const convKey = conversationKey(ghEvent);

      for (const sub of subscribers) {
        if (!sub.events.has(key)) continue;

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
          continue;
        }

        // Label-name filter for *.labeled / *.unlabeled events. The action
        // payload carries the affected label as `payload.label.name`. When
        // the subscriber pinned a label name, drop everything that doesn't
        // match before any other layer runs — this is the cheap pre-filter
        // that saves the Claude wake-up; the from-filter and throttle still
        // apply afterward. No-op for non-label events.
        if (sub.labelFilter) {
          const labelName = ghEvent.payload?.label?.name;
          if (labelName !== sub.labelFilter) {
            console.log(
              `[GH-Poller] label-filter: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
              `(label='${labelName ?? '?'}', want='${sub.labelFilter}')`,
            );
            continue;
          }
        }

        const decision = applyFromFilter(originAgentId, sub.agentId, sub.from, lookupTeam);
        if (!decision.deliver) {
          if (decision.reason === 'self-loop') {
            // Preserve the existing log line shape so operators with grep
            // habits / log dashboards keep working.
            console.log(
              `[GH-Poller] Loop-protect: ${key} (${ghEvent.id}) origin=${originAgentId} matches subscriber — skipping`,
            );
          } else {
            console.log(
              `[GH-Poller] from-filter: ${key} (${ghEvent.id}) origin=${originAgentId || 'human'} → ${sub.agentId} dropped (${decision.reason})`,
            );
          }
          continue;
        }

        deliverables.push({
          agentId: sub.agentId,
          triggerId: sub.triggerId,
          convKey,
          key,
          ghEvent,
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

    for (const plan of plans) {
      if (plan.mode === 'digest') {
        this._enqueueDigest(plan.agentId, plan.convKey, plan.items);
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
          continue;
        }

        this._enqueue(it.agentId, it.triggerId, it.key, it.ghEvent);
      }
    }

    if (throttleStateDirty) this._saveThrottleState();
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

  _fetchEvents(repoFullName, token, etag) {
    return new Promise((resolve, reject) => {
      const [owner, repo] = repoFullName.split('/');
      const headers = {
        'User-Agent': 'e-vgh-claw-poller',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (etag) headers['If-None-Match'] = etag;
      const req = https.request({
        hostname: 'api.github.com',
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/events?per_page=100`,
        method: 'GET',
        headers,
        timeout: 15_000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
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

module.exports = {
  GitHubPoller,
  parseRepoFullName,
  eventKey,
  conversationKey,
  extractOriginAgent,
  applyFromFilter,
  effectiveHorizon,
  passesHorizon,
  selectFreshEvents,
  planBurstHandoffs,
  THROTTLE_THRESHOLD,
  THROTTLE_WINDOW_MS,
  GRACE_MS,
  SEEN_MAX,
  BURST_CAP,
};
