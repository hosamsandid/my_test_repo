'use strict';

// Token-usage record store (#654, §6 phase 1 of docs/cost-per-pr-concept.md).
//
// Agents POST one usage record per invocation to the orchestrator's internal
// ingest endpoint (POST /internal/agents/:id/usage); this module is the
// single writer that appends each record as a JSONL line to a day-bucketed
// file on the shared `/workspace` volume. admin-console/api/usage-log.js is
// the read-side counterpart.
//
// Mirrors the day-bucketed JSONL pattern of orchestrator/github-event-log.js
// (#469) — one file per calendar day, best-effort append, single-writer on
// the orchestrator side, many readers on the admin-console side. Unlike the
// event-transparency log there is deliberately NO automatic retention: token
// telemetry is billing-adjacent and must not silently disappear. Pruning, if
// ever wanted, is an explicit operator action (out of scope for phase 1).

const fs = require('fs');
const path = require('path');

const USAGE_LOG_DIR = process.env.USAGE_LOG_DIR || '/workspace/usage';

// Bucket by the record's own `ts` (UTC ISO string the agent stamped at
// result time), NOT wall-clock-now — so a record that was spooled during an
// orchestrator outage and drained later lands in the day it actually
// happened, keeping day-grouped summaries honest. Falls back to today only
// when the record carries no usable timestamp.
function dayOf(entry) {
  const ts = entry && typeof entry.ts === 'string' ? entry.ts : '';
  if (/^\d{4}-\d{2}-\d{2}/.test(ts)) return ts.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

// Append one usage record as a JSONL line to its day file. Never throws —
// ingest must not fail because the disk write hiccuped.
function record(entry) {
  try {
    fs.mkdirSync(USAGE_LOG_DIR, { recursive: true });
    const day = dayOf(entry);
    fs.appendFileSync(path.join(USAGE_LOG_DIR, `usage-${day}.jsonl`), JSON.stringify(entry) + '\n');
    return true;
  } catch {
    return false;
  }
}

// ── Read half (#679) ───────────────────────────────────────────────────────
// The orchestrator is the store OWNER (single writer above), and it is also the
// only process able to read the store on behalf of an agent, because an agent
// container is volume-isolated from /workspace/usage/. The internal read
// endpoint (GET /internal/agents/:id/usage/summary) uses these to feed the pure
// aggregation (usage-summary.js) + scoping (usage-query.js). Read-only: nothing
// here writes or deletes. Mirrors the read half of admin-console/api/usage-log.js.

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

module.exports = { USAGE_LOG_DIR, dayOf, record, listDayFiles, readRecords };
