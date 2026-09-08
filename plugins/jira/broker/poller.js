'use strict';

// ─── jira broker: the poll loop ─────────────────────────────────────────────
//
// A `setInterval` inside the broker sidecar (the podman-sandbox reaper interval
// is the precedent — docs/jira-plugin-plan.md §3). Nothing about polling lives
// in the orchestrator: `jira-poller.js` from the reverted PR #1539 is gone, and
// `github-poller.js` is untouched.
//
// One tick, per scope with a watch config, per watch:
//   1. resolve the scope's credential ({siteUrl, email, apiToken}).
//   2. bucket by `<siteUrl>::<projectKey>` — the per-site scoping from #1539: a
//      Jira project key is only unique per site, so the same key on two sites
//      must never share a cursor.
//   3. widen the JQL window to cover any gap since the last poll (capped 24h).
//   4. search, backfill truncated changelogs, flatten to status-change events.
//   5. gate by the watch's `statusFilter`, dedup against the cursor's seen-id
//      set (first poll only baselines — no fire), collapse per-issue bursts,
//      apply the hour-scoped throttle.
//   6. hand every surviving event to `deliver()` — the transport seam. Phase 0
//      passes a doorbell+inbox deliver; Phase 2 swaps in `POST /internal/
//      plugin-event`. The poller does not know or care which.
//
// The SDK primitives (`selectFreshEvents`, `planBurstHandoffs`,
// `checkAndIncThrottle`, `computeBackoffDelayMs`) are a copy of the GitHub
// poller's, in broker-sdk/event-cursor.js.

const {
  SEEN_MAX,
  BURST_CAP,
  computeBackoffDelayMs,
  selectFreshEvents,
  planBurstHandoffs,
  loadThrottleState,
  saveThrottleState,
  checkAndIncThrottle,
} = require('../../../broker-sdk');
const { resolveJiraApiBase, isChangelogTruncated, extractStatusChangeEvents, matchesStatusFilter, computeQueryWindowMinutes } = require('./event-extract');
const jira = require('./jira-client');

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BASE_WINDOW_MINUTES = 10;

