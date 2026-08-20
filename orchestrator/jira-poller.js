'use strict';

// ============================================================
// Jira status-change poller
// ------------------------------------------------------------
// See docs/jira-integration-concept.md for the full design rationale.
// Polls Jira Cloud's enhanced JQL search for every project referenced by a
// `jira-event` trigger, resolving each subscriber's project key against its
// OWN agent's environment (env.jiraProjects), never a global cross-
// environment map — a Jira project key is only unique per site, so the same
// key bound to two different sites must never be conflated.
//
// Unlike GitHub, Jira Cloud has no discrete immutable events feed. Instead:
//   1. Per tracked project, run a JQL search scoped to a narrow recent
//      window (`updated >= -Nm`) with `expand: 'changelog'`.
//   2. Each returned issue's changelog histories carry a stable `id`; every
//      history item with `field === 'status'` becomes a candidate event
//      keyed `<issueKey>:<historyId>` — playing the exact role GitHub's
//      `event.id` plays in the shared seen-id dedup (selectFreshEvents).
//   3. Atlassian truncates a search response's changelog for issues with
//      heavy history — detected via `changelog.total > histories.length`
//      and backfilled with the paginated per-issue changelog endpoint.
//
// State (`state.json`) holds per-project (`<siteUrl>::<projectKey>`) `seen`
// (event-id set, capped at SEEN_MAX) and `lastPolledAt`. Fan-out (history
// horizon, statusFilter gate, Layer-3 throttle, burst-cap digest) reuses the
// same pure primitives as the GitHub poller via ./event-poller-shared.
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const {
  SEEN_MAX,
  BURST_CAP,
  THROTTLE_WINDOW_MS,
  THROTTLE_THRESHOLD,
  GRACE_MS,
  computeBackoffDelayMs,
  effectiveHorizon,
  passesHorizon,
  selectFreshEvents,
  planBurstHandoffs,
  loadThrottleState,
  saveThrottleState,
  checkAndIncThrottle,
} = require('./event-poller-shared');

