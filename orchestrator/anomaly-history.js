'use strict';

// Hill-climbing loop Phase 1 (#1221): scheduled flow-anomaly-sweep persistence.
//
// The live `GET /internal/teams/:teamId/flow-anomalies` endpoint computes and
// discards. Recurrence detection (the hill-climber) and the flow-reconciliation
// Phase-4 responder's "third sighting" ladder both need HISTORY — so an hourly
// orchestrator timer re-runs the same sweep per Agent Team and appends the result
// here. This is a SEPARATE, purely observational substrate: it never influences
// the on-demand endpoint, whose behaviour stays byte-identical.
//
// Mirrors the day-bucketed JSONL pattern of `github-event-log.js` (a pure core —
// entry shaping + retention math — plus best-effort I/O that never throws into the
// caller's timer), with one difference: the anomaly history is ONE append-only
// file per team (`/workspace/teams/<teamId>/hill-climb/anomaly-history.jsonl`), so
// retention prunes old LINES, not whole files.
//
// Safety contract: logging is strictly best-effort. A failure here must never
// take down the hourly sweep timer — every file operation is wrapped.

const fs = require('fs');
const path = require('path');
const { safeTeamSegment } = require('./knowledge-feed');

const TEAMS_DIR = process.env.HILL_CLIMB_TEAMS_DIR || '/workspace/teams';
const HISTORY_FILE = 'anomaly-history.jsonl';
const RETENTION_DAYS = Number(process.env.HILL_CLIMB_ANOMALY_RETENTION_DAYS) || 90;

// The per-team history file path, or null for an unsafe team id (same traversal
// guard the KB clone + team-skill dirs use). Callers treat null as "skip".
function historyPath(teamId) {
  const seg = safeTeamSegment(teamId);
  if (!seg) return null;
  return path.join(TEAMS_DIR, seg, 'hill-climb', HISTORY_FILE);
}

// Shape one sweep result into a compact history line. `anomalies` is kept as the
// detector's ranked list — its `class`/`objectId` identity is exactly what
// recurrence detection keys on across sweeps; `errors` records a partial or failed
// sweep (best-effort discipline). `count` is a convenience summary so a reader can
// chart volume without parsing the array.
function buildHistoryEntry(result = {}, now = Date.now()) {
  const anomalies = Array.isArray(result.anomalies) ? result.anomalies : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  return {
    ts: new Date(now).toISOString(),
    count: anomalies.length,
    anomalies,
    errors,
  };
}

// Pure: given the raw JSONL lines currently in the file and "now", return only
// the lines whose parsed `ts` is within the retention window. Blank lines are
// dropped; a line that doesn't parse or lacks a datable `ts` is KEPT (never
// silently discard data we can't date). Exported so retention can be unit-tested
// without touching the filesystem.
function retainRecentLines(lines, now = Date.now(), retentionDays = RETENTION_DAYS) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return (Array.isArray(lines) ? lines : []).filter((line) => {
    const t = typeof line === 'string' ? line.trim() : '';
    if (!t) return false; // drop blank lines
    let ts = null;
    try { ts = JSON.parse(t).ts; } catch { return true; } // unparseable → keep
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) return true; // undatable → keep
    return ms >= cutoff;
  });
}

// Append one entry as a JSONL line to the team's history file. Never throws — a
// failed sweep-log must not take down the hourly timer.
function record(teamId, entry) {
  try {
    const p = historyPath(teamId);
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  } catch {
    // Swallow: this substrate must never break the sweep.
  }
}

// Read the most recent entries back, oldest→newest. Best-effort in the same
// sense as `record`: a missing file (nothing swept yet) or an unreadable one
// yields `[]`, never a throw — the ticket ledger's recurrence column (#2115) is
// an enrichment, and it must never be able to fail the sweep that carries it.
// Malformed lines are skipped rather than aborting the read.
function readEntries(teamId, { limit = 200 } = {}) {
  try {
    const p = historyPath(teamId);
    if (!p || !fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const tail = limit > 0 ? lines.slice(-limit) : lines;
    const out = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Prune lines older than the retention window from the team's history file.
// Best-effort; a missing file (nothing swept yet) is not an error. Rewrites only
// when something actually changed, to avoid needless churn.
function pruneOldEntries(teamId, now = Date.now(), retentionDays = RETENTION_DAYS) {
  try {
    const p = historyPath(teamId);
    if (!p || !fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    const nonBlank = lines.filter((l) => l.trim() !== '');
    const kept = retainRecentLines(lines, now, retentionDays);
    if (kept.length === nonBlank.length) return; // nothing expired
    fs.writeFileSync(p, kept.length ? kept.join('\n') + '\n' : '');
  } catch {
    // Best-effort — a read/write failure just leaves the file as-is.
  }
}

module.exports = {
  TEAMS_DIR,
  HISTORY_FILE,
  RETENTION_DAYS,
  historyPath,
  buildHistoryEntry,
  retainRecentLines,
  record,
  readEntries,
  pruneOldEntries,
};
