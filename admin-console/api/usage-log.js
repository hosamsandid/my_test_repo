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

// Read every usage record across day files. Optionally skip whole files that
// end before `since` (a cheap day-granularity prefilter; the summarizer still
// applies the exact half-open [since, until) window per record). Best-effort;
// returns [] on any error, skips corrupt lines.
function readRecords({ since } = {}) {
  const sinceDay = typeof since === 'string' && /^\d{4}-\d{2}-\d{2}/.test(since) ? since.slice(0, 10) : null;
  try {
    const records = [];
    for (const f of listDayFiles()) {
      const day = f.slice('usage-'.length, f.length - '.jsonl'.length);
      if (sinceDay && day < sinceDay) continue;
      const content = fs.readFileSync(path.join(USAGE_LOG_DIR, f), 'utf8');
      for (const ln of content.split('\n')) {
        if (!ln.trim()) continue;
        try { records.push(JSON.parse(ln)); } catch { /* skip corrupt line */ }
      }
    }
    return records;
  } catch {
    return [];
  }
}

module.exports = { readRecords, listDayFiles, USAGE_LOG_DIR };
