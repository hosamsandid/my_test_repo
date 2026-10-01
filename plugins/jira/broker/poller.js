'use strict';

// ─── jira broker: the poll loop ─────────────────────────────────────────────
//
// A `setInterval` inside the broker sidecar (the podman-sandbox reaper interval
// is the precedent — docs/jira-plugin-plan.md §3). Nothing about polling lives
// in the orchestrator: `jira-poller.js` from the reverted PR #1539 is gone, and
// `github-poller.js` is untouched.
//
// One tick, per scope with a watch config, per PROJECT (not per watch):
//   1. resolve the scope's credential ({siteUrl, email, apiToken}).
//   2. bucket the watches by `<siteUrl>::<projectKey>` — the per-site scoping
//      from #1539: a Jira project key is only unique per site, so the same key
//      on two sites must never share a cursor. Conversely every watch on ONE
//      project shares one cursor, so the project is polled ONCE and every
//      watch's `statusFilters` is evaluated against the same fresh set (F7:
//      polled per watch, the first row consumed the fresh ids and the second
//      row never fired).
//   3. widen the JQL window to cover any gap since the last poll (capped 24h).
//   4. search, backfill truncated changelogs, extract typed events (each with
//      an explicit `event` kind — event-extract.js).
//   5. dedup against the cursor's seen-id set (first poll only baselines — no
//      fire), drop anything created before the previous poll's horizon (an
//      issue re-entering the `updated` window carries its WHOLE changelog —
//      seen-ids alone cannot tell an old transition from a new one), gate by
//      the watches' opt-in `events` kinds and (status changes) their
//      `statusFilters`, then — per kind, so every wake is single-kind — fold
//      a BULK change (more than PROJECT_BURST_CAP gated events in one poll of
//      one project) into one lossless digest, else collapse per-issue bursts
//      and apply the hour-scoped throttle.
//   6. hand every surviving event to `deliver()` — the transport seam. The
//      broker passes the `POST /internal/plugin-event` wake (server.js); the
//      poller does not know or care what the transport is.
//
// The SDK primitives (`selectFreshEvents`, `planBurstHandoffs`,
// `checkAndIncThrottle`, `computeBackoffDelayMs`) are a copy of the GitHub
// poller's, in broker-sdk/event-cursor.js.

const {
  SEEN_MAX,
  BURST_CAP,
  GRACE_MS,
  computeBackoffDelayMs,
  passesHorizon,
  selectFreshEvents,
  planBurstHandoffs,
  pruneThrottleState,
  loadThrottleState,
  saveThrottleState,
  checkAndIncThrottle,
} = require('../../../broker-sdk');
const {
  EVENT_KINDS, DEFAULT_WATCH_EVENTS, describeEvent,
  resolveJiraApiBase, isChangelogTruncated, isCommentListTruncated,
  extractStatusChangeEvents, extractIssueCreatedEvents, extractFieldChangeEvents, extractCommentEvents,
  matchesStatusFilters, computeQueryWindowMinutes,
} = require('./event-extract');
const { recordPollError, clearPollFailure } = require('./watch-health');
const jira = require('./jira-client');

// How many baseline events to record in the activity log on a project's first
// poll — enough to show "nothing was missed", not the whole JQL window.
const BASELINE_ACTIVITY_CAP = 20;

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BASE_WINDOW_MINUTES = 10;

// F8: the per-(scope, project) cap on ONE poll's fan-out. Every issue is its
// own conversation key, so a sprint-planning bulk move of 40 tickets never
// trips the per-issue burst digest and never counts past 1 on the per-issue
// hour throttle — it became 40 wakes and 40 serial agent runs. When MORE than
// this many gated events land in one poll of one project they are delivered
// as ONE digest (the same lossless shape as the per-issue digest: every event
// in the inbox, `{kind:'digest', events}` in the wake). Same value as the
// per-issue cap so "more than three in one poll" is the one rule to remember.
// Like every digest it is NOT throttled — the digest is the anti-flood
// response, and it is bounded to one per poll per project by construction.
const PROJECT_BURST_CAP = BURST_CAP;

// A watch's opt-in kinds. The store normalises `events` on read; the fallback
// covers a watch object handed in directly (tests, spike.js).
function watchWantsKind(watch, kind) {
  const kinds = Array.isArray(watch.events) && watch.events.length ? watch.events : DEFAULT_WATCH_EVENTS;
  return kinds.includes(kind);
}

function kindNoun(kind) {
  return (EVENT_KINDS[kind] && EVENT_KINDS[kind].noun) || 'events';
}

