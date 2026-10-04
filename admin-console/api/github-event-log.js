'use strict';

// Read-side of the GitHub poller event-transparency log (#469).
//
// The poller (orchestrator/github-event-log.js) writes one JSONL line per
// fresh event — delivered, dropped-with-reason, part of a burst digest, or
// matching no subscriber at all — to a day-bucketed file on the shared
// `/workspace` volume. This module is the admin-console-side reader,
// exposed via GET /api/github-events (see api.js). Mirrors the read half of
// admin-console/api/audit.js, extended with a time-range query instead of a
// flat "most recent N".

const fs = require('fs');
const path = require('path');
const { readLastLinesAcross } = require('./tail-read');

// Same shared volume, same directory the poller writes to. Overridable for tests.
const EVENT_LOG_DIR = process.env.GITHUB_EVENT_LOG_DIR || '/workspace/github-event-log';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

function listDayFiles() {
  try {
    return fs.readdirSync(EVENT_LOG_DIR)
      .filter(f => /^github-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort(); // chronological by name
  } catch {
    return [];
  }
}

// Pure: filter already-parsed entries to [sinceMs, untilMs], newest first,
// capped at `limit`. Exported for unit testing without touching the filesystem.
function filterEntries(entries, { sinceMs, untilMs, limit } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
  return entries
    .filter((e) => {
      const t = Date.parse(e?.ts);
      if (!Number.isFinite(t)) return true; // never silently drop malformed rows
      if (Number.isFinite(sinceMs) && t < sinceMs) return false;
      if (Number.isFinite(untilMs) && t > untilMs) return false;
      return true;
    })
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, cap);
}

// Read entries for a time range (default: no lower/upper bound, caller
// usually passes `since`). Best-effort; returns [] on any error.
function queryEntries({ since, until, limit } = {}) {
  const sinceMs = since ? Date.parse(since) : NaN;
  const untilMs = until ? Date.parse(until) : NaN;
  try {
    // Fast path (#1684): no time window → the caller just wants the newest
    // `cap` entries. The UI usually omits `since`, so parsing every day file is
    // wasteful — read only the tail of the most recent files instead, bounding
    // cost by the requested page size rather than total history.
    if (!Number.isFinite(sinceMs) && !Number.isFinite(untilMs)) {
      const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
      const files = listDayFiles().map(f => path.join(EVENT_LOG_DIR, f));
      const entries = [];
      for (const ln of readLastLinesAcross(files, cap)) {
        try { entries.push(JSON.parse(ln)); } catch { /* skip corrupt line */ }
      }
      return filterEntries(entries, { limit });
    }
    const entries = [];
    for (const f of listDayFiles()) {
      // Cheap prefilter: skip whole files that end before `since`.
      const day = f.slice('github-events-'.length, f.length - '.jsonl'.length);
      if (Number.isFinite(sinceMs)) {
        const dayEndMs = Date.parse(`${day}T23:59:59.999Z`);
        if (Number.isFinite(dayEndMs) && dayEndMs < sinceMs) continue;
      }
      const content = fs.readFileSync(path.join(EVENT_LOG_DIR, f), 'utf8');
      for (const ln of content.split('\n')) {
        if (!ln.trim()) continue;
        try { entries.push(JSON.parse(ln)); } catch { /* skip corrupt line */ }
      }
    }
    return filterEntries(entries, { sinceMs, untilMs, limit });
  } catch {
    return [];
  }
}

// ── Agent-scoped view (#2525) ──────────────────────────────────────────────
//
// The Agent Chat "Events" tab lists what reached ONE agent's subscriptions.
// The filter runs here, server-side, over the whole window (AC11): the global
// log's newest-N cap would otherwise let a busy repo push this agent's rows out
// of the page before any client-side filter saw them.

const REFIRE_SOURCE = 'manual-refire';

// Default window when the caller names none: the poller's 7-day retention.
const AGENT_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function workItemNumber(e) {
  return e && e.workItem && e.workItem.number != null ? e.workItem.number : null;
}

// Pure: one row per (entry, outcome) addressed to `agentId`, newest first —
// several triggers on one agent listening to the same event stay separate rows
// (#2525 edge case). A drop row that was later fired again carries `refired`
// ({eventId, by, at}); an `internal-dedup` drop carries `twin`, the earlier
// delivery of the same item + wake label the marker deduplicated against, so
// the dialog can link its session.
function projectAgentRows(entries, agentId) {
  const list = Array.isArray(entries) ? entries : [];
  const refires = new Map(); // `${eventId}\u0000${triggerId}` → re-fire entry
  for (const e of list) {
    if (!e || e.source !== REFIRE_SOURCE || !e.refireOf) continue;
    for (const o of e.outcomes || []) {
      if (o && o.agentId === agentId) refires.set(`${e.refireOf.eventId}\u0000${o.triggerId}`, e);
    }
  }
  const rows = [];
  for (const e of list) {
    if (!e) continue;
    (e.outcomes || []).forEach((o, idx) => {
      if (!o || o.agentId !== agentId) return;
      const ref = refires.get(`${e.eventId}\u0000${o.triggerId}`);
      const wakeLabel = typeof o.wakeLabel === 'string' ? o.wakeLabel : null;
      rows.push({
        key: `${e.eventId}:${o.triggerId || ''}:${idx}`,
        ts: e.ts || null,
        eventId: e.eventId != null ? String(e.eventId) : null,
        repo: e.repo || null,
        event: e.event || null,
        label: e.label || null,
        ref: e.ref || null,
        actor: e.actor || null,
        workItem: e.workItem || null,
        source: e.source || null,
        triggerId: o.triggerId || null,
        status: o.status || null,
        reason: o.reason || null,
        digest: !!o.digest,
        wakeLabel,
        // #2571: who pushed, on a producer-filter drop (null = unknown).
        ...(o.reason === 'producer-filter' ? { producer: typeof o.producer === 'string' ? o.producer : null } : {}),
        // #2822: the label a comment-label drop wanted on the commented item.
        ...(o.reason === 'comment-label' && typeof o.requireLabel === 'string' ? { requireLabel: o.requireLabel } : {}),
        // #2795: the readiness gates a held / failed / timed-out hand-off was
        // about, and why a hold was cancelled.
        ...(Array.isArray(o.gates) ? { gates: o.gates.filter(g => typeof g === 'string') } : {}),
        ...(o.reason === 'gate-cancelled' && typeof o.cancelReason === 'string' ? { cancelReason: o.cancelReason } : {}),
        refiredBy: e.refiredBy || null,
        refireOf: e.refireOf || null,
        refired: ref ? { eventId: String(ref.eventId), by: ref.refiredBy || null, at: ref.ts || null } : null,
        twin: o.status === 'dropped' && o.reason === 'internal-dedup'
          ? findTwin(list, e, agentId, o.triggerId, wakeLabel || e.label || null)
          : null,
      });
    });
  }
  return rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
}