class JiraPoller {
  // deps:
  //   watchStore, inboxStore                         — the two state stores
  //   resolveCredential(scopeId) -> {siteUrl,email,apiToken} | null
  //   deliver({ scopeId, kind, agentIds, convKey, events, cap }) -> Promise
  //       kind: 'events' | 'digest' | 'throttle-warning'
  //   log(msg)                                        — optional
  //   env                                            — JIRA_API_BASE seam passthrough
  constructor({
    watchStore, inboxStore, resolveCredential, deliver,
    intervalMs, baseWindowMinutes, throttleStatePath, log, env, now = () => Date.now(),
  } = {}) {
    if (!watchStore || !inboxStore) throw new Error('JiraPoller requires watchStore and inboxStore');
    if (typeof resolveCredential !== 'function') throw new Error('JiraPoller requires resolveCredential');
    if (typeof deliver !== 'function') throw new Error('JiraPoller requires deliver');
    this.watchStore = watchStore;
    this.inboxStore = inboxStore;
    this.resolveCredential = resolveCredential;
    this.deliver = deliver;
    this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
    this.baseWindowMinutes = Number.isFinite(baseWindowMinutes) && baseWindowMinutes > 0 ? baseWindowMinutes : DEFAULT_BASE_WINDOW_MINUTES;
    this.throttleStatePath = throttleStatePath || null;
    this.log = typeof log === 'function' ? log : () => {};
    this.env = env || process.env;
    this.now = now;
    this.throttleBuckets = throttleStatePath ? loadThrottleState(throttleStatePath) : {};
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.log(`[jira-poller] starting (interval=${Math.round(this.intervalMs / 1000)}s)`);
    this._tick().catch((err) => this.log(`[jira-poller] first tick error: ${err.message}`));
    this.timer = setInterval(() => {
      this._tick().catch((err) => this.log(`[jira-poller] tick error: ${err.message}`));
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // One full sweep. Returns a per-scope summary (for tests / a status endpoint).
  async _tick() {
    if (this.running) return { skipped: 'in-progress' };
    this.running = true;
    const summary = { scopes: [] };
    try {
      for (const scopeId of this.watchStore.listScopes()) {
        summary.scopes.push(await this.pollScope(scopeId));
      }
    } finally {
      this.running = false;
    }
    return summary;
  }

  async pollScope(scopeId) {
    const out = { scopeId, projects: [], errors: [] };
    let cfg;
    try {
      cfg = this.watchStore.loadConfig(scopeId);
    } catch (err) {
      out.errors.push(err.message);
      return out;
    }
    this.inboxStore.reap(scopeId);
    if (!cfg.watches.length) return out;

    const cred = this.resolveCredential(scopeId);
    if (!cred || !cred.siteUrl || !cred.email || !cred.apiToken) {
      out.errors.push('no usable credential for this scope');
      return out;
    }
    const siteBase = resolveJiraApiBase(cred.siteUrl);

    for (const watch of cfg.watches) {
      const projectRef = `${cred.siteUrl}::${watch.projectKey}`;
      try {
        out.projects.push(await this._pollProject(scopeId, cred, siteBase, projectRef, watch));
      } catch (err) {
        out.errors.push(`${projectRef}: ${err.message}`);
      }
    }
    return out;
  }

  async _pollProject(scopeId, cred, siteBase, projectRef, watch) {
    const res = { projectRef, fired: 0, baseline: false, backoff: null };
    const cursor = this.watchStore.getCursor(scopeId, projectRef) || {};

    if (cursor.skipUntil && Date.parse(cursor.skipUntil) > this.now()) {
      res.backoff = cursor.skipUntil;
      return res;
    }

    const windowMinutes = computeQueryWindowMinutes(cursor.lastPolledAt, this.now(), { baseMinutes: this.baseWindowMinutes });

    let issues;
    try {
      issues = await jira.searchProjectIssues(cred, { projectKey: watch.projectKey, windowMinutes, env: this.env });
    } catch (err) {
      const failures = (cursor.consecutiveFailures || 0) + 1;
      const skipUntil = new Date(this.now() + computeBackoffDelayMs(failures)).toISOString();
      this.watchStore.saveCursor(scopeId, projectRef, { ...cursor, consecutiveFailures: failures, skipUntil });
      this.log(`[jira-poller] ${projectRef}: ${err.message} (failures=${failures}, next ~${skipUntil})`);
      res.backoff = skipUntil;
      return res;
    }

    // Flatten every issue's changelog (backfilling any that the search truncated).
    const events = [];
    for (const issue of issues) {
      let changelog = issue.changelog;
      // Backfill when the search truncated the changelog OR did not inline it at
      // all — the enhanced /search/jql endpoint's `expand=changelog` behaviour is
      // less generous than the old /search, and an issue in the JQL window with
      // no inline histories would otherwise silently produce zero events.
      const noInlineHistories = !changelog || !Array.isArray(changelog.histories) || changelog.histories.length === 0;
      if (isChangelogTruncated(changelog) || noInlineHistories) {
        try {
          const histories = await jira.fetchFullChangelog(cred, issue.key, { env: this.env });
          changelog = { ...(changelog || {}), histories };
        } catch (err) {
          this.log(`[jira-poller] ${issue.key}: changelog backfill failed (${err.message}) — using what the search returned`);
        }
      }
      events.push(...extractStatusChangeEvents({ ...issue, changelog }, { projectKey: watch.projectKey, siteBase }));
    }

    const nextCursor = { lastPolledAt: new Date(this.now()).toISOString() };

    // First poll for this project — baseline, don't fire.
    if (!Array.isArray(cursor.seen)) {
      nextCursor.seen = selectFreshEvents(events, [], SEEN_MAX).nextSeen;
      this.watchStore.saveCursor(scopeId, projectRef, nextCursor);
      res.baseline = true;
      this.log(`[jira-poller] ${projectRef}: baseline (${nextCursor.seen.length} seen)`);
      return res;
    }

    const { fresh, nextSeen } = selectFreshEvents(events, cursor.seen, SEEN_MAX);
    nextCursor.seen = nextSeen;
    this.watchStore.saveCursor(scopeId, projectRef, nextCursor);

    if (!fresh.length) return res;
    fresh.sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')));
    const gated = fresh.filter((ev) => matchesStatusFilter(ev.toStatus, watch.statusFilter));
    if (!gated.length) return res;

    res.fired = await this._fanOut(scopeId, watch, gated);
    return res;
  }

  async _fanOut(scopeId, watch, events) {
    const agentIds = watch.wake.agentIds; // 'all-granted' | string[]
    const deliverables = events.map((ev) => ({ agentId: '_', convKey: `issue:${ev.issueKey}`, event: ev }));
    const plans = planBurstHandoffs(deliverables, BURST_CAP);
    let fired = 0;
    let throttleDirty = false;

    for (const plan of plans) {
      if (plan.mode === 'digest') {
        for (const it of plan.items) this.inboxStore.append(scopeId, it.event, { convKey: plan.convKey, digest: true });
        await this.deliver({ scopeId, kind: 'digest', agentIds, convKey: plan.convKey, events: plan.items.map((i) => i.event), cap: BURST_CAP });
        this.log(`[jira-poller] burst-digest: ${plan.items.length} events → ${scopeId} (${plan.convKey})`);
        fired += 1;
        continue;
      }
      for (const it of plan.items) {
        const key = `${scopeId}:${plan.convKey}`;
        const t = checkAndIncThrottle(this.throttleBuckets, key);
        throttleDirty = true;
        if (t.drop) {
          this.log(`[jira-poller] throttle: ${it.event.id} → ${scopeId} dropped (${t.count}/${t.threshold}/h)`);
          if (t.justWarned) {
            await this.deliver({ scopeId, kind: 'throttle-warning', agentIds, convKey: plan.convKey, events: [], count: t.count, threshold: t.threshold, windowEndsAt: t.windowEndsAt });
          }
          continue;
        }
        this.inboxStore.append(scopeId, it.event, { convKey: plan.convKey });
        await this.deliver({ scopeId, kind: 'events', agentIds, convKey: plan.convKey, events: [it.event] });
        this.log(`[jira-poller] queued status_changed (${it.event.id}) ${it.event.fromStatus} → ${it.event.toStatus} → ${scopeId}`);
        fired += 1;
      }
    }

    if (throttleDirty && this.throttleStatePath) saveThrottleState(this.throttleStatePath, this.throttleBuckets);
    return fired;
  }
}

module.exports = { JiraPoller, DEFAULT_INTERVAL_MS, DEFAULT_BASE_WINDOW_MINUTES };
