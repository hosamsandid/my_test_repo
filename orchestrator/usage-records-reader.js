'use strict';

// Orchestrator-side reader for the token-usage + PR-link record stores (#678).
//
// The orchestrator already WRITES both stores (usage-log.js, pr-events-log.js);
// the admin-console has the canonical READ half (admin-console/api/usage-log.js
// + pr-events-log.js) behind the /api/usage/* routes. The PR-token-comment
// feature needs the same read at MERGE time, inside the orchestrator process,
// where it cannot require the admin-console files (separate container images).
//
// This is a thin, best-effort reader over the same day-bucketed JSONL files the
// orchestrator writes — it deliberately reuses the writers' *_LOG_DIR constants
// so reader and writer can never point at different directories. The heavy
// lifting (attribution, work-item assembly) is the verbatim work-items.js mirror.

const fs = require('fs');
const path = require('path');

const { USAGE_LOG_DIR } = require('./usage-log');
const { PR_EVENTS_LOG_DIR } = require('./pr-events-log');

// Read every JSONL record from files in `dir` whose name matches `re`. Best-effort:
// returns [] on any error, silently skips corrupt lines. Files are read in name
// order (chronological, given the yyyy-mm-dd day bucket).
function readJsonlDir(dir, re) {
  try {
    const files = fs.readdirSync(dir).filter((f) => re.test(f)).sort();
    const out = [];
    for (const f of files) {
      let content;
      try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      for (const ln of content.split('\n')) {
        if (!ln.trim()) continue;
        try { out.push(JSON.parse(ln)); } catch { /* skip corrupt line */ }
      }
    }
    return out;
  } catch {
    return [];
  }
}

// All usage records across day files. No `since` prefilter — the caller passes a
// window to workItemDetail, and the record set for one merged PR's window is small.
function readUsageRecords() {
  return readJsonlDir(USAGE_LOG_DIR, /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/);
}

// All PR-link records across day files. Like the admin-console reader, there is
// deliberately no window prefilter: the attribution graph must see PR↔issue edges
// that predate the merge window (a PR opened last week still owns this week's runs).
function readPrEvents() {
  return readJsonlDir(PR_EVENTS_LOG_DIR, /^pr-events-\d{4}-\d{2}-\d{2}\.jsonl$/);
}

module.exports = { readUsageRecords, readPrEvents, readJsonlDir, USAGE_LOG_DIR, PR_EVENTS_LOG_DIR };