class JiraPoller {
  // deps:
  //   watchStore, inboxStore                         — the two state stores
  //   activityStore                                  — optional retained event log
  //   ownWritesStore                                 — optional registry of the broker's own
  //                                                    writes, for `origin` (own-writes-store.js)
  //   resolveCredential(scopeId) -> {siteUrl,email,apiToken} | null
  //   deliver({ scopeId, kind, agentIds, convKey, events, cap }) -> Promise
  //       kind: 'events' | 'digest' | 'throttle-warning'
  //   log(msg)                                        — optional
  //   env                                            — JIRA_API_BASE seam passthrough
  constructor({
    watchStore, inboxStore, activityStore, ownWritesStore, resolveCredential, deliver,
    intervalMs, baseWindowMinutes, throttleStatePath, log, env, now = () => Date.now(),
  } = {}) {
    if (!watchStore || !inboxStore) throw new Error('JiraPoller requires watchStore and inboxStore');
    if (typeof resolveCredential !== 'function') throw new Error('JiraPoller requires resolveCredential');
    if (typeof deliver !== 'function') throw new Error('JiraPoller requires deliver');
    this.watchStore = watchStore;
    this.inboxStore = inboxStore;
    this.activityStore = activityStore || null;
    this.ownWritesStore = ownWritesStore || null;
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
    if (this.activityStore) { try { this.activityStore.reap(scopeId); } catch { /* best effort */ } }
    if (this.ownWritesStore) { try { this.ownWritesStore.reap(scopeId); } catch { /* best effort */ } }
    if (!cfg.watches.length) return out;

    const cred = this.resolveCredential(scopeId);
    if (!cred || !cred.siteUrl || !cred.email || !cred.apiToken) {
      out.errors.push('no usable credential for this scope');
      return out;
    }
    const siteBase = resolveJiraApiBase(cred.siteUrl);

    // Group the watches by project so each project is searched once. Order of
    // first appearance is kept, so the summary lines up with the config.
    const byProject = new Map();
    for (const watch of cfg.watches) {
      const projectRef = `${cred.siteUrl}::${watch.projectKey}`;
      if (!byProject.has(projectRef)) byProject.set(projectRef, []);
      byProject.get(projectRef).push(watch);
    }
    for (const [projectRef, watches] of byProject) {
      try {
        out.projects.push(await this._pollProject(scopeId, cred, siteBase, projectRef, watches));
      } catch (err) {
        out.errors.push(`${projectRef}: ${err.message}`);
      }
    }
    return out;
  }

  // `watches`: every watch of this scope that names this project (≥ 1); they
  // share the project's cursor and are evaluated over the same fresh events.
  async _pollProject(scopeId, cred, siteBase, projectRef, watches) {
    const projectKey = watches[0].projectKey;
    const res = { projectRef, watches: watches.length, fired: 0, baseline: false, backoff: null };
    const cursor = this.watchStore.getCursor(scopeId, projectRef) || {};

    if (cursor.skipUntil && Date.parse(cursor.skipUntil) > this.now()) {
      res.backoff = cursor.skipUntil;
      return res;
    }

    const windowMinutes = computeQueryWindowMinutes(cursor.lastPolledAt, this.now(), { baseMinutes: this.baseWindowMinutes });

    let issues;
    try {
      issues = await jira.searchProjectIssues(cred, { projectKey, windowMinutes, env: this.env });
    } catch (err) {
      const failures = (cursor.consecutiveFailures || 0) + 1;
      const skipUntil = new Date(this.now() + computeBackoffDelayMs(failures)).toISOString();
      const withError = recordPollError(cursor, { message: err.message }, this.now());
      this.watchStore.saveCursor(scopeId, projectRef, { ...withError, consecutiveFailures: failures, skipUntil });
      this.log(`[jira-poller] ${projectRef}: ${err.message} (failures=${failures}, next ~${skipUntil})`);
      res.backoff = skipUntil;
      res.error = err.message;
      return res;
    }

    // Flatten every issue's changelog (backfilling any that the search truncated).
    const events = [];
    const windowStartIso = new Date(this.now() - windowMinutes * 60_000).toISOString();
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
      // A busy issue's comment list is cut short in the search response; fetch
      // the ones inside the window (a failure keeps what the search returned).
      let comment = issue.comment;
      if (isCommentListTruncated(comment)) {
        try {
          const comments = await jira.fetchRecentComments(cred, issue.key, { sinceIso: windowStartIso, env: this.env });
          comment = { ...comment, comments };
        } catch (err) {
          this.log(`[jira-poller] ${issue.key}: comment backfill failed (${err.message}) — using what the search returned`);
        }
      }
      // Read the own-writes registry per issue, after its backfills: a write
      // whose change the search already returned but whose broker response
      // landed later in this poll is then still matched (`origin: agent`).
      const ownWrites = this._ownWrites(scopeId);
      events.push(...extractStatusChangeEvents({ ...issue, changelog }, { projectKey, siteBase }));
      events.push(...extractIssueCreatedEvents(issue, { projectKey, siteBase, windowStartIso, ownWrites }));
      events.push(...extractFieldChangeEvents({ ...issue, changelog }, { projectKey, siteBase, ownWrites }));
      events.push(...extractCommentEvents({ ...issue, comment }, { projectKey, siteBase, windowStartIso, ownWrites }));
    }

