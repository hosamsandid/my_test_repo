'use strict';

// Read-side of the token-usage record store (#654).
//
// The orchestrator (orchestrator/usage-log.js) writes one JSONL line per
// invocation — the canonical usage record — to a day-bucketed file on the
// shared `/workspace` volume. This module is the admin-console-side reader,
// feeding the pure aggregator (usage-summary.js) behind GET /api/usage/summary.
// Mirrors the read half of admin-console/api/github-event-log.js.

const fs = require('fs');
const path = require('path');

// Same shared volume, same directory the orchestrator writes to. Overridable for tests.
const USAGE_LOG_DIR = process.env.USAGE_LOG_DIR || '/workspace/usage';

function listDayFiles() {
  try {
    return fs.readdirSync(USAGE_LOG_DIR)
      .filter((f) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort(); // chronological by name
  } catch {
    return [];
  }
}

// Change-detected read cache (#1684). GET /api/usage/* is polled by the UI, and
// the summary genuinely needs every record in the requested window, so a page
// tail-read doesn't apply. Instead we memoize the parsed records keyed on the
// query and invalidate on any write: the signature is a cheap stat (name + size
// + mtime) of the files that would be read, so repeated polls with no new usage
// cost O(number of day files) statted rather than O(all bytes) re-parsed, while
// a fresh append (new size/mtime) transparently busts the cache — no staleness.
const CACHE_MAX_ENTRIES = 16;
const _recordsCache = new Map(); // key -> { sig, records }

function _signature(files) {
  return files
    .map((f) => {
      try {
        const st = fs.statSync(path.join(USAGE_LOG_DIR, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${f}:?`;
      }
    })
    .join('|');
}

// Read every usage record across day files. Optionally skip whole files that
// end before `since` (a cheap day-granularity prefilter; the summarizer still
// applies the exact half-open [since, until) window per record). Best-effort;
// returns [] on any error, skips corrupt lines.
function readRecords({ since } = {}) {
  const sinceDay = typeof since === 'string' && /^\d{4}-\d{2}-\d{2}/.test(since) ? since.slice(0, 10) : null;
  try {
    const files = listDayFiles().filter((f) => {
      if (!sinceDay) return true;
      const day = f.slice('usage-'.length, f.length - '.jsonl'.length);
      return day >= sinceDay;
    });

    const key = sinceDay || '';
    const sig = _signature(files);
    const cached = _recordsCache.get(key);
    if (cached && cached.sig === sig) return cached.records;

    const records = [];
    for (const f of files) {
      const content = fs.readFileSync(path.join(USAGE_LOG_DIR, f), 'utf8');
      for (const ln of content.split('\n')) {
        if (!ln.trim()) continue;
        try { records.push(JSON.parse(ln)); } catch { /* skip corrupt line */ }
      }
    }
    // Simple bound on the cache: drop the oldest entry when it grows too large.
    if (_recordsCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = _recordsCache.keys().next().value;
      _recordsCache.delete(oldest);
    }
    _recordsCache.set(key, { sig, records });
    return records;
  } catch {
    return [];
  }
}

module.exports = { readRecords, listDayFiles, USAGE_LOG_DIR };