// Poll cadence. Jira Cloud's search index has its own eventual-consistency
// lag, so polling faster than GitHub's 30s buys nothing — 60s default,
// overridable for the E2E stack.
const POLL_INTERVAL_MS = (() => {
  const raw = Number(process.env.AEE_JIRA_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

// JQL `updated >= -Nm` window. Generous overlap by design — like the GitHub
// poller's seen-id cursor, freshness is decided purely by seen-id membership,
// never by this window boundary, so re-fetching an overlapping range every
// poll is harmless. Defaults to twice the poll interval, floored at 5m.
const POLL_WINDOW_MINUTES = (() => {
  const raw = Number(process.env.AEE_JIRA_POLL_WINDOW_MINUTES);
  if (Number.isFinite(raw) && raw > 0) return Math.ceil(raw);
  return Math.max(5, Math.ceil((POLL_INTERVAL_MS / 60_000) * 2));
})();

// Upper bound on how far a widened catch-up window (below) may reach back,
// so a genuinely long outage produces one generous-but-bounded query instead
// of an unbounded one.
const MAX_CATCHUP_MINUTES = 24 * 60;

// The fixed POLL_WINDOW_MINUTES alone silently drops any status transition
// that happened while the orchestrator was down longer than the window: the
// JQL `updated >= -Nm` clause excludes an issue from the search entirely
// once it falls outside it, so an issue untouched since the transition never
// resurfaces — not even via the changelog-truncation fallback, which only
// runs on issues the search already returned. Widen the window to cover the
// actual gap since the last successful poll, capped at MAX_CATCHUP_MINUTES.
// Pure — unit-tested.
function computeQueryWindowMinutes(lastPolledAt, baseWindowMinutes = POLL_WINDOW_MINUTES, maxCatchupMinutes = MAX_CATCHUP_MINUTES) {
  if (!lastPolledAt) return baseWindowMinutes;
  const lastMs = new Date(lastPolledAt).getTime();
  if (!Number.isFinite(lastMs)) return baseWindowMinutes;
  const elapsedMinutes = Math.ceil((Date.now() - lastMs) / 60_000);
  if (elapsedMinutes <= baseWindowMinutes) return baseWindowMinutes;
  return Math.min(elapsedMinutes, maxCatchupMinutes);
}

const STATE_DIR = '/workspace/jira-poller';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const THROTTLE_STATE_FILE = path.join(STATE_DIR, 'throttle-state.json');
const AGENTS_DIR = '/workspace/agents';
const ENVIRONMENTS_DIR = '/workspace/environments';
const JIRA_TOKENS_DIR = path.join(ENVIRONMENTS_DIR, '_jira-tokens');

// One JQL search page is 100 issues; this caps total issues considered for a
// single project in a single poll (100 * 20 = 2000) — generous enough that a
// legitimate result never gets cut short, cheap enough to never spiral.
const MAX_PAGES = 20;

// credentialId is operator-supplied via a Working Environment's jiraProjects
// binding, but a rogue or typo'd value would otherwise resolve outside
// JIRA_TOKENS_DIR via path.join. Same charset used elsewhere for ids.
function isValidCredentialId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length < 64
    && !id.includes('..')
    && /^[a-zA-Z0-9_.-]+$/.test(id);
}

// Accepts a bare Atlassian subdomain ("yourcompany") or a full origin
// ("https://yourcompany.atlassian.net", or a custom domain / test fixture
// host) — whichever form the credential's siteUrl was stored in.
function resolveJiraApiBase(siteUrl) {
  const trimmed = String(siteUrl || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed}.atlassian.net`;
}

// Atlassian truncates a search response's changelog for issues with heavy
// change history — exactly the "bulk sprint transition" case this
// integration most needs to catch reliably, so it can't be ignored.
function isChangelogTruncated(changelog) {
  return !!changelog
    && typeof changelog.total === 'number'
    && Array.isArray(changelog.histories)
    && changelog.total > changelog.histories.length;
}

// Pure: resolves a subscriber's projectKey against ITS OWN environment's
// jiraProjects[] binding (never a global cross-environment map — see the
// module header). Returns null when the project isn't bound, or its
// credential can't be resolved to a usable {siteUrl, email} pair; otherwise
// the poll-plan bucket key ingredients, including the composite `projectRef`
// (`<siteUrl>::<projectKey>`) that makes the same project key on two
// different Jira sites unambiguous.
function resolveProjectCredential(envProjects, projectKey, loadJiraCredential) {
  const list = Array.isArray(envProjects) ? envProjects : [];
  const binding = list.find(p => p?.projectKey === projectKey);
  if (!binding || !binding.credentialId) return null;
  const cred = loadJiraCredential(binding.credentialId);
  if (!cred || !isValidCredentialId(cred.id) || !cred.siteUrl || !cred.email) return null;
  return {
    credentialId: binding.credentialId,
    siteUrl: cred.siteUrl,
    email: cred.email,
    projectRef: `${cred.siteUrl}::${projectKey}`,
  };
}

// Pure: the statusFilter exact-match gate, mirroring the GitHub poller's
// labelFilter semantics. Empty/null/undefined = no filter (fires on any
// status change).
function matchesStatusFilter(toStatus, statusFilter) {
  if (!statusFilter) return true;
  return toStatus === statusFilter;
}

// Pure: a jira-event trigger's `events` field is kept for forward-compat
// (v1 only implements `'status_changed'` — see docs/jira-integration-concept.md)
// — mirrors github-event's type filtering so the field isn't silently
// ignored. Absent/empty `events` subscribes to everything (today, the one
// event this poller ever emits); a non-empty list must actually name it.
function subscribesToStatusChanged(events) {
  if (!Array.isArray(events) || events.length === 0) return true;
  return events.includes('status_changed');
}

// Pure: flattens an issue's (possibly backfilled) changelog histories into
// one candidate event per status-field change. `id` is the composite
// `<issueKey>:<historyId>` that plays GitHub event.id's exact role in the
// shared seen-id dedup (selectFreshEvents).
function extractStatusChangeEvents(issue, { projectKey, siteBase }) {
  const histories = (issue && issue.changelog && Array.isArray(issue.changelog.histories))
    ? issue.changelog.histories : [];
  const events = [];
  if (!issue || !issue.key) return events;
  for (const h of histories) {
    if (!h || h.id == null || !Array.isArray(h.items)) continue;
    for (const item of h.items) {
      if (!item || item.field !== 'status') continue;
      events.push({
        id: `${issue.key}:${h.id}`,
        issueKey: issue.key,
        projectKey,
        created: h.created || null,
        author: (h.author && h.author.displayName) || null,
        fromStatus: item.fromString || null,
        toStatus: item.toString || null,
        summary: (issue.fields && issue.fields.summary) || null,
        issueUrl: siteBase ? `${siteBase}/browse/${issue.key}` : null,
      });
    }
  }
  return events;
}

// Minimal JSON request helper (Basic auth), used for both the JQL search and
// the per-issue changelog backfill. `origin` is a full "https://host[:port]"
// base; `reqPath` is joined against it.
function requestJson({ origin, reqPath, method = 'GET', authHeader, body }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(reqPath, origin);
    } catch (err) {
      reject(err);
      return;
    }
    const transport = u.protocol === 'http:' ? http : https;
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Accept': 'application/json',
      'Authorization': authHeader,
      'User-Agent': 'e-vgh-claw-jira-poller',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = transport.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method,
      headers,
      timeout: 15_000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const bodyText = Buffer.concat(chunks).toString().slice(0, 300);
          reject(new Error(`HTTP ${res.statusCode}: ${bodyText}`));
          return;
        }
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// One page of the enhanced JQL search (POST /search/jql). Returns
// { issues, isLast, nextPageToken }.
//
// `expand` must be a comma-separated STRING here, not the JSON array every
// other v3 endpoint accepts (`fields` above is still a real array) — this
// newer endpoint 400s ("Invalid request payload", no further detail) on an
// array `expand`, confirmed empirically against a live site. Verified fixed
// with the string form; keep it that way even though it looks inconsistent
// next to `fields`.
function searchIssuesPage({ origin, authHeader, jql, nextPageToken }) {
  const body = {
    jql,
    fields: ['summary', 'status'],
    expand: 'changelog',
    maxResults: 100,
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  return requestJson({ origin, reqPath: '/rest/api/3/search/jql', method: 'POST', authHeader, body });
}

// Full, paginated changelog for one issue — only called for issues whose
// search-response changelog was truncated (rare, bounded to just those
// issues).
async function fetchFullChangelog({ origin, authHeader, issueKey }) {
  const histories = [];
  let startAt = 0;
  const maxResults = 100;
  for (;;) {
    const page = await requestJson({
      origin,
      authHeader,
      method: 'GET',
      reqPath: `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?startAt=${startAt}&maxResults=${maxResults}`,
    });
    const values = Array.isArray(page.values) ? page.values : [];
    histories.push(...values);
    startAt += values.length;
    if (page.isLast || values.length === 0 || (typeof page.total === 'number' && startAt >= page.total)) break;
  }
  return histories;
}

class JiraPoller {
  constructor({ loadEnvironment, loadJiraCredential, enqueuePending, triggersPath } = {}) {
    this.loadEnvironment = loadEnvironment;
    this.loadJiraCredential = loadJiraCredential;
    // #185-style: the orchestrator owns the pending queue (control-plane
    // aware). Falls back to writing the agent's pool file directly when not
    // injected (unit tests).
    this.enqueuePending = enqueuePending || null;
    this.triggersPath = triggersPath || ((agentId) => path.join(AGENTS_DIR, agentId, 'triggers.json'));
    this.state = this._loadState();
    this.throttleBuckets = loadThrottleState(THROTTLE_STATE_FILE, THROTTLE_WINDOW_MS);
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    console.log(`[Jira-Poller] Starting (interval=${Math.round(POLL_INTERVAL_MS / 1000)}s, window=${POLL_WINDOW_MINUTES}m)`);
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
      for (const [projectRef, entry] of plan) {
        await this._pollProject(projectRef, entry);
      }
    } catch (err) {
      console.error(`[Jira-Poller] Tick error: ${err.message}`);
    } finally {
      this.running = false;
    }
  }

  // Walks agents (NOT a global project→credential map — see the module
  // header): for each enabled agent with a jira-event trigger, resolves the
  // trigger's projectKey against THAT AGENT's OWN environment's
  // jiraProjects[] binding. This is what makes a same-named project key on
  // two different Jira sites unambiguous — there is no cross-environment
  // resolution the way GitHub's repoToToken map does it.
  _buildPollPlan() {
    const plan = new Map();
    if (!fs.existsSync(AGENTS_DIR)) return plan;
    for (const agentId of fs.readdirSync(AGENTS_DIR)) {
      let agentCfg = null;
      try {
        agentCfg = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, agentId, 'config.json'), 'utf8'));
        if (agentCfg?.enabled === false) continue;
      } catch { /* no config.json = new/stub agent, allow through */ }

      const env = agentCfg?.environmentId ? this.loadEnvironment(agentCfg.environmentId) : null;
      const envProjects = Array.isArray(env?.jiraProjects) ? env.jiraProjects : [];
      if (envProjects.length === 0) continue;

      const triggersPath = this.triggersPath(agentId);
      if (!fs.existsSync(triggersPath)) continue;
      let triggers;
      let triggersMtime = null;
      try {
        triggers = JSON.parse(fs.readFileSync(triggersPath, 'utf8'));
        triggersMtime = fs.statSync(triggersPath).mtime.toISOString();
      } catch {
        continue;
      }
      if (!Array.isArray(triggers)) continue;

      for (const t of triggers) {
        if (t?.type !== 'jira-event' || t.enabled === false) continue;
        if (!subscribesToStatusChanged(t.events)) continue;
        const projectKey = typeof t.projectKey === 'string' ? t.projectKey.trim() : '';
        if (!projectKey) continue;

        const resolved = resolveProjectCredential(envProjects, projectKey, this.loadJiraCredential);
        if (!resolved) continue;

        let bucket = plan.get(resolved.projectRef);
        if (!bucket) {
          // First-write-wins per projectRef, mirroring the GitHub poller's
          // repoToToken posture for the edge case of two environments
          // binding the same site+project to two different credentials.
          bucket = { credentialId: resolved.credentialId, siteUrl: resolved.siteUrl, email: resolved.email, projectKey, subscribers: [] };
          plan.set(resolved.projectRef, bucket);
        }
        bucket.subscribers.push({
          agentId,
          triggerId: t.id,
          horizon: effectiveHorizon(t, triggersMtime),
          // Exact-match gate on the status the issue transitioned INTO,
          // mirroring the GitHub poller's labelFilter semantics. Empty/null =
          // no filter (fires on any status change).
          statusFilter: (typeof t.statusFilter === 'string' && t.statusFilter.trim()) || null,
        });
      }
    }
    return plan;
  }

  async _pollProject(projectRef, { credentialId, siteUrl, email, projectKey, subscribers }) {
    const projectState = this.state[projectRef] || {};

    if (projectState.skipUntil && new Date(projectState.skipUntil).getTime() > Date.now()) {
      return;
    }

    if (!isValidCredentialId(credentialId)) {
      console.error(`[Jira-Poller] ${projectRef}: invalid credentialId '${credentialId}' — skipping`);
      return;
    }
    let token;
    try {
      token = fs.readFileSync(path.join(JIRA_TOKENS_DIR, credentialId), 'utf8').trim();
    } catch (err) {
      console.error(`[Jira-Poller] Cannot read credential ${credentialId}: ${err.message}`);
      return;
    }
    if (!token) return;

    const siteBase = resolveJiraApiBase(siteUrl);
    const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    // Escape backslashes before quotes — reversing the order would let a
    // trailing backslash swallow the closing escaped quote and break out of
    // the JQL string literal. The env-level JIRA_PROJECT_KEY_RE already
    // restricts projectKey to `^[A-Za-z][A-Za-z0-9_]*$`, but this line is the
    // defense-in-depth layer and should hold on its own.
    const escapedProjectKey = projectKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const windowMinutes = computeQueryWindowMinutes(projectState.lastPolledAt);
    const jql = `project = "${escapedProjectKey}" AND updated >= -${windowMinutes}m ORDER BY updated ASC`;

    let issues;
    try {
      issues = await this._fetchAllIssues(siteBase, authHeader, jql);
    } catch (err) {
      // Same exponential backoff shape as the GitHub poller (expired
      // credential, deleted project, network outage) — capped at 30m so a
      // once-flaky credential recovers within at most one work-break.
      const failures = (projectState.consecutiveFailures || 0) + 1;
      const delayMs = computeBackoffDelayMs(failures);
      projectState.consecutiveFailures = failures;
      projectState.skipUntil = new Date(Date.now() + delayMs).toISOString();
      this.state[projectRef] = projectState;
      this._saveState();
      const minutes = Math.round(delayMs / 60_000);
      console.error(
        `[Jira-Poller] ${projectRef}: ${err.message} (consecutive failures: ${failures}, next poll in ~${minutes}m)`,
      );
      return;
    }

    if (projectState.consecutiveFailures) {
      console.log(`[Jira-Poller] ${projectRef}: recovered after ${projectState.consecutiveFailures} consecutive failure(s)`);
      delete projectState.consecutiveFailures;
      delete projectState.skipUntil;
    }
    projectState.lastPolledAt = new Date().toISOString();

    const events = [];
    for (const issue of issues) {
      let changelog = issue.changelog;
      if (isChangelogTruncated(changelog)) {
        try {
          const histories = await fetchFullChangelog({ origin: siteBase, authHeader, issueKey: issue.key });
          changelog = { ...changelog, histories };
        } catch (err) {
          console.error(`[Jira-Poller] ${issue.key}: full changelog fetch failed (${err.message}) — using truncated changelog`);
        }
      }
      events.push(...extractStatusChangeEvents({ ...issue, changelog }, { projectKey, siteBase }));
    }

    if (!Array.isArray(projectState.seen)) {
      // First poll for this project — record a baseline, don't fire. Unlike
      // GitHub's Events API (which returns recent history regardless of any
      // subscriber), the JQL window here is narrow (a few minutes) and only
      // ever polled once a subscriber exists, so there's no unbounded
      // backlog to guard against — this just avoids reacting to whatever
      // happens to be in-window at the moment polling starts.
      projectState.seen = selectFreshEvents(events, [], SEEN_MAX).nextSeen;
      this.state[projectRef] = projectState;
      this._saveState();
      console.log(`[Jira-Poller] ${projectRef}: baseline established (${projectState.seen.length} event id(s) seen)`);
      return;
    }

    const { fresh, nextSeen } = selectFreshEvents(events, projectState.seen, SEEN_MAX);
    projectState.seen = nextSeen;

    if (fresh.length > 0) {
      fresh.sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')));
      await this._fanOutBatch(fresh, subscribers);
    }

    this.state[projectRef] = projectState;
    this._saveState();
  }

  async _fetchAllIssues(origin, authHeader, jql) {
    const issues = [];
    let nextPageToken;
    let page = 0;
    for (;;) {
      page += 1;
      const result = await searchIssuesPage({ origin, authHeader, jql, nextPageToken });
      const pageIssues = Array.isArray(result.issues) ? result.issues : [];
      issues.push(...pageIssues);
      // `isLast` is optional per Jira's docs — only stop early on an
      // explicit `true`. Otherwise `nextPageToken` presence is the real
      // pagination signal; an omitted `isLast` must not be read as "done"
      // or every project silently caps at page 1 (100 issues).
      if (result.isLast === true || !result.nextPageToken || page >= MAX_PAGES) break;
      nextPageToken = result.nextPageToken;
    }
    return issues;
  }

  // Gates each fresh event per subscriber (history horizon, statusFilter),
  // then groups by (agent, issue) and hands off via the shared burst-cap
  // digest / Layer-3 throttle — same posture as the GitHub poller's
  // _fanOutBatch, minus PR-payload enrichment and the event-transparency log
  // (no Jira analogue yet).
  async _fanOutBatch(events, subscribers) {
    const deliverables = [];
    for (const ev of events) {
      const convKey = `issue:${ev.issueKey}`;
      for (const sub of subscribers) {
        if (!passesHorizon(ev.created, sub.horizon, GRACE_MS)) {
          console.log(
            `[Jira-Poller] history-horizon: status_changed (${ev.id}) → ${sub.agentId} dropped ` +
            `(event=${ev.created}, sub-since=${sub.horizon}, grace=${GRACE_MS}ms)`,
          );
          continue;
        }
        if (!matchesStatusFilter(ev.toStatus, sub.statusFilter)) {
          console.log(
            `[Jira-Poller] status-filter: status_changed (${ev.id}) → ${sub.agentId} dropped ` +
            `(toStatus='${ev.toStatus ?? '?'}', want='${sub.statusFilter}')`,
          );
          continue;
        }
        deliverables.push({ agentId: sub.agentId, triggerId: sub.triggerId, convKey, event: ev });
      }
    }

    const plans = planBurstHandoffs(deliverables, BURST_CAP);
    let throttleStateDirty = false;

    for (const plan of plans) {
      if (plan.mode === 'digest') {
        this._enqueueDigest(plan.agentId, plan.convKey, plan.items);
        continue;
      }
      for (const it of plan.items) {
        const t = checkAndIncThrottle(this.throttleBuckets, `${it.agentId}:${it.convKey}`, {
          windowMs: THROTTLE_WINDOW_MS,
          threshold: THROTTLE_THRESHOLD,
        });
        throttleStateDirty = true;
        if (t.drop) {
          console.log(
            `[Jira-Poller] throttle: status_changed (${it.event.id}) → ${it.agentId} dropped ` +
            `(conv=${it.convKey}, count=${t.count}/${t.threshold}/h, window-ends=${t.windowEndsAt})`,
          );
          if (t.justWarned) {
            this._enqueueThrottleWarning(it.agentId, it.convKey, t);
          }
          continue;
        }
        this._enqueue(it.agentId, it.triggerId, it.event);
      }
    }

    if (throttleStateDirty) saveThrottleState(THROTTLE_STATE_FILE, this.throttleBuckets);
  }

  // #449-D analogue: one lossless 'jira-digest' entry summarising a burst of
  // status changes for a single (agent, issue). Bulk board transitions
  // ("move the whole sprint to Done") are at least as plausible a burst
  // source as GitHub's mass-relabeling case. Not run through the Layer-3
  // throttle — the digest IS the anti-flood response. Runtime posts it as a
  // plain DM (no LLM call).
  _enqueueDigest(agentId, convKey, items) {
    const events = items.map((it) => ({
      event: 'status_changed',
      eventId: it.event.id,
      issueKey: it.event.issueKey,
      fromStatus: it.event.fromStatus,
      toStatus: it.event.toStatus,
      actor: it.event.author,
      createdAt: it.event.created,
    }));
    const triggerIds = [...new Set(items.map((it) => it.triggerId).filter(Boolean))];
    this._enqueuePending(agentId, {
      kind: 'jira-digest',
      convKey,
      cap: BURST_CAP,
      count: events.length,
      triggerIds,
      events,
    });
    console.log(
      `[Jira-Poller] burst-digest: ${events.length} events → agent=${agentId} (conv=${convKey}, cap=${BURST_CAP})`,
    );
  }

  _enqueue(agentId, triggerId, ev) {
    this._enqueuePending(agentId, {
      triggerId,
      jira: {
        event: 'status_changed',
        eventId: ev.id,
        project: ev.projectKey,
        issueKey: ev.issueKey,
        issueUrl: ev.issueUrl,
        summary: ev.summary,
        fromStatus: ev.fromStatus,
        toStatus: ev.toStatus,
        actor: ev.author,
        createdAt: ev.created,
      },
    });
    console.log(`[Jira-Poller] Queued status_changed (${ev.id}) → agent=${agentId} trigger=${triggerId}`);
  }

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
      console.error(`[Jira-Poller] Cannot write pending for ${agentId}: ${err.message}`);
    }
  }

  _enqueueThrottleWarning(agentId, convKey, decision) {
    this._enqueuePending(agentId, {
      kind: 'throttle-warning',
      convKey,
      count: decision.count,
      threshold: decision.threshold,
      windowEndsAt: decision.windowEndsAt,
    });
  }

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
    } catch (err) {
      console.error(`[Jira-Poller] Cannot load state: ${err.message}`);
    }
    return {};
  }

  _saveState() {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error(`[Jira-Poller] Cannot save state: ${err.message}`);
    }
  }
}

module.exports = {
  JiraPoller,
  resolveJiraApiBase,
  isChangelogTruncated,
  extractStatusChangeEvents,
  resolveProjectCredential,
  matchesStatusFilter,
  subscribesToStatusChanged,
  isValidCredentialId,
  computeQueryWindowMinutes,
  POLL_INTERVAL_MS,
  POLL_WINDOW_MINUTES,
  MAX_CATCHUP_MINUTES,
  MAX_PAGES,
};