    // A poll succeeded — clear the active-failure fields (keeping the error ring
    // so the UI can still show a "recovered recently" state), stamp the time.
    const nextCursor = clearPollFailure(cursor, this.now());
    nextCursor.lastPolledAt = new Date(this.now()).toISOString();

    // First poll for this project — baseline, don't fire.
    if (!Array.isArray(cursor.seen)) {
      nextCursor.seen = selectFreshEvents(events, [], SEEN_MAX).nextSeen;
      this.watchStore.saveCursor(scopeId, projectRef, nextCursor);
      res.baseline = true;
      this._recordActivity(
        scopeId,
        events.slice(-BASELINE_ACTIVITY_CAP).map((ev) => ({ event: ev, outcome: 'baseline' })),
      );
      this.log(`[jira-poller] ${projectRef}: baseline (${nextCursor.seen.length} seen)`);
      return res;
    }

    const { fresh: unseen, nextSeen } = selectFreshEvents(events, cursor.seen, SEEN_MAX);
    nextCursor.seen = nextSeen;
    this.watchStore.saveCursor(scopeId, projectRef, nextCursor);

    if (!unseen.length) return res;

    // Horizon gate (the GitHub poller's `passesHorizon`, same grace). The JQL
    // window selects issues by `updated`, so a ticket moved to "Ready for Dev"
    // weeks ago re-enters the window the moment someone comments on it — and
    // its old history id was never in `seen` (or was evicted by SEEN_MAX). An
    // unseen event is therefore fresh only if it was created since the
    // previous successful poll; `lastPolledAt` advances on success alone, so a
    // failed poll widens both the JQL window and this horizon together. Grace
    // absorbs Jira-vs-broker clock skew and late indexing. The stale ids stay
    // in `seen` (above), so an eviction cannot resurrect them later either.
    const horizon = cursor.lastPolledAt || null;
    const fresh = [];
    const staleRows = [];
    for (const ev of unseen) {
      if (passesHorizon(ev.created, horizon, GRACE_MS)) fresh.push(ev);
      else staleRows.push({ event: ev, outcome: 'stale', detail: `created ${ev.created} — before the last poll (${horizon})` });
    }
    this._recordActivity(scopeId, staleRows);
    if (staleRows.length) this.log(`[jira-poller] ${projectRef}: ${staleRows.length} stale transition(s) on re-touched issue(s) — not fired`);
    if (!fresh.length) return res;
    fresh.sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')));

    // Split fresh events by the watches' opt-in kinds (`events`) and, for a
    // status change, their status sets. An event fires at most ONCE however
    // many watches on this project match it (the first matching watch claims
    // it). An event no watch asked for is still recorded (outcome `filtered`)
    // so the Activity view can show "the poller saw it, and did nothing" — the
    // "All activity" toggle in the UI.
    const gated = [];
    const filteredRows = [];
    for (const ev of fresh) {
      const kindWatches = watches.filter((w) => watchWantsKind(w, ev.event));
      if (!kindWatches.length) {
        filteredRows.push({ event: ev, outcome: 'filtered', detail: `${ev.event} is not watched` });
        continue;
      }
      const watch = ev.event === 'status_changed'
        ? kindWatches.find((w) => matchesStatusFilters(ev.toStatus, w.statusFilters))
        : kindWatches[0];
      if (watch) gated.push({ watch, event: ev });
      else filteredRows.push({ event: ev, outcome: 'filtered', detail: `${ev.toStatus || '?'} is not a watched status` });
    }
    this._recordActivity(scopeId, filteredRows);
    if (!gated.length) return res;

