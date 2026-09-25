'use strict';

// ─── jira broker: search response → typed events (pure) ─────────────────────
//
// Jira Cloud has no discrete immutable events feed. Instead, per tracked
// project we run a narrow JQL search (`updated >= -Nm`) with `expand=changelog`
// and flatten each returned issue's changelog histories into one candidate
// event per `field === "status"` change, keyed `<issueKey>:<historyId>` — the
// composite id that plays GitHub `event.id`'s exact role in the SDK's seen-id
// dedup (`selectFreshEvents`).
//
// Lifted almost verbatim from the reverted PR #1539's `jira-poller.js` — the
// design work there was sound; only its *shape* (platform code, not a plugin)
// was the mistake (docs/jira-plugin-plan.md §1, §6.2). These functions are the
// good part. Pure — no I/O, unit-tested in isolation.
//
// Every event carries an explicit `event` kind (docs/jira-plugin-events-
// implementation.md §2.1). `EVENT_KINDS` is the one list of kinds the broker
// can produce — the watch store's opt-in set, the admin checkboxes, the
// activity row shape and the manifest's `events[]` all agree with it.

// The kinds this broker extracts, in display order. Per kind: the admin
// checkbox label, the digest noun, and the kind-specific top-level fields an
// activity row keeps (activity-store.js `shapeEventForRow`).
const EVENT_KINDS = {
  status_changed: { label: 'Status changes', noun: 'status changes', rowFields: ['fromStatus', 'toStatus'] },
  issue_created: { label: 'New issues', noun: 'new issues', rowFields: ['status', 'reporter', 'priority', 'origin'] },
};
const KNOWN_EVENTS = Object.keys(EVENT_KINDS);
const DEFAULT_WATCH_EVENTS = ['status_changed'];

// A wake's event id is the `aee-jira inbox --consume <id>` argument, so every
// extractor's ids must match this — exactly ONE colon (`<issueKey>:<rest>`).
// server.js gates `consume` on it; the extractor tests assert it per kind.
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:[A-Za-z0-9._-]{1,64}$/;

// The one-line human summary of an event (poller log, wake summary). Unknown
// kinds fall back to the issue key.
function describeEvent(ev) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const key = e.issueKey || e.projectKey || '';
  if (e.event === 'status_changed' && (e.fromStatus || e.toStatus)) {
    return `${key}: ${e.fromStatus || 'new'} → ${e.toStatus || '?'}`;
  }
  if (e.event === 'issue_created') return `${key} created${e.summary ? `: ${e.summary}` : ''}`;
  return key || String(e.event || 'event');
}

// A bare Atlassian subdomain ("acme") → "https://acme.atlassian.net"; a full
// origin ("https://acme.atlassian.net", a custom domain, or an http test
// fixture host) is used as-is. The trailing-slash strip is a manual character
// loop on purpose — the `/\/+$/` regex form was a CodeQL ReDoS finding.
function resolveJiraApiBase(siteUrl) {
  let s = String(siteUrl || '').trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}.atlassian.net`;
}

// Atlassian truncates a search response's changelog for issues with heavy
// change history — exactly the "bulk sprint transition" case this plugin most
// needs to catch reliably — detectable via `changelog.total > histories.length`
// and backfilled with the paginated per-issue changelog endpoint.
function isChangelogTruncated(changelog) {
  return !!changelog
    && typeof changelog.total === 'number'
    && Array.isArray(changelog.histories)
    && changelog.total > changelog.histories.length;
}

// The issue summary and issue-type name, tolerating either the raw Jira issue
// (`fields.summary` / `fields.issuetype.name`) or the narrowed `shapeIssue`
// form (`summary` / `issueType`) the poller passes in. Before this the poller
// path — which passes the shaped issue — always produced `summary: null`,
// because only the raw `fields.summary` branch existed.
function issueSummaryOf(issue) {
  if (issue.summary != null) return issue.summary || null;
  return (issue.fields && issue.fields.summary) || null;
}
function issueTypeNameOf(issue) {
  if (issue.issueType != null) return issue.issueType || null;
  return (issue.fields && issue.fields.issuetype && issue.fields.issuetype.name) || null;
}

// Flatten an issue's (possibly backfilled) changelog into one candidate
// `status_changed` event per status-field change. `siteBase` builds the browse URL; pass null to omit
// it. Never throws on a malformed issue — returns [].
function extractStatusChangeEvents(issue, { projectKey, siteBase } = {}) {
  const events = [];
  if (!issue || !issue.key) return events;
  const summary = issueSummaryOf(issue);
  const issueType = issueTypeNameOf(issue);
  const histories = (issue.changelog && Array.isArray(issue.changelog.histories))
    ? issue.changelog.histories
    : [];
  for (const h of histories) {
    if (!h || h.id == null || !Array.isArray(h.items)) continue;
    for (const item of h.items) {
      if (!item || item.field !== 'status') continue;
      events.push({
        id: `${issue.key}:${h.id}`,
        event: 'status_changed',
        issueKey: issue.key,
        projectKey: projectKey || null,
        issueType,
        created: h.created || null,
        author: (h.author && h.author.displayName) || null,
        fromStatus: item.fromString || null,
        toStatus: item.toString || null,
        summary,
        issueUrl: siteBase ? `${siteBase}/browse/${issue.key}` : null,
      });
    }
  }
  return events;
}

// `origin` of an issue the broker may have created itself (`aee-jira
// create-epic`): `agent` when the own-writes registry holds its key, else
// `human`. Registry only — the "Created by an agent" marker lives in the
// description, which the poll does not fetch.
function resolveIssueOrigin(issueKey, ownWrites) {
  return ownWrites && ownWrites.issues && ownWrites.issues[issueKey] ? 'agent' : 'human';
}

