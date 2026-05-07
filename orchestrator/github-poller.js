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
const AGENTS_DIR = '/workspace/agents';
const ENVIRONMENTS_DIR = '/workspace/environments';
const GH_TOKENS_DIR = path.join(ENVIRONMENTS_DIR, '_tokens');

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

class GitHubPoller {
  constructor({ loadEnvironment, listEnvironmentIds }) {
    this.loadEnvironment = loadEnvironment;
    this.listEnvironmentIds = listEnvironmentIds;
    this.state = this._loadState();
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
      const triggersPath = path.join(AGENTS_DIR, agentId, 'triggers.json');
      if (!fs.existsSync(triggersPath)) continue;
      let triggers;
      try {
        triggers = JSON.parse(fs.readFileSync(triggersPath, 'utf8'));
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
    for (const sub of subscribers) {
      if (!sub.events.has(key)) continue;
      if (originAgentId && originAgentId === sub.agentId) {
        // Self-action — skip to break loops (e.g. reviewer agent
        // reacting to its own review-comment, push-watcher reacting to
        // its own commit). Author/marker is set by the gh-as-agent
        // wrapper; agents that bypass the wrapper lose this protection.
        console.log(
          `[GH-Poller] Loop-protect: ${key} (${ghEvent.id}) origin=${originAgentId} matches subscriber — skipping`,
        );
        continue;
      }
      this._enqueue(sub.agentId, sub.triggerId, key, ghEvent);
    }
  }

  _enqueue(agentId, triggerId, key, ghEvent) {
    const pendingPath = path.join(AGENTS_DIR, agentId, 'pending-triggers.json');
    let pending = [];
    try {
      if (fs.existsSync(pendingPath)) pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      if (!Array.isArray(pending)) pending = [];
    } catch {}
    pending.push({
      triggerId,
      receivedAt: new Date().toISOString(),
      github: {
        event: key,
        eventId: ghEvent.id,
        repo: ghEvent.repo?.name,
        actor: ghEvent.actor?.login,
        createdAt: ghEvent.created_at,
        payload: ghEvent.payload,
      },
    });
    try {
      fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
      console.log(`[GH-Poller] Queued ${key} (${ghEvent.id}) → agent=${agentId} trigger=${triggerId}`);
    } catch (err) {
      console.error(`[GH-Poller] Cannot write pending for ${agentId}: ${err.message}`);
    }
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
}

module.exports = { GitHubPoller, parseRepoFullName, eventKey, extractOriginAgent };