// The newest delivered row of the same (agent, trigger, repo, item, label) at
// or before the drop. Mirrors orchestrator/github-refire.js findTwinDelivery.
function findTwin(list, drop, agentId, triggerId, wakeLabel) {
  const num = workItemNumber(drop);
  if (num == null) return null;
  const dropTs = String(drop.ts || '');
  let best = null;
  for (const e of list) {
    if (!e || e === drop || e.repo !== drop.repo || workItemNumber(e) !== num) continue;
    if (dropTs && String(e.ts || '') > dropTs) continue;
    const o = (e.outcomes || []).find((x) => x && x.agentId === agentId && x.triggerId === triggerId && x.status === 'delivered');
    if (!o) continue;
    const label = typeof o.wakeLabel === 'string' ? o.wakeLabel : e.label;
    if (wakeLabel && label !== wakeLabel) continue;
    if (!best || String(e.ts || '') > String(best.ts || '')) best = e;
  }
  return best ? { eventId: String(best.eventId), triggerId, ts: best.ts || null } : null;
}

// Agent-scoped read (#2525 AC11). Always a full scan of the window (never the
// newest-N fast path), filtered to the agent BEFORE the cap is applied.
function queryAgentEntries({ agentId, since, until, limit, now = Date.now() } = {}) {
  if (!agentId) return [];
  let sinceMs = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(sinceMs)) sinceMs = now - AGENT_DEFAULT_WINDOW_MS;
  const untilMs = until ? Date.parse(until) : NaN;
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
  try {
    const entries = [];
    for (const f of listDayFiles()) {
      const day = f.slice('github-events-'.length, f.length - '.jsonl'.length);
      const dayEndMs = Date.parse(`${day}T23:59:59.999Z`);
      if (Number.isFinite(dayEndMs) && dayEndMs < sinceMs) continue;
      const content = fs.readFileSync(path.join(EVENT_LOG_DIR, f), 'utf8');
      for (const ln of content.split('\n')) {
        if (!ln.trim()) continue;
        try { entries.push(JSON.parse(ln)); } catch { /* skip corrupt line */ }
      }
    }
    // Re-fire rows are matched against the WHOLE window read, so a drop just
    // inside `since` still shows as re-fired when its re-fire is too.
    return projectAgentRows(entries, agentId)
      .filter((r) => {
        const t = Date.parse(r.ts);
        if (!Number.isFinite(t)) return true;
        if (t < sinceMs) return false;
        if (Number.isFinite(untilMs) && t > untilMs) return false;
        return true;
      })
      .slice(0, cap);
  } catch {
    return [];
  }
}

// #2596: a delivered outcome of a pooled role carries the per-ticket instance
// it ran on (`instanceId`). Pure: add what the Event Log needs to name and link
// it — the instance's display name ("Developer · #2562"), whether it still
// exists (a reaped instance's config is gone), and the pooled role's own name
// for the "open the role's chat instead" fallback. `readConfig(agentId)` returns
// the agent's config or null. An outcome without an instanceId (every
// non-pooled row, and every row recorded before #2596) is returned unchanged.
function projectPoolInstance(outcome, readConfig) {
  if (!outcome || typeof outcome.instanceId !== 'string' || !outcome.instanceId) return outcome;
  const instanceId = outcome.instanceId;
  const instanceCfg = readConfig(instanceId);
  const roleCfg = outcome.agentId ? readConfig(outcome.agentId) : null;
  const poolRoleName = (roleCfg && roleCfg.displayName) || outcome.agentId || null;
  // The instance id is `<role>-i<item>` (agent-pool.js poolInstanceId), so a
  // reaped instance can still be named after its ticket.
  const prefix = `${outcome.agentId}-i`;
  const item = outcome.agentId && instanceId.startsWith(prefix) ? instanceId.slice(prefix.length) : null;
  const derivedName = item && roleCfg && roleCfg.displayName ? `${roleCfg.displayName} · #${item}` : null;
  return {
    ...outcome,
    instanceName: (instanceCfg && instanceCfg.displayName) || derivedName || instanceId,
    instanceExists: !!instanceCfg,
    instanceItem: item,
    poolRoleName,
  };
}

module.exports = {
  queryEntries, filterEntries, listDayFiles, EVENT_LOG_DIR, projectPoolInstance,
  projectAgentRows, queryAgentEntries, AGENT_DEFAULT_WINDOW_MS,
};