// One `issue_created` event for an issue created inside this poll's JQL
// window. The window selects by `updated`, so an old issue touched today is
// in it too — `created` must be at or after `windowStartIso`. An issue with
// no parseable `created` yields nothing: without it a new issue cannot be told
// from an old one, and guessing would announce every touched issue as new.
// The seen-id cursor (`<key>:created`) and the horizon gate do the rest.
function extractIssueCreatedEvents(issue, { projectKey, siteBase, windowStartIso, ownWrites } = {}) {
  if (!issue || !issue.key) return [];
  const created = Date.parse(issue.created);
  if (Number.isNaN(created)) return [];
  const windowStart = Date.parse(windowStartIso);
  if (!Number.isNaN(windowStart) && created < windowStart) return [];
  return [{
    id: `${issue.key}:created`,
    event: 'issue_created',
    issueKey: issue.key,
    projectKey: projectKey || null,
    issueType: issueTypeNameOf(issue),
    summary: issueSummaryOf(issue),
    created: issue.created,
    author: issue.reporter || null,
    reporter: issue.reporter || null,
    status: issue.status || null,
    priority: issue.priority || null,
    origin: resolveIssueOrigin(issue.key, ownWrites),
    issueUrl: siteBase ? `${siteBase}/browse/${issue.key}` : null,
  }];
}

// The exact-match gate on the status an issue transitioned INTO, mirroring the
// GitHub poller's `labelFilter`. Empty / null / undefined = no filter (fires on
// any status change).
function matchesStatusFilter(toStatus, statusFilter) {
  if (!statusFilter) return true;
  return toStatus === statusFilter;
}

// The multi-status gate: a watch holds a SET of target statuses and fires on a
// transition into ANY of them. An empty / absent set = no filter (fires on any
// status change) — the same "blank means everything" rule as the singular form,
// so a watch that clears all its chips keeps watching rather than going silent.
function matchesStatusFilters(toStatus, statusFilters) {
  const list = Array.isArray(statusFilters) ? statusFilters.filter((s) => typeof s === 'string' && s) : [];
  if (list.length === 0) return true;
  return list.includes(toStatus);
}

const DEFAULT_BASE_MINUTES = 10;
const MAX_WINDOW_MINUTES = 24 * 60; // catch-up is capped at 24h — never a full backlog

// The `updated >= -Nm` window for the next poll. Normally `baseMinutes` (a
// generous overlap: freshness is decided purely by seen-id membership, so
// re-fetching an overlapping range is harmless). After a gap — an orchestrator
// restart, a broker crash, a paused sidecar — widen it to cover the outage so
// transitions in the gap are not silently dropped, capped at 24h so a
// long-dead sidecar coming back does not fetch an unbounded history.
function computeQueryWindowMinutes(lastPolledAtIso, nowMs, { baseMinutes = DEFAULT_BASE_MINUTES } = {}) {
  const base = Number.isFinite(baseMinutes) && baseMinutes > 0 ? Math.ceil(baseMinutes) : DEFAULT_BASE_MINUTES;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const last = Date.parse(lastPolledAtIso);
  if (Number.isNaN(last) || last >= now) return Math.min(base, MAX_WINDOW_MINUTES);
  const gapMinutes = Math.ceil((now - last) / 60_000);
  // + base as overlap on top of the gap itself.
  return Math.min(Math.max(base, gapMinutes + base), MAX_WINDOW_MINUTES);
}

module.exports = {
  EVENT_KINDS,
  KNOWN_EVENTS,
  DEFAULT_WATCH_EVENTS,
  EVENT_ID_RE,
  describeEvent,
  resolveJiraApiBase,
  isChangelogTruncated,
  extractStatusChangeEvents,
  extractIssueCreatedEvents,
  resolveIssueOrigin,
  matchesStatusFilter,
  matchesStatusFilters,
  computeQueryWindowMinutes,
  DEFAULT_BASE_MINUTES,
  MAX_WINDOW_MINUTES,
};
