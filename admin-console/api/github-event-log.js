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

module.exports = { queryEntries, filterEntries, listDayFiles, EVENT_LOG_DIR };
