'use strict';

// Read-side of the PR-link record store (#655).
//
// The orchestrator (orchestrator/pr-events-log.js) writes one JSONL line per
// outbound git action (pr-created / branch-pushed) to a day-bucketed file on the
// shared `/workspace` volume. This module is the admin-console-side reader,
// feeding the pure work-item attribution module (work-items.js) behind
// GET /api/usage/work-items. Mirrors admin-console/api/usage-log.js exactly.

const fs = require('fs');
const path = require('path');

// Same shared volume and directory the orchestrator writes to. Overridable for tests.
const PR_EVENTS_LOG_DIR = process.env.PR_EVENTS_LOG_DIR || process.env.USAGE_LOG_DIR || '/workspace/usage';

function listDayFiles() {
  try {
    return fs.readdirSync(PR_EVENTS_LOG_DIR)
      .filter((f) => /^pr-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort(); // chronological by name
  } catch {
    return [];
  }
}

// Read every PR-link record across day files. Unlike usage records the
// attribution graph must see PR↔issue edges that may predate the query window
// (a PR opened last week can still own runs this week), so there is deliberately
// no `since` prefilter here — the record set is tiny (one line per PR/push).
// Best-effort; returns [] on any error, skips corrupt lines.
function readRecords() {
  try {
    const records = [];
    for (const f of listDayFiles()) {
      const content = fs.readFileSync(path.join(PR_EVENTS_LOG_DIR, f), 'utf8');
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

module.exports = { readRecords, listDayFiles, PR_EVENTS_LOG_DIR };
