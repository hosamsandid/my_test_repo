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
//   3. Filters fresh events by id > lastEventId, fans them out by writing
//      to each subscriber's pending-triggers.json — same queue HTTP triggers
//      use, so the agent-runner picks them up via its existing 5s drain.
//
// State (`state.json`) holds per-repo `etag`, `lastEventId`, `lastPolledAt`.
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
          // Per-subscriber history horizon: events with `created_at` strictly
          // older than this stamp are dropped before any other layer fires,
          // so a freshly-added agent never reacts to activity that predates
          // it (e.g. PRs that were already open when the team was set up).
          // Falls back to the triggers.json mtime for legacy triggers.
          createdAt: t.createdAt || triggersMtime,
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

    // Cursor is the `created_at` of the newest event seen. We don't use
    // event ids because GitHub event ids are not globally monotonic across
    // event types — PullRequestEvent ids are in a completely different
    // numeric range from PushEvent / CreateEvent ids, so a BigInt compare
    // would systematically misclassify some types as "already seen".
    // Legacy state files with `lastEventId` are ignored — the next poll
    // re-baselines from `created_at`.
    if (!repoState.lastCreatedAt) {
      const newestCreatedAt = result.events
        .map(e => e.created_at)
        .filter(Boolean)
        .sort()
        .pop();
      repoState.lastCreatedAt = newestCreatedAt || new Date().toISOString();
      delete repoState.lastEventId;
      this.state[repoFullName] = repoState;
      this._saveState();
      console.log(`[GH-Poller] ${repoFullName}: baseline established (created_at=${repoState.lastCreatedAt})`);
      return;
    }

    const cursor = repoState.lastCreatedAt;
    const fresh = [];
    let newestCreatedAt = cursor;
    for (const ev of result.events) {
      if (!ev.created_at) continue;
      if (ev.created_at > cursor) fresh.push(ev);
      if (ev.created_at > newestCreatedAt) newestCreatedAt = ev.created_at;
    }

    if (fresh.length > 0) {
      // GitHub returns newest-first; process oldest-first so triggers fire
      // in causal order.
      fresh.sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const ev of fresh) {
        this._fanOut(repoFullName, ev, subscribers);
      }
      repoState.lastCreatedAt = newestCreatedAt;
    }

    this.state[repoFullName] = repoState;
    this._saveState();
  }

  _fanOut(repoFullName, ghEvent, subscribers) {
    const key = eventKey(ghEvent);
    if (!key) return;
    const originAgentId = extractOriginAgent(ghEvent);

    // Cache `team` lookups for the duration of this fan-out call. A burst of
    // events to the same subscribers would otherwise re-read the same
    // config.json files repeatedly. The cache is intentionally per-call so
    // late team renames don't get stuck behind stale data — the next event
    // re-reads.
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

    const convKey = conversationKey(ghEvent);
    let throttleStateDirty = false;

    for (const sub of subscribers) {
      if (!sub.events.has(key)) continue;

      // History horizon: skip events older than the subscriber's createdAt.
      // Cheapest check, runs before everything else — a brand-new agent
      // never reads (let alone reacts to) activity that pre-dates its own
      // creation, even when the per-repo cursor is stale (e.g. another
      // agent already advanced it past those events). String compare on
      // ISO-8601 UTC timestamps is correct.
      if (sub.createdAt && ghEvent.created_at && ghEvent.created_at < sub.createdAt) {
        console.log(
          `[GH-Poller] history-horizon: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
          `(event=${ghEvent.created_at}, sub-since=${sub.createdAt})`,
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

      // Layer-3 throttle: count per (agent, conversation). Drops further
      // reactions once the threshold is exceeded; the very first drop also
      // schedules a one-shot DM warning so the user sees the clamp.
      const t = this._checkAndIncThrottle(sub.agentId, convKey);
      throttleStateDirty = true;
      if (t.drop) {
        console.log(
          `[GH-Poller] throttle: ${key} (${ghEvent.id}) → ${sub.agentId} dropped ` +
          `(conv=${convKey}, count=${t.count}/${t.threshold}/h, window-ends=${t.windowEndsAt})`,
        );
        if (t.justWarned) {
          this._enqueueThrottleWarning(sub.agentId, convKey, t);
          console.log(
            `[GH-Poller] throttle: warning queued for ${sub.agentId} (conv=${convKey})`,
          );
        }
        continue;
      }

      this._enqueue(sub.agentId, sub.triggerId, key, ghEvent);
    }

    if (throttleStateDirty) this._saveThrottleState();
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
  THROTTLE_THRESHOLD,
  THROTTLE_WINDOW_MS,
};
