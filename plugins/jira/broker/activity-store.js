'use strict';

// ─── jira broker: per-scope activity log ────────────────────────────────────
//
// "What did the poller see, and what did it do with it." The inbox (inbox-
// store.js) is a CONSUMABLE queue — a woken agent drains it and it is gone — so
// it cannot answer "which tickets moved recently". This is the retained record:
// every FRESH event in a watched project (survived seen-id dedup), with an
// outcome tag saying what the plugin did:
//
//   delivered  — a wake was fired for the granted agents
//   digested   — folded into a burst digest (still a wake, lossless)
//   throttled  — dropped by the hour-scoped conversation throttle
//   filtered   — fresh, but no watch opted into its kind, or (a status change)
//                its target status matched no `statusFilters` entry
//   stale      — unseen, but created before the previous poll: an old transition
//                on an issue that merely re-entered the `updated` window
//   baseline   — seen on the very first poll for this project (never fires)
//
// This is the `JiraEventLog.jsx` that #1539 deferred (docs/jira-plugin-plan.md
// §6.4), served on the `/` route's Activity tab.
//
// One log per scope on `AEE_PLUGIN_STATE_DIR`. Bounded two ways, BOTH local to
// this store — deliberately NOT the manifest `quota` (which counts inbox
// "objects", operator-visible work waiting for an agent; an activity row is a
// diagnostic, not an object):
//   • TTL   — 14 days (the retention the design commits to).
//   • count — ACTIVITY_MAX per scope; appending past it drops the OLDEST row.
//
// Atomic writes (temp file + rename). Same shape/discipline as inbox-store.js.

const fs = require('fs');
const path = require('path');
const { EVENT_KINDS } = require('./event-extract');

const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RETENTION_MS = 14 * 24 * 3600 * 1000;
const ACTIVITY_MAX = 2000;
const OUTCOMES = new Set(['delivered', 'digested', 'throttled', 'filtered', 'stale', 'baseline']);

function assertScope(scopeId) {
  if (typeof scopeId !== 'string' || !SCOPE_RE.test(scopeId)) {
    throw new Error(`invalid scopeId: ${String(scopeId)}`);
  }
  return scopeId;
}

// Narrow an event to what a row needs (no `payload`, no bulk): the common
// fields plus the kind's own (event-extract.js `EVENT_KINDS[kind].rowFields`).
// A row written before kinds existed has no `event` and reads as a status
// change in the UI.
function shapeEventForRow(ev) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const row = {
    id: e.id || null,
    event: e.event || null,
    issueKey: e.issueKey || null,
    projectKey: e.projectKey || null,
    issueType: e.issueType || null,
    summary: e.summary || null,
    author: e.author || null,
    created: e.created || null,
    issueUrl: e.issueUrl || null,
  };
  const kind = EVENT_KINDS[e.event];
  for (const f of (kind ? kind.rowFields : ['fromStatus', 'toStatus'])) row[f] = e[f] == null ? null : e[f];
  return row;
}

class ActivityStore {
  constructor({ stateDir, retentionMs, maxRows, now = () => Date.now() } = {}) {
    if (!stateDir) throw new Error('ActivityStore requires a stateDir (AEE_PLUGIN_STATE_DIR)');
    this.dir = path.join(stateDir, 'activity');
    this.retentionMs = Number.isInteger(retentionMs) && retentionMs > 0 ? retentionMs : RETENTION_MS;
    this.max = Number.isInteger(maxRows) && maxRows > 0 ? maxRows : ACTIVITY_MAX;
    this.now = now;
  }

  _path(scopeId) {
    return path.join(this.dir, `${assertScope(scopeId)}.json`);
  }

  _read(scopeId) {
    assertScope(scopeId);
    let raw;
    try {
      raw = fs.readFileSync(this._path(scopeId), 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        process.stderr.write(`[jira-broker] activity-store: read ${this._path(scopeId)} failed (${err.message})\n`);
      }
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.rows) ? parsed.rows : []);
      return rows;
    } catch (err) {
      process.stderr.write(
        `[jira-broker] activity-store: ${this._path(scopeId)} is not valid JSON (${err.message}) — dropping its contents\n`,
      );
      return [];
    }
  }

  _write(scopeId, rows) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this._path(scopeId);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ rows }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }

  _fresh(rows) {
    const cutoff = this.now() - this.retentionMs;
    return rows.filter((r) => r && (Date.parse(r.at) || 0) >= cutoff);
  }

  // Append one or more rows. Each `{ event, outcome, detail? }`. Reaps TTL-
  // expired rows first, then trims the oldest past the cap. Unknown outcomes are
  // stored as-is (forward-compatible) but callers should use OUTCOMES.
  append(scopeId, rowOrRows) {
    assertScope(scopeId);
    const incoming = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    if (incoming.length === 0) return this.count(scopeId);
    let rows = this._fresh(this._read(scopeId));
    const at = new Date(this.now()).toISOString();
    for (const r of incoming) {
      if (!r || typeof r !== 'object') continue;
      rows.push({
        at,
        outcome: typeof r.outcome === 'string' ? r.outcome : 'delivered',
        ...(r.detail ? { detail: String(r.detail).slice(0, 300) } : {}),
        event: shapeEventForRow(r.event),
      });
    }
    if (rows.length > this.max) rows = rows.slice(rows.length - this.max);
    this._write(scopeId, rows);
    return rows.length;
  }

  // Rows, newest-first, TTL-filtered (not written back). `limit` caps the count.
  list(scopeId, { limit } = {}) {
    const rows = this._fresh(this._read(scopeId)).slice().reverse();
    const n = Number.isInteger(limit) && limit > 0 ? limit : rows.length;
    return rows.slice(0, n);
  }

  count(scopeId) {
    return this._fresh(this._read(scopeId)).length;
  }

  // Sweep TTL across one scope (called from the poll tick), rewriting only if
  // something was actually reaped.
  reap(scopeId) {
    assertScope(scopeId);
    const all = this._read(scopeId);
    const fresh = this._fresh(all);
    if (fresh.length !== all.length) this._write(scopeId, fresh);
    return all.length - fresh.length;
  }

  teardown(scopeId) {
    assertScope(scopeId);
    try {
      fs.unlinkSync(this._path(scopeId));
      return 1;
    } catch (err) {
      if (err && err.code === 'ENOENT') return 0;
      throw err;
    }
  }
}

module.exports = { ActivityStore, SCOPE_RE, assertScope, shapeEventForRow, OUTCOMES, RETENTION_MS, ACTIVITY_MAX };