    // One fan-out per event kind: a wake carries exactly one top-level `event`,
    // and that is all a trigger's `eventFilter` sees — a digest mixing a comment
    // into four status changes would be delivered as `status_changed` and a
    // comment listener would never wake (implementation plan §1.2). The
    // project burst cap therefore applies per kind per poll.
    const byKind = new Map();
    for (const g of gated) {
      if (!byKind.has(g.event.event)) byKind.set(g.event.event, []);
      byKind.get(g.event.event).push(g);
    }
    for (const part of byKind.values()) {
      const { fired, rows } = await this._fanOut(scopeId, part);
      this._recordActivity(scopeId, rows);
      res.fired += fired;
    }
    return res;
  }

  // The scope's own-writes registry for this poll; empty when there is no
  // store or it cannot be read (every event then reads as `origin: human`).
  _ownWrites(scopeId) {
    if (!this.ownWritesStore) return null;
    try { return this.ownWritesStore.snapshot(scopeId); } catch (err) {
      this.log(`[jira-poller] own-writes read failed for ${scopeId}: ${err.message}`);
      return null;
    }
  }

  // Best-effort append to the retained activity log; a store failure never
  // interferes with delivery.
  _recordActivity(scopeId, rows) {
    if (!this.activityStore || !rows || rows.length === 0) return;
    try { this.activityStore.append(scopeId, rows); } catch (err) {
      this.log(`[jira-poller] activity-store append failed for ${scopeId}: ${err.message}`);
    }
  }

  // `gated`: [{ watch, event }] — each event tagged with the watch that
  // claimed it. `wake.agentIds` is carried through on the deliver payload for
  // shape compatibility; since Phase 2 the targets are the agents' own
  // `plugin-event` triggers, and server.js `deliver()` does not read it.
  async _fanOut(scopeId, gated) {
    const agentIds = gated[0].watch.wake.agentIds; // 'all-granted' | string[]
    const rows = []; // per-event activity rows: { event, outcome, detail? }

    // Bulk transition → one project digest (F8). Decided on the GATED count —
    // transitions no watch asked for were already split off as `filtered`
    // and must not tip watched ones into a digest. Checked BEFORE the
    // per-issue plan so a bulk move never reaches the per-issue throttle.
    if (gated.length > PROJECT_BURST_CAP) {
      const projectKey = gated[0].event.projectKey || gated[0].watch.projectKey;
      const convKey = `project:${projectKey}`;
      const events = gated.map(({ event }) => event);
      for (const event of events) {
        this.inboxStore.append(scopeId, event, { convKey, digest: true });
        rows.push({ event, outcome: 'digested', detail: `${events.length} ${kindNoun(event.event)} in ${projectKey} in one poll` });
      }
      await this.deliver({ scopeId, kind: 'digest', agentIds, convKey, projectKey, events, cap: PROJECT_BURST_CAP });
      this.log(`[jira-poller] bulk-digest: ${events.length} events in ${projectKey} → ${scopeId} (one wake)`);
      return { fired: 1, rows };
    }

    const deliverables = gated.map(({ event: ev }) => ({ agentId: '_', convKey: `issue:${ev.issueKey}`, event: ev }));
    const plans = planBurstHandoffs(deliverables, BURST_CAP);
    let fired = 0;
    let throttleDirty = false;

    for (const plan of plans) {
      if (plan.mode === 'digest') {
        for (const it of plan.items) {
          this.inboxStore.append(scopeId, it.event, { convKey: plan.convKey, digest: true });
          rows.push({ event: it.event, outcome: 'digested' });
        }
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
          rows.push({ event: it.event, outcome: 'throttled', detail: `${t.count}/${t.threshold} per hour` });
          if (t.justWarned) {
            await this.deliver({ scopeId, kind: 'throttle-warning', agentIds, convKey: plan.convKey, events: [], count: t.count, threshold: t.threshold, windowEndsAt: t.windowEndsAt });
          }
          continue;
        }
        this.inboxStore.append(scopeId, it.event, { convKey: plan.convKey });
        await this.deliver({ scopeId, kind: 'events', agentIds, convKey: plan.convKey, events: [it.event] });
        this.log(`[jira-poller] queued ${it.event.event} (${it.event.id}) ${describeEvent(it.event)} → ${scopeId}`);
        rows.push({ event: it.event, outcome: 'delivered' });
        fired += 1;
      }
    }

    if (throttleDirty) {
      // Evict closed-window buckets so the map does not grow one entry per
      // issue for the life of the process (it is also pruned on persist/load).
      this.throttleBuckets = pruneThrottleState(this.throttleBuckets);
      if (this.throttleStatePath) saveThrottleState(this.throttleStatePath, this.throttleBuckets);
    }
    return { fired, rows };
  }
}

module.exports = { JiraPoller, DEFAULT_INTERVAL_MS, DEFAULT_BASE_WINDOW_MINUTES, PROJECT_BURST_CAP };
